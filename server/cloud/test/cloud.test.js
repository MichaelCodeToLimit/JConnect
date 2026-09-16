// JConnect Cloud: accounts, encrypted vault, device registration, two-step sign-in and relay rules.
// Every test runs with SQLite, and again with Postgres when the test packages are installed (npm install here).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const { WebSocket } = require('ws');
const { createCloud, totpCode } = require('../cloud');
const { openPostgresStore } = require('../store-postgres');
const { deviceIdFromKey, registerText } = require('../../relay/relay');
const { available, startPostgres } = require('./postgres');

process.env.JCONNECT_CLOUD_QUIET = '1';
process.env.JCONNECT_RELAY_QUIET = '1';
const b64 = (u8) => Buffer.from(u8).toString('base64');

const BACKENDS = [['SQLite', false], ['Postgres', available() ? false : 'run npm install in server/cloud first']];

async function start(t, backend) {
  const pg = backend === 'Postgres' ? await startPostgres() : null;
  const store = pg ? openPostgresStore(pg.url, { max: 1 }) : undefined;
  const cloud = createCloud({ port: 0, host: '127.0.0.1', dataFile: null, store, stun: [] });
  const port = await cloud.listen();
  t.after(async () => {
    await cloud.close();
    if (pg) await pg.stop();
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  return { cloud, port, base, call };
}

function device() {
  const keyPair = nacl.sign.keyPair();
  const publicKey = b64(keyPair.publicKey);
  return { keyPair, publicKey, id: deviceIdFromKey(publicKey), sign: (text) => b64(nacl.sign.detached(Buffer.from(text), keyPair.secretKey)) };
}

async function account(call, email = 'michael@example.com') {
  const salt = b64(crypto.randomBytes(16));
  const authKey = b64(crypto.randomBytes(32));
  const { status, data } = await call('POST', '/v1/signup', { body: { email, salt, authKey } });
  assert.strictEqual(status, 200);
  return { email, salt, authKey, token: data.token, userId: data.userId };
}

async function register(call, acct, dev) {
  const ts = Date.now();
  return call('POST', '/v1/devices', {
    token: acct.token,
    body: { id: dev.id, publicKey: dev.publicKey, name: 'PC', os: 'Windows 11', ts, sig: dev.sign(`jconnect-cloud-device:${dev.id}:${acct.userId}:${ts}`) },
  });
}

// Brings a device online on the relay, as JVPN does on a computer.
async function hostOnRelay(t, port, dev, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/host`);
  t.after(() => ws.terminate());
  await new Promise((r) => ws.once('open', r));
  const ts = Date.now();
  const registered = new Promise((resolve) => ws.on('message', (m) => { const msg = JSON.parse(m); if (msg.t === 'registered') resolve(); }));
  ws.send(JSON.stringify({ t: 'register', id: dev.id, publicKey: dev.publicKey, ts, sig: dev.sign(registerText(dev.id, ts)), token }));
  await registered;
  return ws;
}

const closeCode = (ws) => new Promise((resolve) => ws.once('close', (code) => resolve(code)));

for (const [backend, skip] of BACKENDS) {
  test(`sign-up, sign-in with the derived key, and no account discovery through prelogin (${backend})`, { skip }, async (t) => {
    const { call } = await start(t, backend);
    const acct = await account(call);

    const pre = await call('POST', '/v1/prelogin', { body: { email: acct.email } });
    assert.strictEqual(pre.data.salt, acct.salt);
    const unknownA = await call('POST', '/v1/prelogin', { body: { email: 'nobody@example.com' } });
    const unknownB = await call('POST', '/v1/prelogin', { body: { email: 'nobody@example.com' } });
    assert.strictEqual(unknownA.data.salt, unknownB.data.salt, 'unknown addresses get a stable salt');

    assert.strictEqual((await call('POST', '/v1/login', { body: { email: acct.email, authKey: b64(crypto.randomBytes(32)) } })).status, 401);
    const ok = await call('POST', '/v1/login', { body: { email: acct.email, authKey: acct.authKey } });
    assert.strictEqual(ok.status, 200);
    assert.ok(ok.data.token);
    assert.strictEqual((await call('POST', '/v1/signup', { body: { email: acct.email, salt: acct.salt, authKey: acct.authKey } })).status, 409);
    assert.strictEqual((await call('GET', '/v1/vault')).status, 401);
    assert.strictEqual((await call('POST', '/v1/logout', { token: ok.data.token })).status, 200);
    assert.strictEqual((await call('GET', '/v1/vault', { token: ok.data.token })).status, 401, 'signing out ends the session');
  });

  test(`the vault stores only what the device sends and refuses stale writes (${backend})`, { skip }, async (t) => {
    const { call } = await start(t, backend);
    const acct = await account(call);
    const first = await call('PUT', '/v1/vault', { token: acct.token, body: { baseVersion: 0, blob: 'ciphertext-1' } });
    assert.deepStrictEqual(first.data, { version: 1 });
    const stale = await call('PUT', '/v1/vault', { token: acct.token, body: { baseVersion: 0, blob: 'ciphertext-2' } });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.data.blob, 'ciphertext-1');
    const got = await call('GET', '/v1/vault', { token: acct.token });
    assert.deepStrictEqual(got.data, { version: 1, blob: 'ciphertext-1' });
  });

  test(`devices must prove their key to join an account (${backend})`, { skip }, async (t) => {
    const { call } = await start(t, backend);
    const acct = await account(call);
    const dev = device();
    assert.strictEqual((await register(call, acct, dev)).status, 200);
    const impostor = device();
    const ts = Date.now();
    const bad = await call('POST', '/v1/devices', {
      token: acct.token,
      body: { id: dev.id, publicKey: dev.publicKey, ts, sig: impostor.sign(`jconnect-cloud-device:${dev.id}:${acct.userId}:${ts}`) },
    });
    assert.strictEqual(bad.status, 400);
    const me = await call('GET', '/v1/me', { token: acct.token });
    assert.deepStrictEqual(me.data.devices.map((d) => d.id), [dev.id]);
  });

  test(`two-step sign-in requires a valid authenticator code once enabled (${backend})`, { skip }, async (t) => {
    const { call } = await start(t, backend);
    const acct = await account(call);
    const setup = await call('POST', '/v1/totp/setup', { token: acct.token });
    const code = totpCode(setup.data.secret, Math.floor(Date.now() / 30000));
    assert.strictEqual((await call('POST', '/v1/totp/enable', { token: acct.token, body: { code } })).status, 200);

    const noCode = await call('POST', '/v1/login', { body: { email: acct.email, authKey: acct.authKey } });
    assert.deepStrictEqual([noCode.status, noCode.data.error], [401, 'totp-required']);
    const wrong = await call('POST', '/v1/login', { body: { email: acct.email, authKey: acct.authKey, totp: code === '000000' ? '111111' : '000000' } });
    assert.strictEqual(wrong.status, 401);
    const right = await call('POST', '/v1/login', { body: { email: acct.email, authKey: acct.authKey, totp: totpCode(setup.data.secret, Math.floor(Date.now() / 30000)) } });
    assert.strictEqual(right.status, 200);
  });

  test(`two-step sign-in can only be replaced or turned off with a code (${backend})`, { skip }, async (t) => {
    const { call } = await start(t, backend);
    const acct = await account(call);
    const setup = await call('POST', '/v1/totp/setup', { token: acct.token });
    const codeNow = () => totpCode(setup.data.secret, Math.floor(Date.now() / 30000));
    assert.strictEqual((await call('POST', '/v1/totp/enable', { token: acct.token, body: { code: codeNow() } })).status, 200);

    // Setting it up again would replace the secret and switch it off, so a session alone can't do that.
    assert.strictEqual((await call('POST', '/v1/totp/setup', { token: acct.token })).status, 409);
    assert.strictEqual((await call('GET', '/v1/me', { token: acct.token })).data.totp, true);
    assert.strictEqual((await call('POST', '/v1/totp/enable', { token: acct.token, body: { code: codeNow() } })).status, 400, 'already on');
    const wrong = codeNow() === '000000' ? '111111' : '000000';
    assert.strictEqual((await call('POST', '/v1/totp/disable', { token: acct.token, body: { code: wrong } })).status, 400);
    assert.strictEqual((await call('POST', '/v1/totp/disable', { token: acct.token, body: { code: codeNow() } })).status, 200);
    assert.strictEqual((await call('GET', '/v1/me', { token: acct.token })).data.totp, false);
  });

  test(`changing the password needs the current one, swaps the vault and signs out every session (${backend})`, { skip }, async (t) => {
    const { call, port } = await start(t, backend);
    const acct = await account(call);
    const secondDevice = await call('POST', '/v1/login', { body: { email: acct.email, authKey: acct.authKey } });
    await call('PUT', '/v1/vault', { token: acct.token, body: { baseVersion: 0, blob: 'cipher-old-key' } });
    const pc = device();
    await register(call, acct, pc);
    const hostWs = await hostOnRelay(t, port, pc, acct.token);

    const salt = b64(crypto.randomBytes(16));
    const newAuthKey = b64(crypto.randomBytes(32));
    const change = (body) => call('POST', '/v1/password', { token: acct.token, body: { authKey: acct.authKey, salt, newAuthKey, baseVersion: 1, blob: 'cipher-new-key', ...body } });
    const wrongPassword = await change({ authKey: b64(crypto.randomBytes(32)) });
    assert.deepStrictEqual([wrongPassword.status, wrongPassword.data.error], [403, 'credentials'], 'not 401, which would mean the session ended');
    const stale = await change({ baseVersion: 0 });
    assert.deepStrictEqual([stale.status, stale.data.error, stale.data.blob], [409, 'vault-changed', 'cipher-old-key']);
    assert.strictEqual((await call('POST', '/v1/login', { body: { email: acct.email, authKey: acct.authKey } })).status, 200, 'a refused change keeps the old password');

    const closed = closeCode(hostWs);
    const changed = await change({});
    assert.strictEqual(changed.status, 200);
    assert.strictEqual(await closed, 4001, 'the relay connection is closed so it reconnects with the new session');
    assert.strictEqual((await call('GET', '/v1/vault', { token: acct.token })).status, 401, 'this session ended');
    assert.strictEqual((await call('GET', '/v1/vault', { token: secondDevice.data.token })).status, 401, 'and so did every other');
    assert.deepStrictEqual((await call('GET', '/v1/vault', { token: changed.data.token })).data, { version: 2, blob: 'cipher-new-key' });
    assert.strictEqual((await call('POST', '/v1/prelogin', { body: { email: acct.email } })).data.salt, salt);
    assert.strictEqual((await call('POST', '/v1/login', { body: { email: acct.email, authKey: acct.authKey } })).status, 401, 'the old password no longer works');
    assert.strictEqual((await call('POST', '/v1/login', { body: { email: acct.email, authKey: newAuthKey } })).status, 200);
    assert.deepStrictEqual((await call('GET', '/v1/me', { token: changed.data.token })).data.devices.map((d) => d.id), [pc.id], 'devices stay on the account');
  });

  test(`deleting the account needs the password and code, and removes everything it had (${backend})`, { skip }, async (t) => {
    const { cloud, call, port } = await start(t, backend);
    const acct = await account(call);
    await account(call, 'keep@example.com');
    const setup = await call('POST', '/v1/totp/setup', { token: acct.token });
    const codeNow = () => totpCode(setup.data.secret, Math.floor(Date.now() / 30000));
    await call('POST', '/v1/totp/enable', { token: acct.token, body: { code: codeNow() } });
    const pc = device();
    await register(call, acct, pc);
    const hostWs = await hostOnRelay(t, port, pc, acct.token);

    const remove = (body) => call('DELETE', '/v1/account', { token: acct.token, body });
    assert.deepStrictEqual(await remove({ authKey: acct.authKey }), { status: 403, data: { error: 'totp-required' } });
    assert.deepStrictEqual(await remove({ authKey: b64(crypto.randomBytes(32)), totp: codeNow() }), { status: 403, data: { error: 'credentials' } });
    const closed = closeCode(hostWs);
    assert.strictEqual((await remove({ authKey: acct.authKey, totp: codeNow() })).status, 200);
    assert.strictEqual(await closed, 4003);
    assert.strictEqual((await call('GET', '/v1/me', { token: acct.token })).status, 401);
    assert.strictEqual((await call('POST', '/v1/login', { body: { email: acct.email, authKey: acct.authKey, totp: codeNow() } })).status, 401);
    const rows = await cloud.db.dump();
    assert.deepStrictEqual([rows.accounts.map((a) => a.email), rows.devices.length, rows.sessions.length], [['keep@example.com'], 0, 1]);
    assert.strictEqual((await call('POST', '/v1/signup', { body: { email: acct.email, salt: acct.salt, authKey: acct.authKey } })).status, 200, 'the address can make a new account');
  });

  test(`relay: only registered account devices come online, presence is private, and dialing needs a ticket (${backend})`, { skip }, async (t) => {
    const { call, port } = await start(t, backend);
    const owner = await account(call, 'owner@example.com');
    const stranger = await account(call, 'stranger@example.com');
    const pc = device();
    await register(call, owner, pc);
    const hostWs = await hostOnRelay(t, port, pc, owner.token);

    const presence = (token) => fetch(`http://127.0.0.1:${port}/presence?ids=${pc.id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(async (r) => ({ status: r.status, data: await r.json() }));
    assert.deepStrictEqual((await presence(owner.token)).data.online, [pc.id]);
    assert.deepStrictEqual((await presence(stranger.token)).data.online, []);
    assert.strictEqual((await presence(null)).status, 401);

    const dial = (query) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/connect?to=${pc.id}${query}`);
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
      hostWs.once('message', (m) => { const msg = JSON.parse(m); if (msg.t === 'incoming') { ws.terminate(); resolve('incoming'); } });
    });
    assert.strictEqual(await dial(''), 4003);
    assert.strictEqual((await call('POST', '/v1/relay/ticket', { token: stranger.token, body: { to: pc.id } })).status, 404);
    const { data } = await call('POST', '/v1/relay/ticket', { token: owner.token, body: { to: pc.id } });
    assert.strictEqual(await dial(`&ticket=${data.ticket}`), 'incoming');
    assert.strictEqual(await dial(`&ticket=${data.ticket}`), 4003, 'tickets are single use');
  });
}
