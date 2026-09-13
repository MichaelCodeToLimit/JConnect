// Runs the real host agent (src/main/host.js + security.js) against the real web client scripts
// (src/web/identity.js + connection.js + src/shared/secure-channel.js) loaded into a browser-like
// sandbox. Media is faked; pairing, trust, encryption, proofs and session negotiation are real.
//   node --test src/web/test/connection.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const nacl = require('tweetnacl');
const { WebSocket } = require('ws');

const { HostAgent } = require('../../main/host');
const { Security } = require('../../main/security');
const { deviceIdFromKey } = require('../../main/store');
const JCSecure = require('../../shared/secure-channel');

const WEB = path.join(__dirname, '..');
const b64 = (u8) => Buffer.from(u8).toString('base64');
const FAKE_OFFER = 'v=0\r\no=- 42 2 IN IP4 127.0.0.1\r\ns=jconnect-test-offer\r\nt=0 0\r\n';

class FakeStore extends EventEmitter {
  constructor() {
    super();
    this.keyPair = nacl.sign.keyPair();
    this.publicKey = b64(this.keyPair.publicKey);
    this.id = deviceIdFromKey(this.publicKey);
    this.data = {
      settings: {
        remoteAccess: true, requirePassword: false, passwordHash: null, travelMode: false, travelOwnerOnly: true,
        emergencyShutdown: false, allowBrowserClients: true, accountTrust: false, shareSsh: false, shareRdp: false,
      },
      trusted: [],
      computers: [],
      securityLog: [],
      lockdown: null,
    };
  }
  get settings() { return this.data.settings; }
  device() { return { id: this.id, name: 'Family PC', os: 'Windows 11', publicKey: this.publicKey }; }
  sign(text) { return b64(nacl.sign.detached(Buffer.from(String(text), 'utf8'), this.keyPair.secretKey)); }
  update(mutator) { mutator(this.data); this.emit('change'); }
  log(entry) { this.data.securityLog.unshift({ at: Date.now(), ...entry }); }
  findTrusted(publicKey) { return this.data.trusted.find((t) => t.publicKey === publicKey) || null; }
  addTrusted(device) {
    this.data.trusted = this.data.trusted.filter((t) => t.publicKey !== device.publicKey);
    this.data.trusted.push({ permission: 'control', owner: false, pairedAt: Date.now(), ...device });
  }
  updateTrusted(id, patch) { const t = this.data.trusted.find((x) => x.id === id); if (t) Object.assign(t, patch); }
  removeTrusted(id) { this.data.trusted = this.data.trusted.filter((t) => t.id !== id); }
  setPassword(password) {
    const salt = crypto.randomBytes(16);
    const verifier = crypto.scryptSync(Buffer.from(JCSecure.normalizeSecret(password)), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    this.data.settings.passwordHash = `v2:${salt.toString('base64')}:${verifier.toString('base64')}`;
    this.data.settings.requirePassword = true;
  }
  passwordSalt() { return String(this.settings.passwordHash || '').split(':')[1] || null; }
  checkPasswordProof(proof, th) {
    const parts = String(this.settings.passwordHash || '').split(':');
    const expected = Buffer.from(JCSecure.passwordProof(new Uint8Array(Buffer.from(parts[2], 'base64')), th));
    const given = Buffer.from(String(proof), 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }
}

class FakeCapture extends EventEmitter {
  constructor() { super(); this.signals = []; this.autoOffer = true; }
  displays() { return [{ id: '1', name: 'Display 1', primary: true, width: 1920, height: 1080 }]; }
  async start(sid) { this.sid = sid; if (this.autoOffer) setImmediate(() => this.emit('offer', sid, FAKE_OFFER)); }
  signal(sid, data) { this.signals.push(data); this.emit('signal', data); }
  stop() {}
  setQuality() {}
  setDisplay() {}
}

async function startHost(t) {
  const store = new FakeStore();
  const security = new Security(store);
  const capture = new FakeCapture();
  const input = { available: true, handle() {}, release() {} };
  const agent = new HostAgent({ store, security, input, capture });
  agent.askOwner = async () => ({ allow: false });
  await agent.listen(0);
  const { port } = agent;
  t.after(() => agent.close());
  return { store, security, capture, agent, port };
}

class FakePC {
  constructor(config) {
    FakePC.instances.push(this);
    this.config = config;
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = 'new';
  }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\no=- 7 2 IN IP4 127.0.0.1\r\ns=jconnect-test-answer\r\nt=0 0\r\n' }; }
  async setLocalDescription(d) {
    this.localDescription = d;
    setTimeout(() => { this.connectionState = 'connected'; if (this.onconnectionstatechange) this.onconnectionstatechange(); }, 5);
  }
  addIceCandidate() { return Promise.resolve(); }
  close() { this.connectionState = 'closed'; }
}
FakePC.instances = [];

// A fresh "phone": its own localStorage, identity and page location.
function loadClient(port, { search = '' } = {}) {
  const storage = new Map();
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    TextEncoder, TextDecoder, URLSearchParams, AbortController, btoa, atob,
    crypto: globalThis.crypto,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile', maxTouchPoints: 5 },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    location: { protocol: 'http:', hostname: '127.0.0.1', port: String(port), search, hash: '', pathname: '/' },
    WebSocket,
    RTCPeerConnection: FakePC,
    MediaStream: class {},
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  // Typed arrays must come from the sandbox's own realm, or tweetnacl's instanceof checks fail.
  // (In a real browser there is only one realm, so this is purely a test-harness concern.)
  ctx.__outerEncode = (s) => Array.from(new TextEncoder().encode(String(s)));
  vm.runInContext('self.TextEncoder = class { encode(s) { return new Uint8Array(__outerEncode(s)); } };', ctx);
  const files = [
    path.join(WEB, 'vendor', 'nacl-fast.min.js'),
    path.join(WEB, 'vendor', 'scrypt.js'),
    path.join(WEB, '..', 'shared', 'secure-channel.js'),
    path.join(WEB, 'identity.js'),
    path.join(WEB, 'connection.js'),
  ];
  for (const file of files) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: path.basename(file) });
  return ctx;
}

