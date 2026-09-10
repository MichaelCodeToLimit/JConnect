const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const nacl = require('tweetnacl');
const { createRelay, deviceIdFromKey, registerText } = require('../relay');

process.env.JCONNECT_RELAY_QUIET = '1';

function identity() {
  const kp = nacl.sign.keyPair();
  const publicKey = Buffer.from(kp.publicKey).toString('base64');
  const sign = (text) => Buffer.from(nacl.sign.detached(Buffer.from(text, 'utf8'), kp.secretKey)).toString('base64');
  return { publicKey, id: deviceIdFromKey(publicKey), sign };
}

// Buffer every message from the moment the socket exists, so a message that arrives before a test
// starts waiting for it is never lost.
function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.inbox = [];
    ws.waiters = [];
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      const waiter = ws.waiters.shift();
      if (waiter) waiter(msg); else ws.inbox.push(msg);
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws) {
  if (ws.inbox.length) return Promise.resolve(ws.inbox.shift());
  return new Promise((resolve) => ws.waiters.push(resolve));
}

function closed(ws) {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

async function registerHost(base, who) {
  const control = await open(`${base}/host`);
  const ts = Date.now();
  control.send(JSON.stringify({ t: 'register', id: who.id, publicKey: who.publicKey, ts, sig: who.sign(registerText(who.id, ts)) }));
  assert.deepStrictEqual(await nextMessage(control), { t: 'registered', id: who.id });
  return control;
}

test('relay registers hosts, reports presence, and pipes a tunnel both ways', async (t) => {
  const relay = createRelay({ port: 0, host: '127.0.0.1' });
  const port = await relay.listen();
  const base = `ws://127.0.0.1:${port}`;
  t.after(() => relay.close());

  const host = identity();
  const control = await registerHost(base, host);

  assert.deepStrictEqual(await getJson(port, `/presence?ids=${host.id},${'0'.repeat(20)}`), { online: [host.id] });

  const client = await open(`${base}/connect?to=${host.id}`);
  client.send(JSON.stringify({ t: 'hello-before-accept' })); // buffered until the host accepts

  const incoming = await nextMessage(control);
  assert.strictEqual(incoming.t, 'incoming');
  const tunnel = await open(`${base}/accept?tunnel=${incoming.tunnel}`);

  assert.deepStrictEqual(await nextMessage(tunnel), { t: 'hello-before-accept' });
  client.send(JSON.stringify({ t: 'from-client' }));
  assert.deepStrictEqual(await nextMessage(tunnel), { t: 'from-client' });
  tunnel.send(JSON.stringify({ t: 'from-host' }));
  assert.deepStrictEqual(await nextMessage(client), { t: 'from-host' });

  const clientClosed = closed(client);
  tunnel.close(1000);
  assert.strictEqual(await clientClosed, 1000);
  control.close();
});

test('relay rejects a registration whose id is not bound to the key', async (t) => {
  const relay = createRelay({ port: 0, host: '127.0.0.1' });
  const port = await relay.listen();
  t.after(() => relay.close());

  const victim = identity();
  const attacker = identity();
  const control = await open(`ws://127.0.0.1:${port}/host`);
  const ts = Date.now();
  const whenClosed = closed(control);
  // Attacker claims the victim's id but signs with its own key.
  control.send(JSON.stringify({ t: 'register', id: victim.id, publicKey: attacker.publicKey, ts, sig: attacker.sign(registerText(victim.id, ts)) }));
  assert.strictEqual(await whenClosed, 4003);
});

test('relay rejects stale or badly signed registrations', async (t) => {
  const relay = createRelay({ port: 0, host: '127.0.0.1' });
  const port = await relay.listen();
  t.after(() => relay.close());

  const who = identity();
  const stale = await open(`ws://127.0.0.1:${port}/host`);
  const staleClosed = closed(stale);
  const old = Date.now() - 60 * 60 * 1000;
  stale.send(JSON.stringify({ t: 'register', id: who.id, publicKey: who.publicKey, ts: old, sig: who.sign(registerText(who.id, old)) }));
  assert.strictEqual(await staleClosed, 4003);

  const forged = await open(`ws://127.0.0.1:${port}/host`);
  const forgedClosed = closed(forged);
  const ts = Date.now();
  forged.send(JSON.stringify({ t: 'register', id: who.id, publicKey: who.publicKey, ts, sig: who.sign(registerText(who.id, ts + 1)) }));
  assert.strictEqual(await forgedClosed, 4003);
});

test('connecting to an offline computer closes with "unreachable", and bogus tunnels are refused', async (t) => {
  const relay = createRelay({ port: 0, host: '127.0.0.1' });
  const port = await relay.listen();
  t.after(() => relay.close());

  const client = await open(`ws://127.0.0.1:${port}/connect?to=${'a'.repeat(20)}`);
  assert.strictEqual(await closed(client), 4004);

  const bogus = await open(`ws://127.0.0.1:${port}/accept?tunnel=nope`);
  assert.strictEqual(await closed(bogus), 4004);
});
