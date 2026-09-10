#!/usr/bin/env node
// JConnect optional relay.
//
// Computers normally connect directly (LAN, Tailscale, other private routes). When no direct path
// exists, a computer can keep an outbound connection to this relay, and a trusted device can reach
// it through the relay instead. The relay only pipes bytes: it never sees keys, can't read what it
// forwards if the agents encrypt, and can't impersonate a computer because devices authenticate
// each other end to end with their own signing keys.
//
//   Host control:  ws://relay/host      -> {t:'register', id, publicKey, ts, sig}
//   Client:        ws://relay/connect?to=<deviceId>
//   Host tunnel:   ws://relay/accept?tunnel=<token>
//   Presence:      GET /presence?ids=a,b,c  -> {"online":["a"]}
//   Health:        GET /health

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const nacl = require('tweetnacl');

const PORT = Number(process.env.PORT || process.env.JCONNECT_RELAY_PORT || 47880);
const MAX_PAYLOAD = 4 * 1024 * 1024;
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

function createRelay({ port = PORT, host } = {}) {
  const hosts = new Map();    // deviceId -> { ws, tunnels: Set<token> }
  const pending = new Map();  // token -> { client, hostId, timer, ip }
  const pendingPerIp = new Map();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://relay');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') return send(200, { app: 'jconnect-relay', ok: true, hosts: hosts.size });
    if (url.pathname === '/presence') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter((x) => /^[0-9a-f]{20}$/.test(x)).slice(0, 100);
      return send(200, { online: ids.filter((id) => hosts.has(id)) });
    }
    send(404, { error: 'not-found' });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://relay');
    if (!['/host', '/connect', '/accept'].includes(url.pathname)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      if (url.pathname === '/host') onHost(ws, req);
      else if (url.pathname === '/connect') onConnect(ws, req, url.searchParams.get('to'));
      else onAccept(ws, url.searchParams.get('tunnel'));
    });
  });

  function onHost(ws, req) {
    let hostId = null;
    const registerTimer = setTimeout(() => { if (!hostId) ws.close(4001, 'register-timeout'); }, 10000);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.t === 'register' && !hostId) {
        const { id, publicKey, ts, sig } = msg;
        const fresh = Math.abs(Date.now() - Number(ts)) < REGISTER_CLOCK_SKEW_MS;
        if (typeof id !== 'string' || typeof publicKey !== 'string' || !fresh
          || deviceIdFromKey(publicKey) !== id || !verifyText(registerText(id, ts), sig, publicKey)) {
          log('rejected registration from', clientIp(req));
          ws.close(4003, 'bad-register');
          return;
        }
        clearTimeout(registerTimer);
        const previous = hosts.get(id);
        if (previous) previous.ws.close(4000, 'replaced');
        hostId = id;
        hosts.set(id, { ws, tunnels: new Set() });
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

  function onConnect(client, req, to) {
    const ip = clientIp(req);
    const hostEntry = typeof to === 'string' ? hosts.get(to) : null;
    if (!hostEntry) { client.close(4004, 'unreachable'); return; }
    if (hostEntry.tunnels.size >= MAX_TUNNELS_PER_HOST) { client.close(4029, 'busy'); return; }
    const perIp = pendingPerIp.get(ip) || 0;
    if (perIp >= MAX_PENDING_PER_IP) { client.close(4029, 'busy'); return; }

    const token = crypto.randomBytes(24).toString('base64url');
    const early = [];
    const buffer = (data, isBinary) => {
      if (early.length < 64) early.push([data, isBinary]);
    };
    client.on('message', buffer);

    const timer = setTimeout(() => {
      dropPending(token);
      client.close(4004, 'unreachable');
    }, TUNNEL_ACCEPT_TIMEOUT_MS);

    pending.set(token, { client, hostId: to, timer, ip, early, buffer });
    pendingPerIp.set(ip, perIp + 1);
    client.on('close', () => dropPending(token));
    hostEntry.ws.send(JSON.stringify({ t: 'incoming', tunnel: token, ip }));
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
    server,
    listen() {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createRelay, deviceIdFromKey, registerText };

if (require.main === module) {
  createRelay().listen().then((port) => log(`listening on port ${port}`));
}
