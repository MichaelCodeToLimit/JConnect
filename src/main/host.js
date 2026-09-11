const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const JCSecure = require('../shared/secure-channel');
const { verify, deviceIdFromKey } = require('./store');
const { macAddresses, pathKind } = require('./discovery');
const { scrypt } = require('./kdf');

const { PREFIX } = JCSecure;
const QUALITIES = ['saver', 'balanced', 'sharp'];
const AUTH_TIMEOUT_MS = 150000;
const MAX_STREAMS = 16;
const STREAM_HIGH_WATER = 8 * 1024 * 1024;
// JConnect frames are at most a few tens of kilobytes (stream data comes in socket-sized chunks).
const MAX_FRAME = 1024 * 1024;
// Connections that haven't signed in yet, from one address and in total.
const MAX_PENDING_PER_SOURCE = 16;
const MAX_PENDING = 128;

// Browsers always send Origin with a WebSocket request, so other websites can't use this socket to ask for
// pairing or guess codes. From a browser engine only the phone page this computer serves (same origin), the
// desktop app (file://) and the Android app (http://localhost) may connect. Apps without one send no Origin.
function originAllowed(origin, req) {
  if (!origin) return true;
  if (origin === 'file://' || origin === 'http://localhost' || origin === 'https://localhost') return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === String(req.headers.host || '').toLowerCase();
  } catch {
    return false;
  }
}
const SERVICE_LABELS = { ssh: 'SSH', rdp: 'Remote Desktop' };

const SRC = path.join(__dirname, '..');
const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
// Browser client for phones, tablets and TVs ("Use Another Computer").
const WEB = path.join(SRC, 'web');
const STATIC_FILES = {
  '/': [path.join(WEB, 'index.html'), 'text/html; charset=utf-8'],
  '/index.html': [path.join(WEB, 'index.html'), 'text/html; charset=utf-8'],
  '/web.css': [path.join(WEB, 'web.css'), CSS],
  '/identity.js': [path.join(WEB, 'identity.js'), JS],
  '/input.js': [path.join(WEB, 'input.js'), JS],
  '/connection.js': [path.join(WEB, 'connection.js'), JS],
  '/app.js': [path.join(WEB, 'app.js'), JS],
  '/secure-channel.js': [path.join(SRC, 'shared', 'secure-channel.js'), JS],
  '/vendor/nacl-fast.min.js': [path.join(WEB, 'vendor', 'nacl-fast.min.js'), JS],
  '/vendor/scrypt.js': [path.join(WEB, 'vendor', 'scrypt.js'), JS],
  '/icon.png': [path.join(SRC, '..', 'assets', 'icon.png'), 'image/png'],
};
const MANIFEST = JSON.stringify({
  name: 'JConnect', short_name: 'JConnect', start_url: '/', display: 'fullscreen',
  background_color: '#0b0d12', theme_color: '#2f6bff',
  icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }],
});
const CSP = "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const cleanText = (value, max) => String(value ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, max);
const normalizeIp = (ip) => (ip || '?').replace(/^::ffff:/, '');
const minQuality = (a, b) => QUALITIES[Math.min(QUALITIES.indexOf(a), QUALITIES.indexOf(b))];

class HostAgent extends EventEmitter {
  constructor({ store, security, input, capture }) {
    super();
    this.store = store;
    this.security = security;
    this.input = input;
    this.capture = capture;
    this.conns = new Map();
    this.sessions = new Map();
    this.resourceCap = 'sharp';
    this.promptLog = new Map();
    this.pendingPrompts = 0;
    this.pendingBySource = new Map();
    this.pendingTotal = 0;
    this.askOwner = async () => ({ allow: false });
    // Injected by the account module: devices signed in to the same JConnect account.
    this.accountDevices = () => [];
    // Injected by JVPN: STUN/TURN servers for sessions that cross the internet.
    this.iceServersFor = async () => [];
    this._kdfChain = Promise.resolve();
    this.rotateCode();
    this._codeTimer = setInterval(() => this.rotateCode(), 10 * 60 * 1000);

    capture.on('offer', (sid, sdp) => {
      const conn = this._connForSession(sid);
      if (conn) this._send(conn, 'offer', { sdp, sig: store.sign(PREFIX.sdp + sdp) });
    });
    capture.on('ice', (sid, candidate) => {
      const conn = this._connForSession(sid);
      if (conn) this._send(conn, 'ice', { candidate });
    });
    capture.on('input', (sid, raw) => {
      const session = this.sessions.get(sid);
      if (!session || session.permission !== 'control' || this.security.lockdown) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this.input.handle(sid, msg, session.displayId);
    });
    capture.on('ended', (sid) => {
      const conn = this._connForSession(sid);
      if (conn) this._endSession(conn);
    });
  }

