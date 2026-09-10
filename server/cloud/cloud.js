#!/usr/bin/env node
// JConnect Cloud: optional, self-hostable.
//
//  - Accounts. The password never reaches the server: the app derives an auth key and a separate vault
//    key from it with scrypt, and only the auth key is sent (stored here as another scrypt hash).
//  - Sync. Computers, SSH hosts and network settings live in a vault encrypted on the device with the
//    vault key (XSalsa20-Poly1305). The server stores ciphertext and a version number.
//  - Devices. Each device registers its public signing key, proven with a signature.
//  - JVPN relay. Only devices on the same account can register, see each other or dial, and dialing
//    uses one-minute tickets instead of long-lived tokens in URLs.
//  - Two-step sign-in with authenticator codes (TOTP).
//  - ICE servers (STUN, and TURN when configured) for remote desktop media across the internet.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { attachRelay, deviceIdFromKey, verifyText } = require('../relay/relay');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TICKET_TTL_MS = 60 * 1000;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_VAULT = 2 * 1024 * 1024;
const KDF = { N: 32768, r: 8, p: 1 };

const b64 = (buf) => Buffer.from(buf).toString('base64');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const now = () => Date.now();

function log(...args) {
  if (process.env.JCONNECT_CLOUD_QUIET) return;
  console.log(new Date().toISOString(), '[cloud]', ...args);
}

// ---- tiny JSON file database ----

class Db {
  constructor(file) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = { secret: b64(crypto.randomBytes(32)), users: {}, emails: {}, sessions: {} };
    }
    this.data.users = this.data.users || {};
    this.data.emails = this.data.emails || {};
    this.data.sessions = this.data.sessions || {};
    this.saveNow();
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 100);
  }

  saveNow() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
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

// ---- server ----

