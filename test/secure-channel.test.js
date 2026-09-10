// Protocol v2 secure channel: handshake, confidentiality/integrity, identity pinning and proofs.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const { WebSocketServer, WebSocket } = require('ws');
const JCSecure = require('../src/shared/secure-channel');
const scryptJs = require('scrypt-js');

const b64 = (u8) => Buffer.from(u8).toString('base64');

function identity(name) {
  const keyPair = nacl.sign.keyPair();
  const publicKey = b64(keyPair.publicKey);
  return {
    keyPair,
    publicKey,
    id: JCSecure.deviceIdFromKey(publicKey),
    name,
    os: 'Test OS',
    sign: (text) => b64(nacl.sign.detached(Buffer.from(text, 'utf8'), keyPair.secretKey)),
  };
}

const verify = async (text, sig, key) => {
  try {
    return nacl.sign.detached.verify(Buffer.from(text, 'utf8'), Buffer.from(sig, 'base64'), Buffer.from(key, 'base64'));
  } catch {
    return false;
  }
};

const derive = (secret, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(Buffer.from(secret), Buffer.from(salt), 32, { N: 32768, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(new Uint8Array(k))));
});

async function server(t, onChannel, { host = identity('Host') } = {}) {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const raw = [];
  wss.on('connection', (ws) => {
    raw.push(ws);
    JCSecure.accept(JCSecure.fromNodeSocket(ws), { id: host.id, publicKey: host.publicKey, sign: host.sign, info: { name: host.name } })
      .then((channel) => {
        channel.send('welcome', { passwordSalt: b64(Buffer.alloc(16, 7)) });
        onChannel(channel, ws);
      })
      .catch(() => {});
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  t.after(() => { for (const ws of raw) ws.terminate(); wss.close(); httpServer.close(); });
  return { host, url: `ws://127.0.0.1:${httpServer.address().port}`, raw };
}

const open = (url) => JCSecure.fromNodeSocket(new WebSocket(url));

test('handshake establishes an encrypted channel both ways and agrees on the short code', async (t) => {
  let hostChannel;
  const { host, url } = await server(t, (channel) => {
    hostChannel = channel;
    channel.on('echo', (msg) => channel.send('echoed', { text: msg.text }));
  });
  const client = await JCSecure.connect(open(url), { verify, expectedKey: host.publicKey });
  assert.strictEqual(client.hello.id, host.id);
  assert.ok(client.welcome.passwordSalt);
  const reply = client.next('echoed');
  client.send('echo', { text: 'hello over v2' });
  assert.strictEqual((await reply).text, 'hello over v2');
  assert.strictEqual(client.sas, hostChannel.sas);
  assert.match(client.sas, /^\d{6}$/);
  client.close();
});

test('nothing readable crosses the wire after the hello', async (t) => {
  const seen = [];
  const { url } = await server(t, (channel, ws) => {
    ws.on('message', (data) => seen.push(Buffer.from(data)));
    channel.on('secret', () => channel.send('ok'));
  });
  const client = await JCSecure.connect(open(url), { verify });
  const reply = client.next('ok');
  client.send('secret', { password: 'correct horse battery staple' });
  await reply;
  const wire = Buffer.concat(seen).toString('latin1');
  assert.ok(!wire.includes('correct horse'), 'plaintext leaked');
  assert.ok(!wire.includes('secret'), 'message type leaked');
  client.close();
});

test('a tampered frame closes the channel', async (t) => {
  let closed;
  const { url } = await server(t, (channel) => { closed = channel.whenClosed; });
  const ws = new WebSocket(url);
  const client = await JCSecure.connect(JCSecure.fromNodeSocket(ws), { verify });
  const frame = client.sealer.seal(0, Buffer.from(JSON.stringify({ type: 'hi' })));
  frame[frame.length - 1] ^= 1;
  ws.send(frame, { binary: true });
  const info = await closed;
  assert.strictEqual(info.code, 4003);
});

test('a replayed frame closes the channel', async (t) => {
  let closed;
  let got = 0;
  const { url } = await server(t, (channel) => {
    closed = channel.whenClosed;
    channel.on('hi', () => { got++; });
  });
  const ws = new WebSocket(url);
  const client = await JCSecure.connect(JCSecure.fromNodeSocket(ws), { verify });
  const frame = client.sealer.seal(0, Buffer.from(JSON.stringify({ type: 'hi' })));
  ws.send(frame, { binary: true });
  ws.send(frame, { binary: true });
  const info = await closed;
  assert.strictEqual(info.code, 4003);
  assert.strictEqual(got, 1);
});

test('a computer with a different key than the one paired is refused', async (t) => {
  const { url } = await server(t, () => {});
  const stranger = identity('Stranger');
  await assert.rejects(JCSecure.connect(open(url), { verify, expectedKey: stranger.publicKey }), { code: 'identity' });
});

test('a server that cannot sign with its claimed key is refused', async (t) => {
  const real = identity('Real');
  const impostor = identity('Impostor');
  const { url } = await server(t, () => {}, { host: { ...real, sign: impostor.sign } });
  await assert.rejects(JCSecure.connect(open(url), { verify }), { code: 'security' });
});

test('pairing and password proofs match between Node scrypt and the browser scrypt library', async () => {
  const th = nacl.randomBytes(32);
  const code = JCSecure.normalizeSecret('482193');
  const salt = JCSecure.pairSalt(th);
  const node = await derive(code, salt);
  const browser = await scryptJs.scrypt(code, salt, 32768, 8, 1, 32);
  assert.strictEqual(b64(node), b64(browser));
  const verifier = await derive(JCSecure.normalizeSecret('pässword'), Buffer.alloc(16, 1));
  const otherTh = nacl.randomBytes(32);
  assert.notStrictEqual(b64(JCSecure.passwordProof(verifier, th)), b64(JCSecure.passwordProof(verifier, otherTh)), 'proofs are bound to the channel');
});

test('client signature and stream data frames round-trip', async (t) => {
  const device = identity('Phone');
  const { url } = await server(t, (channel) => {
    channel.on('auth', async (msg) => {
      const ok = await verify(JCSecure.PREFIX.client + channel.thB64, msg.sig, msg.publicKey);
      channel.send(ok ? 'auth-ok' : 'auth-fail', { reason: ok ? undefined : 'security' });
    });
    channel.on('data', (sid, bytes) => channel.sendData(sid, Buffer.from(Buffer.from(bytes).toString('utf8').toUpperCase())));
  });
  const client = await JCSecure.connect(open(url), { verify });
  const auth = await JCSecure.authenticate(client, { identity: device, derive });
  assert.strictEqual(auth.ok, true);
  const echoed = new Promise((resolve) => client.on('data', (sid, bytes) => resolve([sid, Buffer.from(bytes).toString('utf8')])));
  client.sendData(7, Buffer.from('ssh bytes'));
  assert.deepStrictEqual(await echoed, [7, 'SSH BYTES']);
  client.close();
});