async function rejectsWith(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.strictEqual(err.code, code, `expected ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  assert.fail(`expected rejection with ${code}`);
}

async function pairWithCode(client, host) {
  const conn = client.JCConnection;
  const target = { host: '127.0.0.1', port: host.port, code: host.agent.pairingCode };
  const info = await conn.hostInfo(target);
  return conn.pair(target, info, host.agent.pairingCode);
}

function waitForState(states, wanted, ms = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = states.find((s) => s.state === wanted);
      if (hit) return resolve(hit);
      if (Date.now() - started > ms) return reject(new Error(`no "${wanted}" state; saw ${states.map((s) => s.state).join(', ')}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('QR link is parsed into a pairing target', async (t) => {
  const host = await startHost(t);
  const key = host.store.publicKey.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const client = loadClient(host.port, { search: `?code=482193&id=${host.store.id}&k=${key}` });
  const target = client.JCConnection.pairTargetFromLocation(client.location);
  assert.strictEqual(target.host, '127.0.0.1');
  assert.strictEqual(target.port, host.port);
  assert.strictEqual(target.code, '482193');
  assert.strictEqual(target.id, host.store.id);
  assert.strictEqual(target.publicKey, host.store.publicKey);
  assert.strictEqual(client.JCConnection.pairTargetFromLocation({ ...client.location, search: '' }), null);
});

test('scanning the code pairs the phone, and the first paired device becomes the owner', async (t) => {
  const host = await startHost(t);
  const client = loadClient(host.port);
  const computer = await pairWithCode(client, host);

  assert.strictEqual(computer.id, host.store.id);
  assert.strictEqual(computer.publicKey, host.store.publicKey);
  assert.strictEqual(computer.name, 'Family PC');
  assert.deepStrictEqual({ ...computer.addresses[0] }, { host: '127.0.0.1', port: host.port }); // copy out of the sandbox realm

  const trusted = host.store.data.trusted;
  assert.strictEqual(trusted.length, 1);
  assert.strictEqual(trusted[0].id, client.JCIdentity.id);
  assert.strictEqual(trusted[0].publicKey, client.JCIdentity.publicKey);
  assert.strictEqual(trusted[0].name, 'Android phone');
  assert.strictEqual(trusted[0].owner, true);

  // Pairing again when already trusted just succeeds.
  const again = await pairWithCode(client, host);
  assert.strictEqual(again.id, host.store.id);
});

test('without a code, the computer asks its owner with a matching verification code, and "Cancel" is respected', async (t) => {
  const host = await startHost(t);
  const asked = [];
  host.agent.askOwner = async (device) => { asked.push(device); return { allow: asked.length > 1 }; };

  const client = loadClient(host.port);
  client.JCIdentity.rename("Michael's phone");
  const conn = client.JCConnection;
  const target = { host: '127.0.0.1', port: host.port };
  const info = await conn.hostInfo(target);

  await rejectsWith(conn.pair(target, info, null), 'denied');
  const shown = [];
  const computer = await conn.pair(target, info, null, { onPending: (sas) => shown.push(sas) });
  assert.strictEqual(computer.id, host.store.id);
  assert.deepStrictEqual(asked.map((d) => d.name), ["Michael's phone", "Michael's phone"]);
  assert.match(asked[1].sas, /^\d{6}$/);
  assert.deepStrictEqual(shown, [asked[1].sas], 'phone and computer show the same code');
  assert.strictEqual(host.store.data.trusted[0].owner, false);
});

test('a wrong code is refused and logged', async (t) => {
  const host = await startHost(t);
  const client = loadClient(host.port);
  const conn = client.JCConnection;
  const target = { host: '127.0.0.1', port: host.port };
  const info = await conn.hostInfo(target);
  const wrong = host.agent.pairingCode === '000000' ? '111111' : '000000';

  await rejectsWith(conn.pair(target, info, wrong), 'bad-code');
  assert.strictEqual(host.store.data.trusted.length, 0);
  assert.strictEqual(host.store.data.securityLog[0].kind, 'bad-code');
});

test('a QR code for a different computer is caught before trusting anything', async (t) => {
  const host = await startHost(t);
  const client = loadClient(host.port);
  const other = b64(nacl.sign.keyPair().publicKey);
  await rejectsWith(client.JCConnection.hostInfo({ host: '127.0.0.1', port: host.port, publicKey: other }), 'host-changed');
});

test('Travel Mode turns away devices that were never paired', async (t) => {
  const host = await startHost(t);
  host.store.data.settings.travelMode = true;
  const client = loadClient(host.port);
  const conn = client.JCConnection;
  const target = { host: '127.0.0.1', port: host.port };
  const info = await conn.hostInfo(target);
  await rejectsWith(conn.pair(target, info, host.agent.pairingCode), 'travel');
  assert.strictEqual(host.store.data.trusted.length, 0);
  assert.strictEqual(host.store.data.securityLog[0].kind, 'unknown-device');
});

test('Connect negotiates a session with signed offer and answer', async (t) => {
  const host = await startHost(t);
  const client = loadClient(host.port);
  const computer = await pairWithCode(client, host);

  const states = [];
  const session = client.JCConnection.connect(computer, { onStream() {}, onState: (s) => states.push(s) });
  t.after(() => session.close());

  const connected = await waitForState(states, 'connected');
  assert.strictEqual(connected.viewOnly, false);

  const answer = host.capture.signals.find((s) => s.type === 'answer');
  assert.ok(answer, 'host received the answer');
  assert.match(answer.sdp, /jconnect-test-answer/);
  assert.strictEqual(host.agent.sessionList().length, 1);
  assert.strictEqual(host.agent.sessionList()[0].deviceId, client.JCIdentity.id);
  assert.strictEqual(FakePC.instances.at(-1).remoteDescription.sdp, FAKE_OFFER);
});

test('a password-protected computer accepts the right password proof and rejects a wrong one', async (t) => {
  const host = await startHost(t);
  const client = loadClient(host.port);
  const computer = await pairWithCode(client, host);
  host.store.setPassword('open sesame');

  const states = [];
  const session = client.JCConnection.connect(computer, { onStream() {}, onState: (s) => states.push(s) });
  t.after(() => session.close());

  await waitForState(states, 'password');
  states.length = 0;
  session.providePassword('wrong guess');
  const wrong = await waitForState(states, 'password', 15000);
  assert.strictEqual(wrong.wrong, true);
  assert.strictEqual(host.store.data.securityLog[0].kind, 'bad-password');

  states.length = 0;
  session.providePassword('open sesame');
  await waitForState(states, 'connected', 15000);
});

test('an offer that is not signed by the paired computer stops the session', async (t) => {
  const host = await startHost(t);
  host.capture.autoOffer = false;
  const client = loadClient(host.port);
  const computer = await pairWithCode(client, host);

  const states = [];
  const session = client.JCConnection.connect(computer, { onStream() {}, onState: (s) => states.push(s) });
  t.after(() => session.close());

  // Wait for the host to open the session, then inject an offer signed by someone else.
  const started = Date.now();
  while (!host.agent.sessionList().length && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 10));
  const conn = [...host.agent.conns.values()].find((c) => c.sessionId);
  const impostor = nacl.sign.keyPair();
  host.agent._send(conn, 'offer', { sdp: FAKE_OFFER, sig: b64(nacl.sign.detached(Buffer.from(`jconnect-sdp:${FAKE_OFFER}`), impostor.secretKey)) });

  const ended = await waitForState(states, 'ended');
  assert.strictEqual(ended.code, 'host-changed');
  assert.ok(!states.some((s) => s.state === 'connected'));
});

test('the owner phone can restore remote access after an emergency lockdown', async (t) => {
  const host = await startHost(t);
  const client = loadClient(host.port);
  const computer = await pairWithCode(client, host);
  assert.strictEqual(host.store.data.trusted[0].owner, true);

  const level = host.security.report('impersonation', { ip: '10.0.0.66', deviceName: 'Unknown' });
  assert.strictEqual(level, 'high');
  assert.ok(host.store.data.lockdown, 'computer is locked down');

  // While locked, Connect reports the lockdown instead of starting a session.
  const states = [];
  const session = client.JCConnection.connect(computer, { onStream() {}, onState: (s) => states.push(s) });
  const locked = await waitForState(states, 'lockdown');
  assert.strictEqual(locked.canRestore, true);
  session.close();

  await client.JCConnection.securityAction(computer, 'restore');
  assert.strictEqual(host.store.data.lockdown, null);
});

test('status reports a reachable computer as ready and an unknown address as offline', async (t) => {
  const host = await startHost(t);
  const client = loadClient(host.port);
  const computer = await pairWithCode(client, host);
  assert.deepStrictEqual({ ...(await client.JCConnection.status(computer)) }, { state: 'ready' });
  const gone = { ...computer, addresses: [{ host: '127.0.0.1', port: 1 }] };
  client.location.port = '1';
  assert.deepStrictEqual({ ...(await client.JCConnection.status(gone)) }, { state: 'offline' });
});

test('terminating tells a connected phone that the session was ended and closes everything', async (t) => {
  const host = await startHost(t);
  const client = loadClient(host.port);
  const computer = await pairWithCode(client, host);
  const states = [];
  const session = client.JCConnection.connect(computer, { onStream() {}, onState: (s) => states.push(s) });
  t.after(() => session.close());
  await waitForState(states, 'connected');

  host.agent.endAll('ended-by-owner');
  const ended = await waitForState(states, 'ended');
  assert.strictEqual(ended.code, 'ended-by-owner');
  const started = Date.now();
  while (host.agent.conns.size && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(host.agent.conns.size, 0);
  assert.strictEqual(host.agent.sessionList().length, 0);
});

test('the computer refuses WebSocket connections from other websites', async (t) => {
  const host = await startHost(t);
  const url = `ws://127.0.0.1:${host.port}/ws`;
  const attempt = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.once('open', () => { ws.terminate(); resolve('open'); });
    ws.once('unexpected-response', (req, res) => { req.destroy(); resolve(res.statusCode); });
    ws.once('error', () => {});
  });
  assert.strictEqual(await attempt('http://evil.example'), 401);
  assert.strictEqual(await attempt('null'), 401, 'sandboxed frames');
  assert.strictEqual(await attempt(`http://127.0.0.1:${host.port}`), 'open', 'the phone page this computer serves');
  assert.strictEqual(await attempt('file://'), 'open', 'the desktop app');
  assert.strictEqual(await attempt('http://localhost'), 'open', 'the Android app');
  assert.strictEqual(await attempt(null), 'open', 'apps without a browser engine');
});

test('connections that never sign in are limited', async (t) => {
  const host = await startHost(t);
  const url = `ws://127.0.0.1:${host.port}/ws`;
  const sockets = [];
  try {
    for (let i = 0; i < 16; i++) {
      const ws = new WebSocket(url);
      sockets.push(ws);
      await new Promise((resolve) => ws.once('open', resolve));
    }
    const extra = new WebSocket(url);
    sockets.push(extra);
    assert.strictEqual(await new Promise((resolve) => extra.once('close', (code) => resolve(code))), 1013);

    // Once one of them goes away, the next connection is accepted.
    sockets[0].terminate();
    const started = Date.now();
    while (host.agent.pendingTotal >= 16 && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 10));
    const again = new WebSocket(url);
    sockets.push(again);
    await new Promise((resolve) => again.once('open', resolve));
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(again.readyState, WebSocket.OPEN);
  } finally {
    for (const ws of sockets) ws.terminate();
  }
});
