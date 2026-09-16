// Checks the iOS app's WebSocket (mobile/src/native.js) against a real JConnect host agent. SocketPlugin.swift can only
// run on iOS, so a stand-in built on the "ws" package behaves the same way: events in order, binary data as base64,
// and close codes URLSession can't represent (4000 and up) reported as 1006.
//   node --test mobile/test/ios-sockets.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { WebSocket } = require('ws');
const { startTestHost } = require('../scripts/test-host');

const ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(ROOT, 'src', 'web');

// What SocketPlugin.swift does, over Node sockets.
function fakeSocketPlugin(log) {
  const listeners = [];
  const sockets = new Map();
  const emit = (id, event) => { for (const fn of listeners) fn({ ...event, id }); };
  return {
    sockets,
    addListener(name, fn) {
      assert.strictEqual(name, 'socket');
      listeners.push(fn);
      return Promise.resolve({ remove() {} });
    },
    async open({ id, url }) {
      log.push(`open ${url}`);
      const ws = new WebSocket(url); // like URLSession: no Origin header
      sockets.set(id, ws);
      ws.on('open', () => emit(id, { type: 'open' }));
      ws.on('message', (data, isBinary) => {
        if (isBinary) emit(id, { type: 'binary', data: Buffer.from(data).toString('base64') });
        else emit(id, { type: 'text', data: data.toString('utf8') });
      });
      ws.on('close', (code, reason) => {
        sockets.delete(id);
        const invalid = code >= 4000 || code === 1005 || code === 1006;
        emit(id, { type: 'close', code: invalid ? 1006 : code, reason: String(reason || ''), clean: !invalid });
      });
      ws.on('error', () => {});
    },
    async send({ id, text, data }) {
      const ws = sockets.get(id);
      if (!ws) throw new Error('The socket is closed');
      if (text !== undefined) ws.send(text);
      else ws.send(Buffer.from(data, 'base64'), { binary: true });
    },
    async close({ id, code, reason }) {
      const ws = sockets.get(id);
      if (ws) ws.close(code >= 4000 ? 1000 : code, reason);
    },
  };
}

// An iPhone: the Capacitor bridge says "ios", and the page has no WebSocket of its own until native.js adds one.
function loadIosClient(plugin) {
  const storage = new Map();
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask,
    TextDecoder, URLSearchParams, AbortController, btoa, atob, Blob, DOMException,
    crypto: globalThis.crypto,
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', maxTouchPoints: 5 },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    location: { protocol: 'capacitor:', hostname: 'localhost', port: '', search: '', hash: '', pathname: '/' },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    RTCPeerConnection: class {},
    MediaStream: class {},
    Capacitor: { getPlatform: () => 'ios', Plugins: { JConnectSocket: plugin } },
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  // Typed arrays must come from the sandbox's own realm, or tweetnacl's instanceof checks fail.
  ctx.__outerEncode = (s) => Array.from(new TextEncoder().encode(String(s)));
  vm.runInContext('self.TextEncoder = class { encode(s) { return new Uint8Array(__outerEncode(s)); } };', ctx);
  const files = [
    path.join(ROOT, 'mobile', 'src', 'native.js'),
    path.join(WEB, 'vendor', 'nacl-fast.min.js'),
    path.join(WEB, 'vendor', 'scrypt.js'),
    path.join(ROOT, 'src', 'shared', 'secure-channel.js'),
    path.join(WEB, 'identity.js'),
    path.join(WEB, 'connection.js'),
  ];
  for (const file of files) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: path.basename(file) });
  return ctx;
}

test('native.js gives iOS a WebSocket that pairs with a JConnect computer and reaches it again', async (t) => {
  const host = await startTestHost(0);
  t.after(() => host.close());
  const log = [];
  const plugin = fakeSocketPlugin(log);
  const phone = loadIosClient(plugin);

  assert.strictEqual(phone.JCNative.platform, 'ios');
  assert.notStrictEqual(phone.WebSocket, WebSocket, 'native.js replaced the page WebSocket');

  const conn = phone.JCConnection;
  const target = { host: '127.0.0.1', port: host.port, code: host.agent.pairingCode, id: '', publicKey: '' };
  const found = await conn.hostInfo(target);
  assert.strictEqual(found.name, 'Test PC');

  const computer = await conn.pair(target, found, host.agent.pairingCode);
  assert.strictEqual(computer.id, host.store.id);
  assert.strictEqual(host.store.data.trusted.length, 1);
  assert.strictEqual(host.store.data.trusted[0].publicKey, phone.JCIdentity.publicKey);

  const status = await conn.status(computer);
  assert.strictEqual(status.state, 'ready');
  assert.ok(log.every((line) => line.startsWith(`open ws://127.0.0.1:${host.port}/`)), log.join('\n'));
  assert.ok(log.length >= 3, 'every step went through the native plugin');

  // Every socket was closed again, so the app doesn't leak connections.
  const started = Date.now();
  while (plugin.sockets.size && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(plugin.sockets.size, 0);
});

test('the iOS WebSocket follows the browser interface', async (t) => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0 });
  t.after(() => server.close());
  const origins = [];
  server.on('connection', (ws, req) => {
    origins.push(req.headers.origin);
    ws.on('message', (data, isBinary) => {
      if (!isBinary && data.toString() === 'bye') { ws.close(4001, 'custom'); return; }
      ws.send(data, { binary: isBinary });
    });
  });
  await new Promise((r) => server.once('listening', r));
  const phone = loadIosClient(fakeSocketPlugin([]));

  const events = await vm.runInContext(`(async () => {
    const events = [];
    const ws = new WebSocket('ws://127.0.0.1:${server.address().port}/echo');
    ws.binaryType = 'arraybuffer';
    events.push('state ' + ws.readyState);
    try { ws.send('too early'); } catch (err) { events.push('early send ' + err.name); }
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    events.push('state ' + ws.readyState);
    const next = () => new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); });
    ws.send('hello');
    events.push('text ' + (await next()));
    ws.send(new Uint8Array([0, 1, 254, 255]));
    const bytes = await next();
    events.push('binary ' + (bytes instanceof ArrayBuffer) + ' ' + Array.from(new Uint8Array(bytes)).join(','));
    const closed = new Promise((resolve) => { ws.onclose = (e) => resolve(e); });
    ws.send('bye');
    const e = await closed;
    events.push('close ' + e.code + ' ' + e.wasClean + ' state ' + ws.readyState);
    return events;
  })()`, phone);

  assert.deepStrictEqual(Array.from(events), [
    'state 0',
    'early send InvalidStateError',
    'state 1',
    'text hello',
    'binary true 0,1,254,255',
    'close 1006 false state 3',
  ]);
  assert.deepStrictEqual(origins, [undefined], 'native sockets send no Origin');
});
