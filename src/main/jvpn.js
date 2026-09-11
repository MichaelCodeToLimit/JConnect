// JVPN: JConnect's built-in private network.
//
// Devices reach each other directly when they can (same network, Tailscale and other VPNs). When
// they can't, they meet at the JConnect Cloud relay. Either way every byte travels inside the
// end-to-end encrypted JConnect channel, so the relay and the networks in between can't read it.
//
// Two halves live here:
//  - RelayLink keeps this computer reachable through the relay.
//  - JvpnClient opens encrypted streams to other computers (SSH, Remote Desktop, forwarded ports).
const net = require('net');
const { Duplex } = require('stream');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const JCSecure = require('../shared/secure-channel');
const { verify } = require('./store');
const { scrypt } = require('./kdf');

const wsBase = (url) => String(url).replace(/^http/i, 'ws').replace(/\/+$/, '');
const registerText = (id, ts) => `jconnect-relay-register:${id}:${ts}`;
const STREAM_HIGH_WATER = 4 * 1024 * 1024;
const FORWARD_IDLE_MS = 5 * 60 * 1000;

class RelayLink extends EventEmitter {
  constructor({ store, host, cloud }) {
    super();
    this.store = store;
    this.host = host;
    this.cloud = cloud; // () => { url, token } | null
    this.state = 'off';
    this.error = null;
    this.retryMs = 2000;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    if (this.ws) this.ws.terminate();
    this._set('off');
  }

  refresh() {
    clearTimeout(this.retryTimer);
    if (this.ws) {
      this.ws.removeAllListeners('close');
      this.ws.terminate();
      this.ws = null;
    }
    this.retryMs = 2000;
    if (!this.stopped) this._connect();
  }

  status() { return { state: this.state, error: this.error }; }

  _set(state, error = null) {
    if (state === this.state && error === this.error) return;
    this.state = state;
    this.error = error;
    this.emit('change', this.status());
  }

  _connect() {
    const cloud = this.cloud();
    const s = this.store.settings;
    if (!cloud || !s.jvpnEnabled || !s.remoteAccess) {
      this._set('off');
      return;
    }
    this._set('connecting');
    let ws;
    try {
      ws = new WebSocket(`${wsBase(cloud.url)}/host`, { handshakeTimeout: 10000, perMessageDeflate: false });
    } catch (err) {
      this._retry(err.message);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      const d = this.store.device();
      const ts = Date.now();
      ws.send(JSON.stringify({ t: 'register', id: d.id, publicKey: d.publicKey, ts, sig: this.store.sign(registerText(d.id, ts)), token: cloud.token }));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.t === 'registered') {
        this.retryMs = 2000;
        this._set('online');
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'ping' })); }, 25000);
      } else if (msg.t === 'incoming' && typeof msg.tunnel === 'string') {
        const tunnel = new WebSocket(`${wsBase(cloud.url)}/accept?tunnel=${encodeURIComponent(msg.tunnel)}`, { perMessageDeflate: false });
        tunnel.on('error', () => {});
        this.host.acceptTunnel(tunnel);
      }
    });
    ws.on('error', () => {});
    ws.on('close', (code, reason) => {
      clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      const why = String(reason || '');
      if (code === 4003) this._retry(why === 'unauthorized' ? 'This computer isn\'t registered to your JConnect account yet.' : 'The relay refused this computer.', 60000);
      else this._retry(code === 1006 ? 'JConnect Cloud isn\'t reachable.' : null);
    });
  }

  _retry(error, delay) {
    if (this.stopped) return;
    this._set('offline', error);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(), delay || this.retryMs);
    this.retryMs = Math.min(60000, this.retryMs * 2);
  }
}

// Opens authenticated, encrypted channels to other JConnect computers from the main process.
class JvpnClient {
  constructor({ store, resolveRoute }) {
    this.store = store;
    this.resolveRoute = resolveRoute; // async (computer, { onProgress }) -> { url, kind }
    this.entries = new Map();
  }

  async channelFor(computer, { password, onProgress } = {}) {
    const existing = this.entries.get(computer.id);
    if (existing && !existing.channel.isClosed) return existing;
    if (existing && existing.opening) return existing.opening;

    const opening = (async () => {
      const route = await this.resolveRoute(computer, { onProgress });
      if (!route || !route.url) throw JCSecure.failure('unreachable');
      if (onProgress) onProgress(route.kind === 'jvpn' ? 'Connecting through JVPN…' : 'Connecting…');
      const ws = new WebSocket(route.url, { handshakeTimeout: 10000, perMessageDeflate: false });
      ws.on('error', () => {});
      const channel = await JCSecure.connect(JCSecure.fromNodeSocket(ws), {
        verify: async (text, sig, key) => verify(text, sig, key),
        expectedKey: computer.publicKey,
      });
      const auth = await JCSecure.authenticate(channel, {
        identity: { ...this.store.device(), sign: (text) => this.store.sign(text) },
        password,
        derive: (secret, salt) => scrypt(secret, salt),
      });
      if (!auth.ok) {
        channel.close();
        throw JCSecure.failure(auth.reason || 'denied');
      }
      if (auth.locked) {
        channel.close();
        throw JCSecure.failure('locked');
      }
      const entry = { channel, auth, route, streams: new Map(), nextSid: 1 };
      channel.on('data', (sid, bytes) => {
        const stream = entry.streams.get(sid);
        if (stream && !stream.push(Buffer.from(bytes))) {
          stream.jcPausedRemote = true;
          channel.send('stream-pause', { sid });
        }
      });
      for (const type of ['stream-ok', 'stream-fail', 'stream-close', 'stream-pause', 'stream-resume']) {
        channel.on(type, (msg) => {
          const stream = entry.streams.get(Number(msg.sid));
          if (stream) stream.emit(`jc:${type}`, msg);
        });
      }
      channel.on('closed', () => {
        for (const stream of entry.streams.values()) stream.destroy(JCSecure.failure('closed'));
        entry.streams.clear();
        if (this.entries.get(computer.id) === entry) this.entries.delete(computer.id);
      });
      this.entries.set(computer.id, entry);
      return entry;
    })();

    this.entries.set(computer.id, { opening, channel: { isClosed: true } });
    try {
      return await opening;
    } catch (err) {
      if (this.entries.get(computer.id) && this.entries.get(computer.id).opening === opening) this.entries.delete(computer.id);
      throw err;
    }
  }