  rotateCode() {
    this.pairingCode = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    this.emit('code', this.pairingCode);
    this.emit('change');
  }

  listen(preferredPort) {
    return new Promise((resolve, reject) => {
      const attempt = (port, remaining) => {
        const server = http.createServer((req, res) => this._http(req, res));
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && remaining > 0) attempt(port + 1, remaining - 1);
          else reject(err);
        });
        server.listen(port, () => {
          this.server = server;
          this.port = server.address().port;
          this.wss = new WebSocketServer({
            server,
            path: '/ws',
            maxPayload: MAX_FRAME,
            perMessageDeflate: false,
            verifyClient: ({ origin, req }) => originAllowed(origin, req),
          });
          this.wss.on('connection', (ws, req) => this._onSocket(ws, req));
          this._heartbeat = setInterval(() => this._beat(), 5000);
          resolve(this.port);
        });
      };
      attempt(preferredPort, preferredPort ? 9 : 0);
    });
  }

  // Only what another device needs to recognize this computer. Everything else is sent after
  // the encrypted channel is established and the device has proven who it is.
  info() {
    const d = this.store.device();
    return { app: 'jconnect', v: JCSecure.VERSION, id: d.id, name: d.name, os: d.os, publicKey: d.publicKey, port: this.port };
  }

  _http(req, res) {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, headers);
      res.end();
      return;
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/info') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.info()));
      return;
    }
    const entry = this.store.settings.allowBrowserClients !== false && STATIC_FILES[pathname];
    if (pathname === '/manifest.json' && entry !== false) {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/manifest+json' });
      res.end(MANIFEST);
      return;
    }
    if (!entry) {
      res.writeHead(404, headers);
      res.end('Not found');
      return;
    }
    fs.readFile(entry[0], (err, data) => {
      if (err) {
        res.writeHead(500, headers);
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Type': entry[1], 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' });
      res.end(data);
    });
  }

  // A tunnel that arrived through the JVPN relay: same protocol, end-to-end encrypted.
  acceptTunnel(ws) {
    this._onSocket(ws, null, 'jvpn');
  }

  async _onSocket(ws, req, via = null) {
    const ip = via || normalizeIp(req && req.socket && req.socket.remoteAddress);
    // Connections that haven't signed in yet are limited, so nobody can hold open thousands of them.
    const pendingHere = this.pendingBySource.get(ip) || 0;
    if (pendingHere >= MAX_PENDING_PER_SOURCE || this.pendingTotal >= MAX_PENDING) {
      try { ws.close(1013, 'busy'); } catch { /* gone */ }
      return;
    }
    this.pendingBySource.set(ip, pendingHere + 1);
    this.pendingTotal++;
    let pending = true;
    const leavePending = () => {
      if (!pending) return;
      pending = false;
      this.pendingTotal--;
      const left = (this.pendingBySource.get(ip) || 1) - 1;
      if (left > 0) this.pendingBySource.set(ip, left);
      else this.pendingBySource.delete(ip);
    };
    ws.once('close', leavePending);
    const d = this.store.device();
    let channel;
    try {
      channel = await JCSecure.accept(JCSecure.fromNodeSocket(ws), {
        id: d.id,
        publicKey: d.publicKey,
        sign: (text) => this.store.sign(text),
        info: { name: d.name, os: d.os, port: this.port },
      });
    } catch {
      try { ws.terminate(); } catch { /* gone */ }
      return;
    }

    const conn = {
      cid: crypto.randomUUID(),
      ws,
      channel,
      leavePending,
      ip,
      path: via === 'jvpn' ? 'jvpn' : pathKind(ip),
      state: 'hello',
      key: null,
      device: null,
      sessionId: null,
      alive: true,
      pairing: false,
      authAttempts: 0,
      streams: new Map(),
    };
    this.conns.set(conn.cid, conn);
    conn.authTimer = setTimeout(() => { if (conn.state !== 'authed') channel.close(4001, 'timeout'); }, AUTH_TIMEOUT_MS);

    ws.on('pong', () => { conn.alive = true; });
    channel.on('*', (msg) => {
      Promise.resolve(this._onMessage(conn, msg)).catch((err) => console.warn('[jconnect] host:', err.message));
    });
    channel.on('data', (sid, bytes) => this._streamData(conn, sid, bytes));
    channel.on('closed', () => {
      clearTimeout(conn.authTimer);
      this._closeStreams(conn);
      this._endSession(conn);
      this.conns.delete(conn.cid);
      this.emit('change');
    });

    const s = this.store.settings;
    const requiresPassword = !!(s.requirePassword && s.passwordHash);
    this._send(conn, 'welcome', {
      requiresPassword,
      passwordSalt: requiresPassword ? this.store.passwordSalt() : undefined,
      pairing: this.security.pairingAllowed(),
      path: conn.path,
    });
  }

  async _onMessage(conn, msg) {
    if (process.env.JCONNECT_DEBUG) console.log(`[host] ${conn.ip} ${conn.state} <- ${msg.type}`);
    const authed = conn.state === 'authed';
    const session = conn.sessionId && this.sessions.get(conn.sessionId);
    switch (msg.type) {
      case 'auth': return this._auth(conn, msg);
      case 'pair': return this._pair(conn, msg);
      case 'session-start': return authed ? this._startSession(conn, msg) : undefined;
      case 'answer':
        if (!session || typeof msg.sdp !== 'string') return undefined;
        if (!verify(PREFIX.sdp + msg.sdp, msg.sig, conn.device.publicKey)) {
          this.security.report('bad-signature', { ip: conn.ip, deviceName: conn.device.name, deviceId: conn.device.id });
          conn.channel.close(4003, 'security');
          return undefined;
        }
        return this.capture.signal(session.sid, { type: 'answer', sdp: msg.sdp });
      case 'ice':
        return session && msg.candidate ? this.capture.signal(session.sid, { type: 'ice', candidate: msg.candidate }) : undefined;
      case 'display':
        if (!session || !this.capture.displays().some((d) => d.id === String(msg.displayId))) return undefined;
        session.displayId = String(msg.displayId);
        this.input.release(session.sid);
        await this.capture.setDisplay(session.sid, session.displayId);
        return this._send(conn, 'notice', { kind: 'display-changed', displayId: session.displayId });
      case 'quality':
        if (!session || !['auto', ...QUALITIES].includes(msg.quality)) return undefined;
        session.requested = msg.quality;
        return this.capture.setQuality(session.sid, this._quality(session));
      case 'session-end':
        return this._endSession(conn);
      case 'owner-restore':
        if (authed && conn.device.owner && this.security.lockdown) {
          this.security.restore(conn.device.name);
          this._send(conn, 'restored', {});
        }
        return undefined;
      case 'stream-open': return authed ? this._openStream(conn, msg) : undefined;
      case 'stream-close': return this._closeStream(conn, Number(msg.sid));
      case 'stream-pause':
      case 'stream-resume': {
        const stream = conn.streams.get(Number(msg.sid));
        if (!stream) return undefined;
        stream.paused = msg.type === 'stream-pause';
        if (stream.paused) stream.socket.pause();
        else if (!stream.throttled) stream.socket.resume();
        return undefined;
      }
      case 'ping': return this._send(conn, 'pong', { t: msg.t });
      default:
        return undefined;
    }
  }

  _auth(conn, msg) {
    if (conn.state === 'authed' || conn.pairing) return;
    if (++conn.authAttempts > 6) {
      conn.channel.close(4001, 'too-many-attempts');
      return;
    }
    const { publicKey, sig } = msg;
    if (typeof publicKey !== 'string' || typeof sig !== 'string' || Buffer.from(publicKey, 'base64').length !== 32) {
      conn.channel.close(4000, 'bad-request');
      return;
    }
    const id = deviceIdFromKey(publicKey);
    const name = cleanText(msg.name, 64) || 'Device';
    const osName = cleanText(msg.os, 32);
    const report = (kind) => this.security.report(kind, { ip: conn.ip, deviceName: name, deviceId: id });

    // The signature covers this channel's transcript, so it can't be replayed on another connection.
    if (!verify(PREFIX.client + conn.channel.thB64, sig, publicKey)) {
      report('bad-signature');
      this._reject(conn, 'security', true);
      return;
    }

    const { settings } = this.store;
    const accountDevice = this.accountDevices().find((dev) => dev.publicKey === publicKey) || null;
    conn.key = { id, publicKey, name, os: osName, account: !!accountDevice };
    let trusted = this.store.findTrusted(publicKey);

    if (!settings.remoteAccess) {
      this._reject(conn, 'disabled', true);
      return;
    }
    if (!trusted && accountDevice && settings.accountTrust && !this.security.travelMode && !this.security.lockdown) {
      this.store.addTrusted({ id, name, os: osName, publicKey, owner: true, via: 'account' });
      this.store.log({ kind: 'paired', level: 'info', deviceName: name, message: `${name} can use this computer because it's signed in to your JConnect account.` });
      trusted = this.store.findTrusted(publicKey);
    }
    if (!trusted) {
      if (this.security.travelMode || this.security.lockdown) {
        report('unknown-device');
        this._reject(conn, this.security.lockdown ? 'locked' : 'travel', true);
        return;
      }
      conn.state = 'proven';
      this._reject(conn, 'untrusted', false);
      return;
    }
    if (this.security.lockdown && !trusted.owner) {
      this._reject(conn, 'locked', true);
      return;
    }
    if (this.security.travelMode && settings.travelOwnerOnly && !trusted.owner) {
      this._reject(conn, 'travel', true);
      return;
    }
    if (settings.requirePassword && settings.passwordHash) {
      if (typeof msg.password !== 'string' || !msg.password) {
        this._reject(conn, 'password-required', false);
        return;
      }
      if (!this.store.checkPasswordProof(msg.password, conn.channel.th)) {
        const level = report('bad-password');
        this._reject(conn, 'password', level !== 'low');
        return;
      }
    }

    conn.state = 'authed';
    conn.device = trusted;
    conn.leavePending();
    clearTimeout(conn.authTimer);
    this.store.updateTrusted(trusted.id, { lastSeen: Date.now(), os: osName || trusted.os });
    this._send(conn, 'auth-ok', {
      permission: trusted.permission || 'control',
      owner: !!trusted.owner,
      locked: !!this.security.lockdown,
      lockdown: trusted.owner ? this.security.lockdown : null,
      inputAvailable: this.input.available,
      mac: macAddresses(),
      services: this._services(),
    });
    this.emit('change');
  }

  _reject(conn, reason, close) {
    this._send(conn, 'auth-fail', { reason, canPair: reason === 'untrusted' && this.security.pairingAllowed() });
    if (close) setTimeout(() => conn.channel.close(4001, reason), 100);
  }

  _derive(secret, salt) {
    const run = this._kdfChain.then(() => scrypt(secret, salt));
    this._kdfChain = run.catch(() => {});
    return run;
  }

  async _pair(conn, msg) {
    if (conn.state !== 'proven' || conn.pairing || !conn.key) return;
    const { key } = conn;
    if (!this.security.pairingAllowed()) {
      this._send(conn, 'pair-result', { ok: false, reason: this.security.travelMode ? 'travel' : 'paused' });
      return;
    }

    if (typeof msg.proof === 'string') {
      conn.pairing = true;
      let ok = false;
      try {
        const expected = Buffer.from(await this._derive(JCSecure.normalizeSecret(this.pairingCode), JCSecure.pairSalt(conn.channel.th)));
        const given = Buffer.from(msg.proof, 'base64');
        ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
      } finally {
        conn.pairing = false;
      }
      if (conn.channel.isClosed) return;
      if (!ok) {
        const level = this.security.report('bad-code', { ip: conn.ip, deviceName: key.name, deviceId: key.id });
        this._send(conn, 'pair-result', { ok: false, reason: 'code' });
        if (level !== 'low') setTimeout(() => conn.channel.close(4001, 'paused'), 100);
        return;
      }
      this.rotateCode();
      this._completePair(conn, !this.store.data.trusted.some((t) => t.owner));
      return;
    }

    const now = Date.now();
    const recent = (this.promptLog.get(conn.ip) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (this.pendingPrompts > 0 || recent.length >= 3) {
      this._send(conn, 'pair-result', { ok: false, reason: 'busy' });
      return;
    }
    this.promptLog.set(conn.ip, [...recent, now]);

    conn.pairing = true;
    this.pendingPrompts++;
    this._send(conn, 'pair-result', { pending: true, sas: conn.channel.sas });
    let decision = { allow: false };
    try {
      decision = await this.askOwner({ ...key, sas: conn.channel.sas });
    } finally {
      conn.pairing = false;
      this.pendingPrompts--;
    }
    if (conn.channel.isClosed) return;
    if (!decision.allow) {
      this.security.report('pairing-denied', { ip: conn.ip, deviceName: key.name, deviceId: key.id });
      this._send(conn, 'pair-result', { ok: false, reason: 'denied' });
      return;
    }
    this._completePair(conn, !!decision.owner);
  }

  _completePair(conn, owner) {
    const { key } = conn;
    this.store.addTrusted({ id: key.id, name: key.name, os: key.os, publicKey: key.publicKey, owner });
    this.store.log({ kind: 'paired', level: 'info', deviceName: key.name, message: `${key.name} can now use this computer.` });
    conn.state = 'hello';
    const info = this.info();
    this._send(conn, 'pair-result', {
      ok: true,
      host: { id: info.id, name: info.name, os: info.os, publicKey: info.publicKey, mac: macAddresses(), port: info.port },
    });
    this.emit('change');
  }

  async _startSession(conn, msg) {
    if (conn.sessionId) return;
    if (this.security.lockdown) {
      this._send(conn, 'session-denied', { reason: 'locked' });
      return;
    }
    const displays = this.capture.displays();
    const displayId = displays.some((d) => d.id === String(msg.displayId))
      ? String(msg.displayId)
      : (displays.find((d) => d.primary) || displays[0]).id;
    const session = {
      sid: crypto.randomUUID(),
      cid: conn.cid,
      deviceId: conn.device.id,
      name: conn.device.name,
      os: conn.device.os,
      ip: conn.ip,
      path: conn.path,
      since: Date.now(),
      displayId,
      permission: conn.device.permission || 'control',
      requested: ['auto', ...QUALITIES].includes(msg.quality) ? msg.quality : 'auto',
    };
    const crossesInternet = conn.path === 'jvpn' || conn.path === 'internet' || msg.ice === 'internet';
    const iceServers = crossesInternet ? await this.iceServersFor(conn).catch(() => []) : [];

    this.sessions.set(session.sid, session);
    conn.sessionId = session.sid;
    this._send(conn, 'session', {
      sid: session.sid,
      displays,
      displayId,
      permission: session.permission,
      inputAvailable: this.input.available,
      iceServers,
    });
    try {
      await this.capture.start(session.sid, { displayId, quality: this._quality(session), iceServers });
    } catch (err) {
      console.warn('[jconnect] capture failed:', err.message);
      this._send(conn, 'session-denied', { reason: 'capture' });
      this._endSession(conn);
      return;
    }
    this.store.log({ kind: 'session', level: 'info', deviceName: session.name, message: `${session.name} connected${conn.path === 'jvpn' ? ' through JVPN' : ''}.` });
    this.emit('change');
  }

  _quality(session) {
    const wanted = session.requested === 'auto'
      ? (session.path === 'local' || session.path === 'lan' ? 'sharp' : 'balanced')
      : session.requested;
    const cap = this.security.travelMode ? minQuality(this.resourceCap, 'balanced') : this.resourceCap;
    return minQuality(wanted, cap);
  }

  setResourceCap(level) {
    this.resourceCap = level;
    this.refreshQuality();
  }

  refreshQuality() {
    for (const s of this.sessions.values()) this.capture.setQuality(s.sid, this._quality(s));
  }

  _endSession(conn) {
    const sid = conn.sessionId;
    if (!sid) return;
    conn.sessionId = null;
    this.sessions.delete(sid);
    this.capture.stop(sid);
    this.input.release(sid);
    this.emit('change');
  }

  // ---- JVPN streams: SSH, Remote Desktop and other shared services, carried inside the channel ----

  _services() {
    const s = this.store.settings;
    return { ssh: !!s.shareSsh, rdp: !!s.shareRdp };
  }

  _servicePort(service) {
    const s = this.store.settings;
    if (service === 'ssh' && s.shareSsh) return Number(s.sshPort) || 22;
    if (service === 'rdp' && s.shareRdp) return 3389;
    return 0;
  }

  _openStream(conn, msg) {
    const sid = Number(msg.sid);
    if (!Number.isInteger(sid) || sid <= 0 || sid > 0xffffffff || conn.streams.has(sid)) return;
    const fail = (reason) => this._send(conn, 'stream-fail', { sid, reason });
    if (conn.streams.size >= MAX_STREAMS) { fail('busy'); return; }
    if (this.security.lockdown) { fail('locked'); return; }
    if ((conn.device.permission || 'control') !== 'control') { fail('view-only'); return; }
    const service = String(msg.service || '');
    const port = this._servicePort(service);
    if (!port) { fail('not-shared'); return; }

    const socket = net.connect({ host: '127.0.0.1', port });
    const stream = { sid, socket, service, open: false, paused: false, throttled: false };
    conn.streams.set(sid, stream);
    socket.setNoDelay(true);
    socket.once('connect', () => {
      stream.open = true;
      this._send(conn, 'stream-ok', { sid });
      this.store.log({ kind: 'stream', level: 'info', deviceName: conn.device.name, message: `${conn.device.name} opened ${SERVICE_LABELS[service] || service} through JVPN.` });
    });
    socket.on('data', (chunk) => {
      conn.channel.sendData(sid, chunk);
      if (!stream.throttled && conn.channel.buffered() > STREAM_HIGH_WATER) {
        stream.throttled = true;
        socket.pause();
        const check = setInterval(() => {
          if (conn.channel.isClosed || conn.channel.buffered() < STREAM_HIGH_WATER / 4) {
            clearInterval(check);
            stream.throttled = false;
            if (!stream.paused) socket.resume();
          }
        }, 25);
      }
    });
    socket.on('drain', () => this._send(conn, 'stream-resume', { sid }));
    socket.on('error', (err) => {
      if (!stream.open) fail(err.code === 'ECONNREFUSED' ? 'not-running' : 'unreachable');
    });
    socket.on('close', () => {
      if (conn.streams.get(sid) !== stream) return;
      conn.streams.delete(sid);
      if (stream.open) this._send(conn, 'stream-close', { sid });
    });
  }

  _streamData(conn, sid, bytes) {
    const stream = conn.streams.get(sid);
    if (!stream || !stream.open) return;
    if (!stream.socket.write(Buffer.from(bytes))) this._send(conn, 'stream-pause', { sid });
  }

  _closeStream(conn, sid) {
    const stream = conn.streams.get(sid);
    if (!stream) return;
    conn.streams.delete(sid);
    stream.socket.destroy();
  }

  _closeStreams(conn) {
    for (const stream of conn.streams.values()) stream.socket.destroy();
    conn.streams.clear();
  }

  // ---- plumbing ----

  _connForSession(sid) {
    const session = this.sessions.get(sid);
    return session ? this.conns.get(session.cid) : null;
  }

  _send(conn, type, data = {}) {
    return conn.channel.send(type, data);
  }

  _beat() {
    for (const conn of this.conns.values()) {
      if (!conn.alive) {
        try { conn.ws.terminate(); } catch { /* gone */ }
        continue;
      }
      conn.alive = false;
      try { conn.ws.ping(); } catch { /* closing */ }
      if (conn.state === 'authed') this._send(conn, 'tick');
    }
  }

  // ---- owner controls ----

  sessionList() {
    return [...this.sessions.values()].map(({ sid, deviceId, name, os, path: kind, since, permission }) => ({ sid, deviceId, name, os, path: kind, since, permission }));
  }

  streamList() {
    const out = [];
    for (const conn of this.conns.values()) {
      for (const s of conn.streams.values()) out.push({ deviceId: conn.device && conn.device.id, name: conn.device && conn.device.name, service: s.service });
    }
    return out;
  }

  _closeWithNotice(conn, kind, extra = {}) {
    this._send(conn, 'notice', { kind, ...extra });
    this._endSession(conn);
    this._closeStreams(conn);
    setTimeout(() => conn.channel.close(4002, kind), 100);
  }

  disconnectSession(sid) {
    const conn = this._connForSession(sid);
    if (conn) this._closeWithNotice(conn, 'ended-by-owner');
  }

  revokeDevice(deviceId) {
    const trusted = this.store.data.trusted.find((t) => t.id === deviceId);
    this.store.removeTrusted(deviceId);
    if (trusted) this.store.log({ kind: 'revoked', level: 'info', deviceName: trusted.name, message: `${trusted.name} can no longer use this computer.` });
    for (const conn of this.conns.values()) {
      if (conn.key && conn.key.id === deviceId) this._closeWithNotice(conn, 'revoked');
    }
  }

  updatePermissions(deviceId) {
    const trusted = this.store.data.trusted.find((t) => t.id === deviceId);
    if (!trusted) return;
    for (const conn of this.conns.values()) {
      if (conn.state !== 'authed' || conn.device.id !== deviceId) continue;
      conn.device = trusted;
      if (trusted.permission !== 'control') this._closeStreams(conn);
      const session = conn.sessionId && this.sessions.get(conn.sessionId);
      if (session && session.permission !== trusted.permission) {
        session.permission = trusted.permission;
        this.input.release(session.sid);
        this._send(conn, 'notice', { kind: 'permission', permission: trusted.permission });
      }
    }
    this.applyTravelMode();
    this.emit('change');
  }

  applyServices() {
    const services = this._services();
    for (const conn of this.conns.values()) {
      if (conn.state !== 'authed') continue;
      for (const stream of [...conn.streams.values()]) {
        if (!services[stream.service]) this._closeStream(conn, stream.sid);
      }
      this._send(conn, 'notice', { kind: 'services', services });
    }
  }

  applyRemoteAccess() {
    if (this.store.settings.remoteAccess) return;
    for (const conn of this.conns.values()) this._closeWithNotice(conn, 'disabled');
  }

  applyTravelMode() {
    if (this.security.travelMode && this.store.settings.travelOwnerOnly) {
      for (const conn of this.conns.values()) {
        if (conn.state === 'authed' && !conn.device.owner) this._closeWithNotice(conn, 'travel-mode');
      }
    }
    this.refreshQuality();
  }

  lockdownNow(entry) {
    for (const conn of this.conns.values()) {
      this._closeStreams(conn);
      if (conn.state === 'authed' && conn.device.owner) {
        this._endSession(conn);
        this._send(conn, 'notice', { kind: 'security-alert', level: 'high', message: entry.message, lockdown: this.security.lockdown });
      } else {
        this._closeWithNotice(conn, 'lockdown');
      }
    }
  }

  notifyOwners(entry) {
    for (const conn of this.conns.values()) {
      if (conn.state === 'authed' && conn.device.owner) {
        this._send(conn, 'notice', { kind: 'security-alert', level: entry.level, message: entry.message });
      }
    }
  }

  noticeAll(kind, extra = {}) {
    for (const conn of this.conns.values()) {
      if (conn.state === 'authed') this._send(conn, 'notice', { kind, ...extra });
    }
  }

  close() {
    clearInterval(this._codeTimer);
    clearInterval(this._heartbeat);
    for (const conn of this.conns.values()) conn.channel.close(1001, 'shutdown');
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
  }
}

module.exports = { HostAgent };
