// Runs the real host agent (src/main/host.js + security.js) against the real web client scripts
// (src/web/identity.js + connection.js) loaded into a browser-like sandbox. Media is faked; everything
// about pairing, trust, signatures and session negotiation is real.
//   node --test src/web/test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const nacl = require('tweetnacl');
const { WebSocket } = require('ws');

const { HostAgent } = require('../../main/host');
const { Security } = require('../../main/security');
const { deviceIdFromKey } = require('../../main/store');

const WEB = path.join(__dirname, '..');
const b64 = (u8) => Buffer.from(u8).toString('base64');
const FAKE_OFFER = 'v=0\r\no=- 42 2 IN IP4 127.0.0.1\r\ns=jconnect-test-offer\r\nt=0 0\r\n';

class FakeStore extends EventEmitter {
  constructor() {
    super();
    this.keyPair = nacl.sign.keyPair();
    this.publicKey = b64(this.keyPair.publicKey);
    this.id = deviceIdFromKey(this.publicKey);
    this.password = null;
    this.data = {
      settings: { remoteAccess: true, requirePassword: false, passwordHash: null, travelMode: false, travelOwnerOnly: true, emergencyShutdown: false },
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
  checkPassword(pw) { return pw === this.password; }
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
  const port = agent.server.address().port;
  t.after(() => agent.close());
  return { store, security, capture, agent, port };
}

class FakePC {
  constructor() {
    FakePC.instances.push(this);
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
  for (const file of ['vendor/nacl-fast.min.js', 'identity.js', 'connection.js']) {
    vm.runInContext(fs.readFileSync(path.join(WEB, file), 'utf8'), ctx, { filename: file });
  }
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

function waitForState(states, wanted, ms = 3000) {
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

test('without a code, the computer asks its owner, and "Cancel" is respected', async (t) => {
  const host = await startHost(t);
  const asked = [];
  host.agent.askOwner = async (device) => { asked.push(device.name); return { allow: asked.length > 1 }; };

  const client = loadClient(host.port);
  client.JCIdentity.rename("Michael's phone");
  const conn = client.JCConnection;
  const target = { host: '127.0.0.1', port: host.port };
  const info = await conn.hostInfo(target);

  await rejectsWith(conn.pair(target, info, null), 'denied');
  const computer = await conn.pair(target, info, null);
  assert.strictEqual(computer.id, host.store.id);
  assert.deepStrictEqual(asked, ["Michael's phone", "Michael's phone"]);
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
