#!/usr/bin/env node
// JConnect relay (the internet leg of JVPN).
//
// Computers normally connect directly (LAN, Tailscale, other private routes). When no direct path
// exists, a computer keeps an outbound connection to this relay, and a trusted device reaches it
// through the relay instead. The relay only pipes bytes: devices run the end-to-end encrypted
// JConnect channel through it, so the relay can't read, change or impersonate anything.
//
//   Host control:  ws://relay/host      -> {t:'register', id, publicKey, ts, sig, token?}
//   Client:        ws://relay/connect?to=<deviceId>[&ticket=<ticket>]
//   Host tunnel:   ws://relay/accept?tunnel=<token>
//   Presence:      GET /presence?ids=a,b,c  -> {"online":["a"]}
//   Health:        GET /health
//
// On its own the relay is open (useful on a private network). Mounted inside JConnect Cloud it
// is given authorize hooks so only devices on the same account can register, look up or dial.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const nacl = require('tweetnacl');

const PORT = Number(process.env.PORT || process.env.JCONNECT_RELAY_PORT || 47880);
const MAX_PAYLOAD = 8 * 1024 * 1024;
const TUNNEL_ACCEPT_TIMEOUT_MS = 15000;
const REGISTER_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_TUNNELS_PER_HOST = 8;
const MAX_PENDING_PER_IP = 20;
const PING_INTERVAL_MS = 25000;

// Must match src/main/store.js deviceIdFromKey(): the id is bound to the key.
function deviceIdFromKey(publicKeyB64) {
  return crypto.createHash('sha512').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 20);
}

function verifyText(text, sigB64, publicKeyB64) {
  try {
    const pub = Buffer.from(String(publicKeyB64), 'base64');
    const sig = Buffer.from(String(sigB64), 'base64');
    if (pub.length !== nacl.sign.publicKeyLength || sig.length !== nacl.sign.signatureLength) return false;
    return nacl.sign.detached.verify(Buffer.from(String(text), 'utf8'), sig, pub);
  } catch {
    return false;
  }
}

function registerText(id, ts) { return `jconnect-relay-register:${id}:${ts}`; }

function clientIp(req) { return req.socket.remoteAddress || '?'; }

function log(...args) {
  if (process.env.JCONNECT_RELAY_QUIET) return;
  console.log(new Date().toISOString(), '[relay]', ...args);
}

const allowAll = async () => ({ account: null });

