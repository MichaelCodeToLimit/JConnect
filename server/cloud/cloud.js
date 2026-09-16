#!/usr/bin/env node
// JConnect Cloud: optional, self-hostable.
//
//  - Accounts. The password never reaches the server: the app derives an auth key and a separate vault
//    key from it with scrypt, and only the auth key is sent (stored here as another scrypt hash).
//    Changing the password or deleting the account needs the current password again, not just a session.
//  - Sync. Computers, SSH hosts and network settings live in a vault encrypted on the device with the
//    vault key (XSalsa20-Poly1305). The server stores ciphertext and a version number.
//  - Devices. Each device registers its public signing key, proven with a signature.
//  - JVPN relay. Only devices on the same account can register, see each other or dial, and dialing
//    uses one-minute tickets instead of long-lived tokens in URLs.
//  - Two-step sign-in with authenticator codes (TOTP).
//  - ICE servers (STUN, and TURN when configured) for remote desktop media across the internet.
//  - Data lives in an SQLite database (store.js), or in Postgres such as Supabase (store-postgres.js) when
//    DATABASE_URL is set. Accounts from the older JSON file are imported into SQLite.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { attachRelay, deviceIdFromKey, verifyText } = require('../relay/relay');
const { openStore } = require('./store');
const { openPostgresStore } = require('./store-postgres');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TICKET_TTL_MS = 60 * 1000;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_VAULT = 2 * 1024 * 1024;
const KDF = { N: 32768, r: 8, p: 1 };
const RATE_WINDOW_MAX_MS = 60 * 60 * 1000;

const b64 = (buf) => Buffer.from(buf).toString('base64');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const now = () => Date.now();
const scryptAsync = promisify(crypto.scrypt);

function log(...args) {
  if (process.env.JCONNECT_CLOUD_QUIET) return;
  console.log(new Date().toISOString(), '[cloud]', ...args);
}

// ---- TOTP (RFC 6238) ----

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(text).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function totpCode(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function totpValid(secret, code, at = now()) {
  const counter = Math.floor(at / 30000);
  const given = String(code || '').replace(/\D/g, '');
  if (given.length !== 6) return false;
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(totpCode(secret, counter + d)), Buffer.from(given)));
}

// ---- storage ----

// Postgres when a database address is given and no SQLite file was chosen, otherwise SQLite. database is the
// path to the SQLite database, or null to keep everything in memory (tests); dataFile is its older name.
// Accounts in an old cloud.json beside the SQLite database are imported once.
function openDatabase({ database, dataFile, databaseUrl }) {
  const chosen = database !== undefined ? database : dataFile;
  if (chosen === undefined && databaseUrl) {
    log('keeping data in the Postgres database from DATABASE_URL');
    return openPostgresStore(databaseUrl);
  }
  const file = chosen === undefined ? process.env.JCONNECT_CLOUD_DB || path.join(__dirname, 'data', 'cloud.db') : chosen;
  const legacyJson = !file ? null : /\.json$/i.test(file) ? file : path.join(path.dirname(file), 'cloud.json');
  const db = openStore(file && file === legacyJson ? file.replace(/\.json$/i, '.db') : file);
  const imported = db.importJson(legacyJson);
  if (imported) log(`imported ${imported} account(s) from ${path.basename(legacyJson)}`);
  return db;
}

// ---- server ----

