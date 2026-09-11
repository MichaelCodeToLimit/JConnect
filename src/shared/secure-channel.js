// JConnect secure channel (protocol v2). Shared by the host agent, the desktop app and the browser client.
//
// 1. client -> host  (text)  client-hello {v, eph, nonce}
// 2. host -> client  (text)  server-hello {v, id, name, os, publicKey, port, eph, nonce, sig}
//      th  = SHA-512("jconnect-v2" | clientEph | clientNonce | hostEph | hostNonce | hostKey)[0..32]
//      sig = Ed25519(host identity, "jconnect-v2-server:" + base64(th))
//      keys: X25519(ephemeral) -> SHA-512 per direction, bound to th
// 3. everything after that is a binary frame: counter(8) | XSalsa20-Poly1305(kind(1) | payload)
//      kind 0 = JSON message, kind 1 = stream data: streamId(4) | bytes
//    Frames must arrive in order with consecutive counters, so replayed, reordered or altered frames
//    close the channel.
//
// The client proves who it is inside the channel by signing "jconnect-v2-client:" + base64(th).
// Pairing codes and passwords never cross the network: both sides derive scrypt proofs bound to th.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('tweetnacl'));
  else root.JCSecure = factory(root.nacl);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nacl) {
  'use strict';

  const VERSION = 2;
  const PREFIX = { server: 'jconnect-v2-server:', client: 'jconnect-v2-client:', sdp: 'jconnect-sdp:' };
  const SCRYPT = { N: 32768, r: 8, p: 1, dkLen: 32 };
  const KIND_JSON = 0;
  const KIND_DATA = 1;
  const HANDSHAKE_TIMEOUT_MS = 8000;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const toBytes = (value) => (typeof value === 'string' ? encoder.encode(value) : value);

  function concat(...parts) {
    const list = parts.map(toBytes);
    const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of list) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function unb64(text) {
    const s = atob(String(text));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const hash = (...parts) => nacl.hash(concat(...parts));

  function deviceIdFromKey(publicKeyB64) {
    return hex(nacl.hash(unb64(publicKeyB64))).slice(0, 20);
  }

  function equalBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  const isZero = (bytes) => bytes.every((b) => b === 0);

  function failure(code, extra) {
    const err = new Error(code);
    err.code = code;
    return Object.assign(err, extra);
  }

  function transcriptHash(clientEph, clientNonce, serverEph, serverNonce, serverKey) {
    return hash('jconnect-v2', clientEph, clientNonce, serverEph, serverNonce, serverKey).subarray(0, 32);
  }

  // Six digits both screens can show so a person can confirm they're talking to the right device.
  function shortCode(th) {
    const h = hash('jconnect-v2-sas', th);
    const n = (h[0] * 16777216) + (h[1] << 16) + (h[2] << 8) + h[3];
    return String(n % 1000000).padStart(6, '0');
  }

  const pairSalt = (th) => hash('jconnect-v2-pair', th).subarray(0, 16);
  const passwordProof = (verifier, th) => hash('jconnect-v2-password', verifier, th).subarray(0, 32);
  const normalizeSecret = (secret) => encoder.encode(String(secret).normalize('NFKC'));

  function writeCounter(buf, offset, n) {
    const high = Math.floor(n / 4294967296);
    const low = n >>> 0;
    buf[offset] = high >>> 24; buf[offset + 1] = (high >>> 16) & 255; buf[offset + 2] = (high >>> 8) & 255; buf[offset + 3] = high & 255;
    buf[offset + 4] = low >>> 24; buf[offset + 5] = (low >>> 16) & 255; buf[offset + 6] = (low >>> 8) & 255; buf[offset + 7] = low & 255;
  }

  function readCounter(buf, offset) {
    const high = ((buf[offset] << 24) >>> 0) + (buf[offset + 1] << 16) + (buf[offset + 2] << 8) + buf[offset + 3];
    const low = ((buf[offset + 4] << 24) >>> 0) + (buf[offset + 5] << 16) + (buf[offset + 6] << 8) + buf[offset + 7];
    return high * 4294967296 + low;
  }

  const writeU32 = (buf, offset, n) => { buf[offset] = n >>> 24; buf[offset + 1] = (n >>> 16) & 255; buf[offset + 2] = (n >>> 8) & 255; buf[offset + 3] = n & 255; };
  const readU32 = (buf, offset) => ((buf[offset] << 24) >>> 0) + (buf[offset + 1] << 16) + (buf[offset + 2] << 8) + buf[offset + 3];

  class Sealer {
    constructor(sendKey, recvKey) {
      this.sendKey = sendKey;
      this.recvKey = recvKey;
      this.sendCounter = 0;
      this.recvCounter = 0;
    }

    seal(kind, payload) {
      const plain = new Uint8Array(payload.length + 1);
      plain[0] = kind;
      plain.set(payload, 1);
      const counter = this.sendCounter++;
      const nonce = new Uint8Array(24);
      writeCounter(nonce, 16, counter);
      const box = nacl.secretbox(plain, nonce, this.sendKey);
      const frame = new Uint8Array(8 + box.length);
      writeCounter(frame, 0, counter);
      frame.set(box, 8);
      return frame;
    }

    open(frame) {
      if (frame.length < 8 + nacl.secretbox.overheadLength + 1) throw failure('security');
      const counter = readCounter(frame, 0);
      if (counter !== this.recvCounter) throw failure('security');
      const nonce = new Uint8Array(24);
      nonce.set(frame.subarray(0, 8), 16);
      const plain = nacl.secretbox.open(frame.subarray(8), nonce, this.recvKey);
      if (!plain) throw failure('security');
      this.recvCounter++;
      return { kind: plain[0], payload: plain.subarray(1) };
    }
  }

  // ---- socket adapters: a tiny common shape over browser WebSocket and the Node "ws" package ----

  function fromBrowserSocket(ws) {
    ws.binaryType = 'arraybuffer';
    const adapter = {
      text: null,
      binary: null,
      closed: null,
      sendText: (s) => ws.send(s),
      sendBinary: (bytes) => ws.send(bytes),
      close: (code, reason) => { try { ws.close(code, reason); } catch { /* already closing */ } },
      buffered: () => ws.bufferedAmount,
      whenOpen: () => new Promise((resolve, reject) => {
        if (ws.readyState === 1) resolve();
        else if (ws.readyState > 1) reject(failure('unreachable'));
        else {
          ws.addEventListener('open', () => resolve(), { once: true });
          ws.addEventListener('close', () => reject(failure('unreachable')), { once: true });
        }
      }),
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') { if (adapter.text) adapter.text(e.data); } else if (adapter.binary) adapter.binary(new Uint8Array(e.data));
    };
    ws.onclose = (e) => { if (adapter.closed) adapter.closed(e.code, e.reason); };
    ws.onerror = () => {};
    return adapter;
  }

  function fromNodeSocket(ws) {
    const adapter = {
      text: null,
      binary: null,
      closed: null,
      sendText: (s) => ws.send(s),
      sendBinary: (bytes) => ws.send(bytes, { binary: true }),
      close: (code, reason) => { try { ws.close(code, reason); } catch { /* already closing */ } },
      buffered: () => ws.bufferedAmount,
      whenOpen: () => new Promise((resolve, reject) => {
        if (ws.readyState === 1) resolve();
        else if (ws.readyState > 1) reject(failure('unreachable'));
        else {
          ws.once('open', () => resolve());
          ws.once('close', () => reject(failure('unreachable')));
          ws.once('error', () => reject(failure('unreachable')));
        }
      }),
    };
    ws.on('message', (data, isBinary) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (isBinary) { if (adapter.binary) adapter.binary(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)); } else if (adapter.text) adapter.text(buf.toString('utf8'));
    });
    ws.on('close', (code, reason) => { if (adapter.closed) adapter.closed(code, String(reason || '')); });
    ws.on('error', () => {});
    return adapter;
  }

  // ---- the encrypted channel ----

  class Channel {
    constructor(socket, sealer) {
      this.socket = socket;
      this.sealer = sealer;
      this.listeners = new Map();
      this.waiters = new Set();
      this.isClosed = false;
      this.lastMessageAt = Date.now();
      this.whenClosed = new Promise((resolve) => { this._resolveClosed = resolve; });
      socket.text = () => this.close(4000, 'protocol');
      socket.binary = (bytes) => this._receive(bytes);
      socket.closed = (code, reason) => this._onClose(code, reason);
    }

    _receive(bytes) {
      if (this.isClosed) return;
      let frame;
      try {
        frame = this.sealer.open(bytes);
      } catch {
        this.close(4003, 'security');
        return;
      }
      this.lastMessageAt = Date.now();
      if (frame.kind === KIND_JSON) {
        let msg;
        try { msg = JSON.parse(decoder.decode(frame.payload)); } catch { return; }
        if (!msg || typeof msg.type !== 'string') return;
        for (const waiter of [...this.waiters]) if (waiter.types.includes(msg.type)) waiter.done(msg);
        this._emit(msg.type, msg);
        this._emit('*', msg);
      } else if (frame.kind === KIND_DATA && frame.payload.length >= 4) {
        this._emit('data', readU32(frame.payload, 0), frame.payload.subarray(4));
      }
    }

    _emit(type, ...args) {
      const set = this.listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(...args); } catch (err) { if (typeof console !== 'undefined') console.error(err); }
      }
    }

    _onClose(code, reason) {
      if (this.isClosed) return;
      this.isClosed = true;
      const why = code >= 4000 && reason ? reason : 'closed';
      for (const waiter of [...this.waiters]) waiter.fail(failure(why));
      this._emit('closed', { code, reason });
      this._resolveClosed({ code, reason });
    }

    on(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
      return () => this.listeners.get(type).delete(fn);
    }

    next(types, timeoutMs = 15000) {
      if (this.isClosed) return Promise.reject(failure('closed'));
      const list = Array.isArray(types) ? types : [types];
      return new Promise((resolve, reject) => {
        const waiter = { types: list };
        const finish = () => { clearTimeout(waiter.timer); this.waiters.delete(waiter); };
        waiter.done = (msg) => { finish(); resolve(msg); };
        waiter.fail = (err) => { finish(); reject(err); };
        if (timeoutMs) waiter.timer = setTimeout(() => waiter.fail(failure('timeout')), timeoutMs);
        this.waiters.add(waiter);
      });
    }

    send(type, data = {}) {
      if (this.isClosed) return false;
      try {
        this.socket.sendBinary(this.sealer.seal(KIND_JSON, encoder.encode(JSON.stringify({ ...data, type }))));
        return true;
      } catch {
        return false;
      }
    }

    sendData(streamId, bytes) {
      if (this.isClosed) return false;
      // A big write goes out as several frames, so no frame is larger than the other side accepts. The frames
      // arrive in order, so the other side just joins them back up.
      const MAX_DATA_FRAME = 256 * 1024;
      try {
        for (let offset = 0; offset === 0 || offset < bytes.length; offset += MAX_DATA_FRAME) {
          const piece = bytes.subarray(offset, offset + MAX_DATA_FRAME);
          const payload = new Uint8Array(4 + piece.length);
          writeU32(payload, 0, streamId);
          payload.set(piece, 4);
          this.socket.sendBinary(this.sealer.seal(KIND_DATA, payload));
        }
        return true;
      } catch {
        return false;
      }
    }

    buffered() { return this.socket.buffered ? this.socket.buffered() : 0; }

    close(code = 1000, reason = '') {
      this.socket.close(code, reason);
      if (code >= 4000) this._onClose(code, reason);
    }
  }

  // ---- handshake ----

  // Encrypted frames can arrive right behind the hello, before the keys exist, so a few are kept for later.
  // More than that doesn't come from a real peer, so it ends the connection instead of filling memory.
  const EARLY_FRAMES = 32;
  const EARLY_BYTES = 256 * 1024;

  function readHello(socket, timeoutMs, early) {
    return new Promise((resolve, reject) => {
      let earlyBytes = 0;
      const timer = setTimeout(() => {
        socket.close(4000, 'timeout');
        reject(failure('unreachable'));
      }, timeoutMs);
      socket.binary = (bytes) => {
        earlyBytes += bytes.length;
        if (early.length >= EARLY_FRAMES || earlyBytes > EARLY_BYTES) {
          clearTimeout(timer);
          socket.close(4000, 'protocol');
          reject(failure('protocol'));
          return;
        }
        early.push(bytes);
      };
      socket.closed = (code, reason) => {
        clearTimeout(timer);
        reject(failure(code >= 4000 && reason ? reason : 'unreachable'));
      };
      socket.text = (text) => {
        clearTimeout(timer);
        socket.text = null;
        try { resolve(JSON.parse(text)); } catch { reject(failure('protocol')); }
      };
    });
  }

  async function connect(socket, { verify, expectedKey = null, timeoutMs = HANDSHAKE_TIMEOUT_MS } = {}) {
    const eph = nacl.box.keyPair();
    const nonce = nacl.randomBytes(24);
    const early = [];
    const helloPromise = readHello(socket, timeoutMs, early);
    helloPromise.catch(() => {}); // observed below; avoids an unhandled rejection if the socket never opens
    try {
      await socket.whenOpen();
    } catch {
      throw failure('unreachable');
    }
    socket.sendText(JSON.stringify({ type: 'client-hello', v: VERSION, eph: b64(eph.publicKey), nonce: b64(nonce) }));
    const hello = await helloPromise;

    if (!hello || hello.type !== 'server-hello') {
      socket.close(1000, '');
      throw failure(hello && hello.reason === 'upgrade' ? 'outdated' : 'protocol');
    }
    let serverEph;
    let serverNonce;
    let serverKey;
    try {
      serverEph = unb64(hello.eph);
      serverNonce = unb64(hello.nonce);
      serverKey = unb64(hello.publicKey);
    } catch {
      throw failure('protocol');
    }
    if (hello.v !== VERSION || serverEph.length !== 32 || serverNonce.length !== 24 || serverKey.length !== 32) {
      socket.close(1000, '');
      throw failure('protocol');
    }
    if (deviceIdFromKey(hello.publicKey) !== hello.id || (expectedKey && expectedKey !== hello.publicKey)) {
      socket.close(1000, '');
      throw failure('identity');
    }
    const th = transcriptHash(eph.publicKey, nonce, serverEph, serverNonce, serverKey);
    const thB64 = b64(th);
    if (!(await verify(PREFIX.server + thB64, hello.sig, hello.publicKey))) {
      socket.close(1000, '');
      throw failure('security');
    }
    const shared = nacl.scalarMult(eph.secretKey, serverEph);
    if (isZero(shared)) {
      socket.close(1000, '');
      throw failure('security');
    }
    const c2s = hash('jconnect-v2-c2s', shared, th).subarray(0, 32);
    const s2c = hash('jconnect-v2-s2c', shared, th).subarray(0, 32);

    const channel = new Channel(socket, new Sealer(c2s, s2c));
    Object.assign(channel, { hello, th, thB64, sas: shortCode(th) });
    const welcome = channel.next(['welcome'], timeoutMs);
    for (const bytes of early.splice(0)) channel._receive(bytes);
    channel.welcome = await welcome;
    return channel;
  }

  function accept(socket, { id, publicKey, sign, info = {}, timeoutMs = HANDSHAKE_TIMEOUT_MS }) {
    const early = [];
    return readHello(socket, timeoutMs, early).then(async (msg) => {
      if (!msg || msg.type !== 'client-hello' || msg.v !== VERSION) {
        try { socket.sendText(JSON.stringify({ type: 'error', reason: 'upgrade', v: VERSION })); } catch { /* closing */ }
        socket.close(4000, 'upgrade');
        throw failure('protocol');
      }
      let clientEph;
      let clientNonce;
      try {
        clientEph = unb64(msg.eph);
        clientNonce = unb64(msg.nonce);
      } catch {
        socket.close(4000, 'protocol');
        throw failure('protocol');
      }
      if (clientEph.length !== 32 || clientNonce.length !== 24) {
        socket.close(4000, 'protocol');
        throw failure('protocol');
      }
      const eph = nacl.box.keyPair();
      const nonce = nacl.randomBytes(24);
      const th = transcriptHash(clientEph, clientNonce, eph.publicKey, nonce, unb64(publicKey));
      const shared = nacl.scalarMult(eph.secretKey, clientEph);
      if (isZero(shared)) {
        socket.close(4003, 'security');
        throw failure('security');
      }
      const c2s = hash('jconnect-v2-c2s', shared, th).subarray(0, 32);
      const s2c = hash('jconnect-v2-s2c', shared, th).subarray(0, 32);
      const thB64 = b64(th);
      const sig = await sign(PREFIX.server + thB64);
      const channel = new Channel(socket, new Sealer(s2c, c2s));
      Object.assign(channel, { th, thB64, sas: shortCode(th) });
      socket.sendText(JSON.stringify({
        ...info, type: 'server-hello', v: VERSION, id, publicKey, eph: b64(eph.publicKey), nonce: b64(nonce), sig,
      }));
      for (const bytes of early.splice(0)) channel._receive(bytes);
      return channel;
    });
  }

  // ---- client helpers used after the handshake ----

  // derive(secretBytes, saltBytes) -> Promise<Uint8Array(32)> runs scrypt with SCRYPT parameters.
  async function authenticate(channel, { identity, password, derive }) {
    const sig = await identity.sign(PREFIX.client + channel.thB64);
    let proof;
    if (password != null && password !== '' && channel.welcome && channel.welcome.passwordSalt) {
      const verifier = await derive(normalizeSecret(password), unb64(channel.welcome.passwordSalt));
      proof = b64(passwordProof(verifier, channel.th));
    }
    const reply = channel.next(['auth-ok', 'auth-fail'], 20000);
    channel.send('auth', { name: identity.name, os: identity.os, publicKey: identity.publicKey, sig, password: proof });
    const res = await reply;
    if (res.type === 'auth-fail') return { ok: false, reason: res.reason, canPair: !!res.canPair };
    return { ok: true, ...res };
  }

  async function pair(channel, { code, derive, onPending }) {
    let proof;
    if (code != null) {
      const digits = String(code).replace(/\D/g, '');
      proof = b64(await derive(normalizeSecret(digits), pairSalt(channel.th)));
    }
    let reply = channel.next(['pair-result'], proof ? 30000 : 130000);
    channel.send('pair', proof ? { proof } : {});
    for (;;) {
      const res = await reply;
      if (res.pending) {
        reply = channel.next(['pair-result'], 130000);
        if (onPending) onPending(channel.sas);
        continue;
      }
      return res;
    }
  }

  return {
    VERSION, PREFIX, SCRYPT, Channel, Sealer,
    connect, accept, authenticate, pair,
    fromBrowserSocket, fromNodeSocket,
    b64, unb64, hash, equalBytes, deviceIdFromKey, shortCode, pairSalt, passwordProof, normalizeSecret, failure,
  };
});