function createCloud({ port = Number(process.env.PORT || 47900), host, dataFile, tls, turn, stun } = {}) {
  const db = new Db(dataFile === undefined ? path.join(__dirname, 'data', 'cloud.json') : dataFile);
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

  const limited = (key, max, windowMs) => {
    const list = (attempts.get(key) || []).filter((t) => now() - t < windowMs);
    list.push(now());
    attempts.set(key, list);
    return list.length > max;
  };

  function sessionFor(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    const key = b64(sha256(token));
    const session = db.data.sessions[key];
    if (!session || session.expiresAt < now()) {
      if (session) {
        delete db.data.sessions[key];
        db.save();
      }
      return null;
    }
    const user = db.data.users[session.userId];
    return user ? { key, session, user } : null;
  }

  function newSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.data.sessions[b64(sha256(token))] = { userId: user.id, createdAt: now(), expiresAt: now() + SESSION_TTL_MS };
    db.save();
    return { token, userId: user.id, email: user.email, expiresAt: now() + SESSION_TTL_MS };
  }

  const hashAuthKey = (authKey, salt) => crypto.scryptSync(authKey, salt, 32, { N: 16384, r: 8, p: 1 });

  const relay = attachRelay(null, {
    authorizeHost: async ({ id, publicKey, token }) => {
      const auth = sessionFor(token);
      if (!auth) return null;
      const device = auth.user.devices[id];
      return device && device.publicKey === publicKey ? { account: auth.user.id } : null;
    },
    authorizeConnect: async ({ to, hostAccount, url }) => {
      const ticket = tickets.get(url.searchParams.get('ticket'));
      if (!ticket || ticket.expires < now() || ticket.to !== to || ticket.userId !== hostAccount) return false;
      tickets.delete(url.searchParams.get('ticket'));
      return true;
    },
    presenceFor: async ({ ids, req }) => {
      const auth = sessionFor(bearer(req));
      return auth ? ids.filter((id) => auth.user.devices[id]) : null;
    },
  });

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
  const bytesOf = (value, length) => {
    try {
      const buf = Buffer.from(String(value), 'base64');
      return buf.length === length ? buf : null;
    } catch {
      return null;
    }
  };

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
        const user = db.data.users[db.data.emails[email.toLowerCase()]];
        // Unknown addresses get a stable fake salt so this can't be used to discover accounts.
        const salt = user ? user.salt : b64(crypto.createHmac('sha256', db.data.secret).update(email.toLowerCase()).digest().subarray(0, 16));
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
        if (db.data.emails[lower]) return send(409, { error: 'exists' });
        const serverSalt = crypto.randomBytes(16);
        const user = {
          id: crypto.randomUUID(),
          email: lower,
          salt: b64(saltBytes),
          auth: `${b64(serverSalt)}:${b64(hashAuthKey(keyBytes, serverSalt))}`,
          totp: null,
          vault: { version: 0, blob: null, updatedAt: now() },
          devices: {},
          createdAt: now(),
        };
        db.data.users[user.id] = user;
        db.data.emails[lower] = user.id;
        db.save();
        log('account created');
        return send(200, newSession(user));
      }

      if (route === 'POST /v1/login') {
        const { email, authKey, totp } = await readBody(req);
        if (!validEmail(email)) return send(400, { error: 'email' });
        const lower = email.toLowerCase();
        if (limited(`login:${lower}`, 10, 15 * 60 * 1000) || limited(`login-ip:${ip}`, 50, 15 * 60 * 1000)) return send(429, { error: 'slow-down' });
        const user = db.data.users[db.data.emails[lower]];
        const keyBytes = bytesOf(authKey, 32);
        const [serverSalt, stored] = user ? user.auth.split(':') : [b64(crypto.randomBytes(16)), b64(crypto.randomBytes(32))];
        const computed = hashAuthKey(keyBytes || Buffer.alloc(32), Buffer.from(serverSalt, 'base64'));
        if (!user || !keyBytes || !crypto.timingSafeEqual(computed, Buffer.from(stored, 'base64'))) return send(401, { error: 'credentials' });
        if (user.totp && user.totp.enabled) {
          if (!totp) return send(401, { error: 'totp-required' });
          if (!totpValid(user.totp.secret, totp)) return send(401, { error: 'totp' });
        }
        return send(200, newSession(user));
      }

      const auth = sessionFor(bearer(req));
      if (!auth) return send(401, { error: 'unauthorized' });
      const { user } = auth;

      if (route === 'POST /v1/logout') {
        delete db.data.sessions[auth.key];
        db.save();
        return send(200, { ok: true });
      }

      if (route === 'GET /v1/me') {
        return send(200, {
          email: user.email,
          totp: !!(user.totp && user.totp.enabled),
          devices: Object.entries(user.devices).map(([id, d]) => ({ id, name: d.name, os: d.os, lastSeen: d.lastSeen })),
        });
      }

      if (route === 'GET /v1/vault') return send(200, { version: user.vault.version, blob: user.vault.blob });

      if (route === 'PUT /v1/vault') {
        const { baseVersion, blob } = await readBody(req);
        if (typeof blob !== 'string' || blob.length > MAX_VAULT) return send(400, { error: 'bad-request' });
        if (Number(baseVersion) !== user.vault.version) return send(409, { version: user.vault.version, blob: user.vault.blob });
        user.vault = { version: user.vault.version + 1, blob, updatedAt: now() };
        db.save();
        return send(200, { version: user.vault.version });
      }

      if (route === 'POST /v1/devices') {
        const { id, publicKey, name, os, ts, sig } = await readBody(req);
        if (typeof publicKey !== 'string' || deviceIdFromKey(publicKey) !== id || Math.abs(now() - Number(ts)) > 5 * 60 * 1000
          || !verifyText(`jconnect-cloud-device:${id}:${user.id}:${ts}`, sig, publicKey)) {
          return send(400, { error: 'bad-device' });
        }
        if (!user.devices[id] && Object.keys(user.devices).length >= 50) return send(429, { error: 'too-many-devices' });
        user.devices[id] = { publicKey, name: String(name || '').slice(0, 64), os: String(os || '').slice(0, 32), lastSeen: now() };
        db.save();
        return send(200, { ok: true });
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/v1/devices/')) {
        const id = url.pathname.split('/').pop();
        delete user.devices[id];
        const hostEntry = relay.hosts.get(id);
        if (hostEntry && hostEntry.account === user.id) hostEntry.ws.close(4003, 'removed');
        db.save();
        return send(200, { ok: true });
      }

      if (route === 'POST /v1/relay/ticket') {
        const { to } = await readBody(req);
        if (!user.devices[to]) return send(404, { error: 'unknown-device' });
        if (limited(`ticket:${user.id}`, 120, 60 * 1000)) return send(429, { error: 'slow-down' });
        const ticket = crypto.randomBytes(24).toString('base64url');
        tickets.set(ticket, { userId: user.id, to, expires: now() + TICKET_TTL_MS });
        return send(200, { ticket, expiresAt: now() + TICKET_TTL_MS });
      }

      if (route === 'GET /v1/ice') {
        const iceServers = stunServers.length ? [{ urls: stunServers }] : [];
        if (turnServer && turnServer.publicHost) {
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
        const secret = base32Encode(crypto.randomBytes(20));
        user.totp = { secret, enabled: false };
        db.save();
        const label = encodeURIComponent(`JConnect:${user.email}`);
        return send(200, { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=JConnect&digits=6&period=30` });
      }

      if (route === 'POST /v1/totp/enable' || route === 'POST /v1/totp/disable') {
        const { code } = await readBody(req);
        if (!user.totp || !totpValid(user.totp.secret, code)) return send(400, { error: 'totp' });
        if (route.endsWith('enable')) user.totp.enabled = true;
        else user.totp = null;
        db.save();
        return send(200, { ok: true, totp: !!(user.totp && user.totp.enabled) });
      }

      return send(404, { error: 'not-found' });
    } catch (err) {
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

  const sweeper = setInterval(() => {
    for (const [ticket, t] of tickets) if (t.expires < now()) tickets.delete(ticket);
  }, 30000);

  return {
    server,
    db,
    listen() {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close() {
      clearInterval(sweeper);
      relay.close();
      for (const timer of turnUsers.values()) clearTimeout(timer);
      if (turnServer) turnServer.stop();
      db.saveNow();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createCloud, totpCode, base32Encode };

if (require.main === module) {
  createCloud().listen().then((p) => log(`JConnect Cloud listening on port ${p}`));
}