  // A Node Duplex stream to a service on the other computer (e.g. its SSH server).
  async openStream(computer, service, options = {}) {
    const entry = await this.channelFor(computer, options);
    const { channel } = entry;
    const sid = entry.nextSid++;
    let remoteOpen = false;
    let remotePaused = false;
    let waitingWrite = null;

    const flush = () => {
      if (!waitingWrite || remotePaused || channel.buffered() > STREAM_HIGH_WATER) return;
      const cb = waitingWrite;
      waitingWrite = null;
      cb();
    };
    const drainTimer = setInterval(flush, 25);

    const stream = new Duplex({
      read() {
        if (stream.jcPausedRemote) {
          stream.jcPausedRemote = false;
          channel.send('stream-resume', { sid });
        }
      },
      write(chunk, _encoding, callback) {
        if (!channel.sendData(sid, chunk)) {
          callback(JCSecure.failure('closed'));
          return;
        }
        if (remotePaused || channel.buffered() > STREAM_HIGH_WATER) waitingWrite = callback;
        else callback();
      },
      final(callback) {
        channel.send('stream-close', { sid });
        callback();
      },
      destroy(err, callback) {
        clearInterval(drainTimer);
        if (entry.streams.get(sid) === stream) {
          entry.streams.delete(sid);
          if (remoteOpen && !channel.isClosed) channel.send('stream-close', { sid });
        }
        if (waitingWrite) {
          const cb = waitingWrite;
          waitingWrite = null;
          cb(err || JCSecure.failure('closed'));
        }
        callback(err);
      },
    });
    stream.on('jc:stream-pause', () => { remotePaused = true; });
    stream.on('jc:stream-resume', () => { remotePaused = false; flush(); });
    stream.on('jc:stream-close', () => {
      remoteOpen = false;
      stream.push(null);
      stream.destroy();
    });
    entry.streams.set(sid, stream);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(JCSecure.failure('timeout')); }, 15000);
      const ok = () => { cleanup(); remoteOpen = true; resolve(); };
      const fail = (msg) => { cleanup(); reject(JCSecure.failure(msg.reason || 'denied')); };
      const gone = () => { cleanup(); reject(JCSecure.failure('closed')); };
      function cleanup() {
        clearTimeout(timer);
        stream.off('jc:stream-ok', ok);
        stream.off('jc:stream-fail', fail);
        stream.off('close', gone);
      }
      stream.once('jc:stream-ok', ok);
      stream.once('jc:stream-fail', fail);
      stream.once('close', gone);
      channel.send('stream-open', { sid, service });
    }).catch((err) => {
      stream.destroy();
      throw err;
    });
    return stream;
  }

  // Listens on 127.0.0.1 and carries every connection to `service` on the other computer through JVPN.
  // The listener closes after FORWARD_IDLE_MS without connections, so it doesn't stay open until JConnect quits.
  async forward(computer, service, options = {}) {
    await this.channelFor(computer, options);
    let active = 0;
    let idleTimer = null;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => server.close(), FORWARD_IDLE_MS);
    };
    const server = net.createServer((socket) => {
      active++;
      clearTimeout(idleTimer);
      socket.once('close', () => {
        active--;
        if (!active) armIdle();
      });
      socket.setNoDelay(true);
      this.openStream(computer, service, options).then((remote) => {
        socket.pipe(remote);
        remote.pipe(socket);
        const end = () => { socket.destroy(); remote.destroy(); };
        socket.on('error', end);
        remote.on('error', end);
        socket.on('close', end);
        remote.on('close', end);
      }, () => socket.destroy());
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    server.on('close', () => clearTimeout(idleTimer));
    armIdle();
    const closed = new Promise((resolve) => server.once('close', resolve));
    return { port: server.address().port, closed, close: () => server.close() };
  }

  closeAll() {
    for (const entry of this.entries.values()) {
      if (entry.channel && !entry.channel.isClosed) entry.channel.close();
    }
    this.entries.clear();
  }
}

module.exports = { RelayLink, JvpnClient, wsBase };
