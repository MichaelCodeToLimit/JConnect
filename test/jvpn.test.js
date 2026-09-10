// JVPN end to end: encrypted streams from one device to a service on another computer, directly and
// through JConnect Cloud's relay.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const nacl = require('tweetnacl');

process.env.JCONNECT_CLOUD_QUIET = '1';
process.env.JCONNECT_RELAY_QUIET = '1';

const { HostAgent } = require('../src/main/host');
const { Security } = require('../src/main/security');
const { RelayLink, JvpnClient, wsBase } = require('../src/main/jvpn');
const JCSecure = require('../src/shared/secure-channel');
const { createCloud } = require('../server/cloud/cloud');

const b64 = (u8) => Buffer.from(u8).toString('base64');

class FakeStore extends EventEmitter {
  constructor(name) {
    super();
    this.keyPair = nacl.sign.keyPair();
    this.publicKey = b64(this.keyPair.publicKey);
    this.id = JCSecure.deviceIdFromKey(this.publicKey);
    this.name = name;
    this.data = {
      settings: { remoteAccess: true, travelMode: false, travelOwnerOnly: true, allowBrowserClients: true, shareSsh: true, sshPort: 0, shareRdp: false, jvpnEnabled: true },
      trusted: [], computers: [], securityLog: [], lockdown: null,
    };
  }
  get settings() { return this.data.settings; }
  device() { return { id: this.id, name: this.name, os: 'Test OS', publicKey: this.publicKey }; }
  sign(text) { return b64(nacl.sign.detached(Buffer.from(String(text), 'utf8'), this.keyPair.secretKey)); }
  update(fn) { fn(this.data); }
  log(entry) { this.data.securityLog.unshift(entry); }
  findTrusted(key) { return this.data.trusted.find((t) => t.publicKey === key) || null; }
  addTrusted(d) { this.data.trusted.push({ permission: 'control', owner: true, ...d }); }
  updateTrusted() {}
  removeTrusted() {}
  passwordSalt() { return null; }
}

const capture = Object.assign(new EventEmitter(), { displays: () => [], start: async () => {}, stop() {}, signal() {}, setQuality() {}, setDisplay() {} });

async function echoServer(t) {
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return server.address().port;
}

async function startPair(t) {
  const hostStore = new FakeStore('Home PC');
  hostStore.data.settings.sshPort = await echoServer(t);
  const agent = new HostAgent({ store: hostStore, security: new Security(hostStore), input: { available: true, handle() {}, release() {} }, capture });
  await agent.listen(0);
  t.after(() => agent.close());
  const clientStore = new FakeStore('Laptop');
  const computer = { id: hostStore.id, publicKey: hostStore.publicKey, name: 'Home PC' };
  return { hostStore, agent, clientStore, computer };
}

function roundTrip(stream, payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= payload.length) resolve(Buffer.concat(chunks));
    });
    stream.on('error', reject);
    stream.write(payload);
  });
}

test('a trusted device reaches a shared service through an encrypted stream', async (t) => {
  const { agent, hostStore, clientStore, computer } = await startPair(t);
  hostStore.addTrusted({ id: clientStore.id, name: 'Laptop', publicKey: clientStore.publicKey });
  const client = new JvpnClient({ store: clientStore, resolveRoute: async () => ({ url: `ws://127.0.0.1:${agent.port}/ws`, kind: 'lan' }) });
  t.after(() => client.closeAll());

  const stream = await client.openStream(computer, 'ssh');
  const payload = crypto.randomBytes(3 * 1024 * 1024);
  const echoed = await roundTrip(stream, payload);
  assert.ok(echoed.equals(payload), '3 MB echoed back intact');
  stream.destroy();

  const forward = await client.forward(computer, 'ssh');
  t.after(() => forward.close());
  const socket = net.connect(forward.port, '127.0.0.1');
  await new Promise((r) => socket.once('connect', r));
  assert.strictEqual((await roundTrip(socket, Buffer.from('hello through JVPN'))).toString(), 'hello through JVPN');
  socket.destroy();

  await assert.rejects(client.openStream(computer, 'rdp'), { code: 'not-shared' });
});

test('devices that were never paired cannot open streams', async (t) => {
  const { agent, clientStore, computer } = await startPair(t);
  const client = new JvpnClient({ store: clientStore, resolveRoute: async () => ({ url: `ws://127.0.0.1:${agent.port}/ws`, kind: 'lan' }) });
  await assert.rejects(client.openStream(computer, 'ssh'), { code: 'untrusted' });
});

test('through JConnect Cloud: the computer stays reachable via the relay and streams stay end to end', async (t) => {
  const { agent, hostStore, clientStore, computer } = await startPair(t);
  hostStore.addTrusted({ id: clientStore.id, name: 'Laptop', publicKey: clientStore.publicKey });

  const cloud = createCloud({ port: 0, host: '127.0.0.1', dataFile: null, stun: [] });
  const port = await cloud.listen();
  t.after(() => cloud.close());
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
    return res.json();
  };
  const signup = await call('POST', '/v1/signup', null, { email: 'me@example.com', salt: b64(crypto.randomBytes(16)), authKey: b64(crypto.randomBytes(32)) });
  for (const store of [hostStore, clientStore]) {
    const ts = Date.now();
    await call('POST', '/v1/devices', signup.token, { id: store.id, publicKey: store.publicKey, ts, sig: store.sign(`jconnect-cloud-device:${store.id}:${signup.userId}:${ts}`) });
  }

  const link = new RelayLink({ store: hostStore, host: agent, cloud: () => ({ url: base, token: signup.token }) });
  t.after(() => link.stop());
  const online = new Promise((resolve) => link.on('change', (s) => { if (s.state === 'online') resolve(); }));
  link.start();
  await online;

  const resolveRoute = async () => {
    const { ticket } = await call('POST', '/v1/relay/ticket', signup.token, { to: computer.id });
    return { url: `${wsBase(base)}/connect?to=${computer.id}&ticket=${ticket}`, kind: 'jvpn' };
  };
  const client = new JvpnClient({ store: clientStore, resolveRoute });
  t.after(() => client.closeAll());
  const stream = await client.openStream(computer, 'ssh');
  const payload = crypto.randomBytes(512 * 1024);
  assert.ok((await roundTrip(stream, payload)).equals(payload));
  assert.strictEqual(client.entries.get(computer.id).route.kind, 'jvpn');
  assert.ok(hostStore.data.securityLog.some((e) => e.kind === 'stream'), 'the computer logged the JVPN stream');
});