// Adds the relay to an existing HTTP(S) server.
//   authorizeHost({ id, publicKey, token, req })        -> {account} | null
//   authorizeConnect({ to, hostAccount, url, req })      -> true | false
//   presenceFor({ ids, req })                            -> ids the caller may see
function attachRelay(server, { authorizeHost = allowAll, authorizeConnect = async () => true, presenceFor = async ({ ids }) => ids } = {}) {
  const hosts = new Map(); // deviceId -> { ws, tunnels: Set<token>, account }
  const pending = new Map(); // token -> { client, hostId, timer, ip }
  const pendingPerIp = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

  async function handleRequest(req, res, url) {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') {
      send(200, { app: 'jconnect-relay', ok: true, hosts: hosts.size });
      return true;
    }
    if (url.pathname === '/presence') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter((x) => /^[0-9a-f]{20}$/.test(x)).slice(0, 100);
      const visible = await presenceFor({ ids, req });
      if (!visible) {
        send(401, { error: 'unauthorized' });
        return true;
      }
      send(200, { online: visible.filter((id) => hosts.has(id)) });
      return true;
    }
    return false;
  }

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://relay');
    if (!['/host', '/connect', '/accept'].includes(url.pathname)) return false;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => {});
      if (url.pathname === '/host') onHost(ws, req);
      else if (url.pathname === '/connect') onConnect(ws, req, url);
      else onAccept(ws, url.searchParams.get('tunnel'));
    });
    return true;
  }

  function onHost(ws, req) {
    let hostId = null;
    let registering = false;
    const registerTimer = setTimeout(() => { if (!hostId) ws.close(4001, 'register-timeout'); }, 10000);

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.t === 'register' && !hostId && !registering) {
        registering = true;
        const { id, publicKey, ts, sig, token } = msg;
        const fresh = Math.abs(Date.now() - Number(ts)) < REGISTER_CLOCK_SKEW_MS;
        if (typeof id !== 'string' || typeof publicKey !== 'string' || !fresh
          || deviceIdFromKey(publicKey) !== id || !verifyText(registerText(id, ts), sig, publicKey)) {
          log('rejected registration from', clientIp(req));
          ws.close(4003, 'bad-register');
          return;
        }
        const grant = await authorizeHost({ id, publicKey, token, req }).catch(() => null);
        if (!grant) {
          ws.close(4003, 'unauthorized');
          return;
        }
        if (ws.readyState !== ws.OPEN) return;
        clearTimeout(registerTimer);
        const previous = hosts.get(id);
        if (previous) previous.ws.close(4000, 'replaced');
        hostId = id;
        hosts.set(id, { ws, tunnels: new Set(), account: grant.account || null });
        ws.send(JSON.stringify({ t: 'registered', id }));
        log('host online', id);
      } else if (msg.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong' }));
      }
    });

    ws.on('close', () => {
      clearTimeout(registerTimer);
      const entry = hostId && hosts.get(hostId);
      if (entry && entry.ws === ws) {
        hosts.delete(hostId);
        log('host offline', hostId);
      }
    });
  }

  async function onConnect(client, req, url) {
    const ip = clientIp(req);
    const to = url.searchParams.get('to');
    const early = [];
    const buffer = (data, isBinary) => { if (early.length < 64) early.push([data, isBinary]); };
    client.on('message', buffer);

    const hostEntry = typeof to === 'string' ? hosts.get(to) : null;
    if (!hostEntry) { client.close(4004, 'unreachable'); return; }
    const allowed = await authorizeConnect({ to, hostAccount: hostEntry.account, url, req }).catch(() => false);
    if (!allowed) { client.close(4003, 'unauthorized'); return; }
    if (client.readyState !== client.OPEN) return;
    if (hostEntry.tunnels.size >= MAX_TUNNELS_PER_HOST) { client.close(4029, 'busy'); return; }
    const perIp = pendingPerIp.get(ip) || 0;
    if (perIp >= MAX_PENDING_PER_IP) { client.close(4029, 'busy'); return; }

    const token = crypto.randomBytes(24).toString('base64url');
    const timer = setTimeout(() => {
      dropPending(token);
      client.close(4004, 'unreachable');
    }, TUNNEL_ACCEPT_TIMEOUT_MS);

    pending.set(token, { client, hostId: to, timer, ip, early, buffer });
    pendingPerIp.set(ip, perIp + 1);
    client.on('close', () => dropPending(token));
    hostEntry.ws.send(JSON.stringify({ t: 'incoming', tunnel: token }));
  }

  function dropPending(token) {
    const p = pending.get(token);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(token);
    const n = (pendingPerIp.get(p.ip) || 1) - 1;
    if (n <= 0) pendingPerIp.delete(p.ip); else pendingPerIp.set(p.ip, n);
  }

  function onAccept(hostSide, token) {
    const p = typeof token === 'string' ? pending.get(token) : null;
    const hostEntry = p && hosts.get(p.hostId);
    if (!p || !hostEntry || p.client.readyState !== p.client.OPEN) { hostSide.close(4004, 'no-tunnel'); return; }
    dropPending(token);

    const { client, early, buffer } = p;
    client.off('message', buffer);
    hostEntry.tunnels.add(token);

    const pipe = (from, to) => {
      from.on('message', (data, isBinary) => {
        if (to.readyState === to.OPEN) to.send(data, { binary: isBinary });
      });
      from.on('close', (code) => {
        hostEntry.tunnels.delete(token);
        if (to.readyState === to.OPEN || to.readyState === to.CONNECTING) {
          to.close(code >= 4000 && code < 5000 ? code : 1000);
        }
      });
      from.on('error', () => from.terminate());
    };
    pipe(client, hostSide);
    pipe(hostSide, client);
    for (const [data, isBinary] of early) hostSide.send(data, { binary: isBinary });
    log('tunnel open to', p.hostId);
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);

  return {
    hosts,
    handleRequest,
    handleUpgrade,
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
    },
  };
}

function createRelay({ port = PORT, host } = {}) {
  const server = http.createServer();
  const relay = attachRelay(server);
  server.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://relay');
    if (await relay.handleRequest(req, res, url)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not-found' }));
  });
  server.on('upgrade', (req, socket, head) => {
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });

  return {
    server,
    listen() {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close() {
      relay.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createRelay, attachRelay, deviceIdFromKey, registerText, verifyText };

if (require.main === module) {
  createRelay().listen().then((port) => log(`listening on port ${port}`));
}