// store: an already opened store (tests). databaseUrl: a Postgres database, such as Supabase.
function createCloud({ port = Number(process.env.PORT || 47900), host, database, dataFile, databaseUrl = process.env.DATABASE_URL, store, tls, turn, stun } = {}) {
  const db = store || openDatabase({ database, dataFile, databaseUrl });
  const tickets = new Map(); // ticket -> { userId, to, expires }
  const attempts = new Map(); // key -> [timestamps]
  const turnUsers = new Map();
  const stunServers = stun || (process.env.STUN_URLS ? process.env.STUN_URLS.split(',') : ['stun:stun.l.google.com:19302']);

  let turnServer = null;
  if (turn || process.env.TURN_PUBLIC_HOST) {
    try {
      const Turn = require('node-turn');
      const turnPort = (turn && turn.port) || Number(process.env.TURN_PORT || 3478);
      turnServer = new Turn({ authMech: 'long-term', listeningPort: turnPort, realm: 'jconnect', debugLevel: 'OFF' });
      turnServer.start();
      turnServer.publicHost = (turn && turn.publicHost) || process.env.TURN_PUBLIC_HOST;
      turnServer.publicPort = turnPort;
      log('TURN listening on', turnPort);
    } catch (err) {
      log('TURN unavailable:', err.message);
    }
  }

  // windowMs must not be longer than RATE_WINDOW_MAX_MS, after which the sweeper forgets a key.
  const limited = (key, max, windowMs) => {
    const list = (attempts.get(key) || []).filter((t) => now() - t < windowMs);
    list.push(now());
    // Only the newest max + 1 attempts matter, so a flood of requests can't grow the list.
    if (list.length > max + 1) list.splice(0, list.length - max - 1);
    attempts.set(key, list);
    return list.length > max;
  };

  async function sessionFor(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    const key = b64(sha256(token));
    const session = await db.session(key);
    if (!session || session.expiresAt < now()) {
      if (session) await db.deleteSession(key);
      return null;
    }
    const user = await db.userById(session.userId);
    return user ? { key, session, user } : null;
  }

  async function newSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = now();
    await db.createSession(b64(sha256(token)), user.id, createdAt, createdAt + SESSION_TTL_MS);
    return { token, userId: user.id, email: user.email, expiresAt: createdAt + SESSION_TTL_MS };
  }

  // scrypt runs off the event loop, so sign-ins don't hold up every other request.
  const hashAuthKey = (authKey, salt) => scryptAsync(authKey, salt, 32, { N: 16384, r: 8, p: 1 });

  const bytesOf = (value, length) => {
    try {
      const buf = Buffer.from(String(value), 'base64');
      return buf.length === length ? buf : null;
    } catch {
      return null;
    }
  };

  const newVerifier = async (authKey) => {
    const serverSalt = crypto.randomBytes(16);
    return `${b64(serverSalt)}:${b64(await hashAuthKey(authKey, serverSalt))}`;
  };

  // Without an account this still hashes, so response times don't show which addresses have accounts.
  async function authKeyMatches(user, authKey) {
    const keyBytes = bytesOf(authKey, 32);
    const [serverSalt, stored] = user ? user.auth.split(':') : [b64(crypto.randomBytes(16)), b64(crypto.randomBytes(32))];
    const computed = await hashAuthKey(keyBytes || Buffer.alloc(32), Buffer.from(serverSalt, 'base64'));
    return !!(user && keyBytes && crypto.timingSafeEqual(computed, Buffer.from(stored, 'base64')));
  }

  // The error to send when two-step sign-in is on and the code is missing or wrong, otherwise null.
  const totpProblem = (user, code) => {
    if (!user.totp || !user.totp.enabled) return null;
    if (!code) return 'totp-required';
    return totpValid(user.totp.secret, code) ? null : 'totp';
  };

  const relay = attachRelay(null, {
    authorizeHost: async ({ id, publicKey, token }) => {
      const auth = await sessionFor(token);
      if (!auth) return null;
      const device = await db.device(auth.user.id, id);
      return device && device.publicKey === publicKey ? { account: auth.user.id } : null;
    },
    authorizeConnect: async ({ to, hostAccount, url }) => {
      const ticket = tickets.get(url.searchParams.get('ticket'));
      if (!ticket || ticket.expires < now() || ticket.to !== to || ticket.userId !== hostAccount) return false;
      tickets.delete(url.searchParams.get('ticket'));
      return true;
    },
    presenceFor: async ({ ids, req }) => {
      const auth = await sessionFor(bearer(req));
      if (!auth) return null;
      const mine = new Set((await db.devices(auth.user.id)).map((d) => d.id));
      return ids.filter((id) => mine.has(id));
    },
  });

  // Closes an account's relay connections and forgets its dial tickets.
  function dropAccount(userId, code, reason) {
    for (const entry of relay.hosts.values()) if (entry.account === userId) entry.ws.close(code, reason);
    for (const [ticket, t] of tickets) if (t.userId === userId) tickets.delete(ticket);
  }

  function bearer(req) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('too-large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!chunks.length) { resolve({}); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('bad-json'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  const validEmail = (email) => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const versionOf = (value) => (Number.isInteger(Number(value)) ? Number(value) : -1);

  async function api(req, res, url) {
    const send = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'strict-transport-security': 'max-age=31536000',
      });
      res.end(JSON.stringify(body));
    };
    const ip = req.socket.remoteAddress || '?';
    const route = `${req.method} ${url.pathname.replace(/\/[0-9a-f]{20}$/, '/:id')}`;

    try {
      if (route === 'GET /v1/health') return send(200, { app: 'jconnect-cloud', ok: true, turn: !!turnServer });

      if (route === 'POST /v1/prelogin') {
        const { email } = await readBody(req);
        if (!validEmail(email)) return send(400, { error: 'email' });
        const user = await db.userByEmail(email.toLowerCase());
        // Unknown addresses get a stable fake salt so this can't be used to discover accounts.
        const salt = user ? user.salt : b64(crypto.createHmac('sha256', await db.secret()).update(email.toLowerCase()).digest().subarray(0, 16));
        return send(200, { salt, kdf: KDF });
      }

      if (route === 'POST /v1/signup') {
        if (limited(`signup:${ip}`, 10, 60 * 60 * 1000)) return send(429, { error: 'slow-down' });
        const { email, salt, authKey } = await readBody(req);
        if (!validEmail(email)) return send(400, { error: 'email' });
        const saltBytes = bytesOf(salt, 16);
        const keyBytes = bytesOf(authKey, 32);
        if (!saltBytes || !keyBytes) return send(400, { error: 'bad-request' });
        const lower = email.toLowerCase();
        if (await db.userByEmail(lower)) return send(409, { error: 'exists' });
        const user = { id: crypto.randomUUID(), email: lower, salt: b64(saltBytes), auth: await newVerifier(keyBytes), createdAt: now() };
        if (!(await db.createUser(user))) return send(409, { error: 'exists' });
        log('account created');
        return send(200, await newSession(user));
      }

      if (route === 'POST /v1/login') {
        const { email, authKey, totp } = await readBody(req);
        if (!validEmail(email)) return send(400, { error: 'email' });
        const lower = email.toLowerCase();
        if (limited(`login:${lower}`, 10, 15 * 60 * 1000) || limited(`login-ip:${ip}`, 50, 15 * 60 * 1000)) return send(429, { error: 'slow-down' });
        const user = await db.userByEmail(lower);
        if (!(await authKeyMatches(user, authKey))) return send(401, { error: 'credentials' });
        const totpError = totpProblem(user, totp);
        if (totpError) return send(401, { error: totpError });
        return send(200, await newSession(user));
      }

      const auth = await sessionFor(bearer(req));
      if (!auth) return send(401, { error: 'unauthorized' });
      const { user } = auth;

      if (route === 'POST /v1/logout') {
        await db.deleteSession(auth.key);
        return send(200, { ok: true });
      }

      if (route === 'GET /v1/me') {
        return send(200, {
          email: user.email,
          totp: !!(user.totp && user.totp.enabled),
          devices: (await db.devices(user.id)).map((d) => ({ id: d.id, name: d.name, os: d.os, lastSeen: d.lastSeen })),
        });
      }

      if (route === 'GET /v1/vault') return send(200, { version: user.vault.version, blob: user.vault.blob });

      if (route === 'PUT /v1/vault') {
        const { baseVersion, blob } = await readBody(req);
        if (typeof blob !== 'string' || blob.length > MAX_VAULT) return send(400, { error: 'bad-request' });
        const result = await db.putVault(user.id, versionOf(baseVersion), blob, now());
        if (!result.ok) return send(409, { version: result.version, blob: result.blob });
        return send(200, { version: result.version });
      }

      // Changing the password or deleting the account takes the current password (and an authenticator code when
      // two-step sign-in is on), so a stolen session can't do either. Failures are 403: the app reads 401 as a
      // session that has ended.
      if (route === 'POST /v1/password' || route === 'DELETE /v1/account') {
        if (limited(`reauth:${user.id}`, 10, 15 * 60 * 1000)) return send(429, { error: 'slow-down' });
        const body = await readBody(req);
        if (!(await authKeyMatches(user, body.authKey))) return send(403, { error: 'credentials' });
        const totpError = totpProblem(user, body.totp);
        if (totpError) return send(403, { error: totpError });

        if (route === 'DELETE /v1/account') {
          await db.deleteUser(user.id);
          dropAccount(user.id, 4003, 'removed');
          log('account deleted');
          return send(200, { ok: true });
        }

        // The vault comes re-encrypted with the key from the new password, written only if it's still the latest.
        const saltBytes = bytesOf(body.salt, 16);
        const keyBytes = bytesOf(body.newAuthKey, 32);
        if (!saltBytes || !keyBytes || typeof body.blob !== 'string' || body.blob.length > MAX_VAULT) return send(400, { error: 'bad-request' });
        const result = await db.changePassword(user.id, { salt: b64(saltBytes), auth: await newVerifier(keyBytes), baseVersion: versionOf(body.baseVersion), blob: body.blob, at: now() });
        if (!result.ok) return send(409, { error: 'vault-changed', version: result.version, blob: result.blob });
        // Every session was signed out. This device gets a new one, and its relay connection reconnects with it.
        dropAccount(user.id, 4001, 'password-changed');
        log('password changed');
        return send(200, await newSession(user));
      }

      if (route === 'POST /v1/devices') {
        const { id, publicKey, name, os, ts, sig } = await readBody(req);
        if (typeof publicKey !== 'string' || deviceIdFromKey(publicKey) !== id || Math.abs(now() - Number(ts)) > 5 * 60 * 1000
          || !verifyText(`jconnect-cloud-device:${id}:${user.id}:${ts}`, sig, publicKey)) {
          return send(400, { error: 'bad-device' });
        }
        if (!(await db.device(user.id, id)) && (await db.deviceCount(user.id)) >= 50) return send(429, { error: 'too-many-devices' });
        await db.saveDevice(user.id, { id, publicKey, name: String(name || '').slice(0, 64), os: String(os || '').slice(0, 32), lastSeen: now() });
        return send(200, { ok: true });
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/v1/devices/')) {
        const id = url.pathname.split('/').pop();
        await db.removeDevice(user.id, id);
        const hostEntry = relay.hosts.get(id);
        if (hostEntry && hostEntry.account === user.id) hostEntry.ws.close(4003, 'removed');
        return send(200, { ok: true });
      }

      if (route === 'POST /v1/relay/ticket') {
        const { to } = await readBody(req);
        if (!(await db.device(user.id, to))) return send(404, { error: 'unknown-device' });
        if (limited(`ticket:${user.id}`, 120, 60 * 1000)) return send(429, { error: 'slow-down' });
        const ticket = crypto.randomBytes(24).toString('base64url');
        tickets.set(ticket, { userId: user.id, to, expires: now() + TICKET_TTL_MS });
        return send(200, { ticket, expiresAt: now() + TICKET_TTL_MS });
      }

      if (route === 'GET /v1/ice') {
        const iceServers = stunServers.length ? [{ urls: stunServers }] : [];
        // Every TURN credential stays valid for 12 hours, so how many one account can get is limited.
        if (turnServer && turnServer.publicHost && !limited(`ice:${user.id}`, 60, 60 * 60 * 1000)) {
          const username = `${user.id.slice(0, 8)}-${crypto.randomBytes(6).toString('hex')}`;
          const credential = crypto.randomBytes(18).toString('base64url');
          turnServer.addUser(username, credential);
          turnUsers.set(username, setTimeout(() => { turnServer.removeUser(username); turnUsers.delete(username); }, 12 * 60 * 60 * 1000));
          const hostPort = `${turnServer.publicHost}:${turnServer.publicPort}`;
          iceServers.push({ urls: [`turn:${hostPort}?transport=udp`, `turn:${hostPort}?transport=tcp`], username, credential });
        }
        return send(200, { iceServers });
      }

      if (route === 'POST /v1/totp/setup') {
        // A new secret would replace the one in use and switch two-step sign-in off, so turning it off comes first.
        if (user.totp && user.totp.enabled) return send(409, { error: 'totp-enabled' });
        const secret = base32Encode(crypto.randomBytes(20));
        await db.setTotp(user.id, { secret, enabled: false }, now());
        const label = encodeURIComponent(`JConnect:${user.email}`);
        return send(200, { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=JConnect&digits=6&period=30` });
      }

      if (route === 'POST /v1/totp/enable' || route === 'POST /v1/totp/disable') {
        if (limited(`totp:${user.id}`, 10, 15 * 60 * 1000)) return send(429, { error: 'slow-down' });
        const { code } = await readBody(req);
        const enable = route.endsWith('enable');
        // Turning it on needs a secret from setup, and turning it off only applies while it's on.
        if (!user.totp || user.totp.enabled === enable || !totpValid(user.totp.secret, code)) return send(400, { error: 'totp' });
        await db.setTotp(user.id, enable ? { secret: user.totp.secret, enabled: true } : null, now());
        return send(200, { ok: true, totp: enable });
      }

      return send(404, { error: 'not-found' });
    } catch (err) {
      if (!err.status) log(`${route} failed:`, err.message);
      return send(err.status || 500, { error: err.status ? err.message : 'server' });
    }
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://cloud');
    if (url.pathname.startsWith('/v1/')) return api(req, res, url);
    if (await relay.handleRequest(req, res, url)) return undefined;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not-found' }));
    return undefined;
  };

  const tlsOptions = tls || (process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }
    : null);
  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  server.on('upgrade', (req, socket, head) => {
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });

  let lastPurge = 0;
  const sweeper = setInterval(() => {
    for (const [ticket, t] of tickets) if (t.expires < now()) tickets.delete(ticket);
    // Rate-limit entries older than the longest window are forgotten, so the map can't grow without end.
    for (const [key, list] of attempts) if (!list.length || now() - list[list.length - 1] > RATE_WINDOW_MAX_MS) attempts.delete(key);
    if (now() - lastPurge > 60 * 60 * 1000) {
      lastPurge = now();
      Promise.resolve().then(() => db.purgeExpiredSessions(lastPurge)).catch((err) => log('expired sessions not purged:', err.message));
    }
  }, 30000);

  return {
    server,
    db,
    // Checks the database before taking requests.
    async listen() {
      await db.ready();
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close() {
      clearInterval(sweeper);
      relay.close();
      for (const timer of turnUsers.values()) clearTimeout(timer);
      if (turnServer) turnServer.stop();
      return new Promise((resolve) => server.close(async () => {
        await db.close();
        resolve();
      }));
    },
  };
}

module.exports = { createCloud, totpCode, base32Encode };

if (require.main === module) {
  createCloud().listen().then((p) => log(`JConnect Cloud listening on port ${p}`), (err) => {
    console.error(new Date().toISOString(), '[cloud] could not start:', err.message);
    process.exit(1);
  });
}
