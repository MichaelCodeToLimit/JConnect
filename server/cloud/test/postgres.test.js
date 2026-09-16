// JConnect Cloud's Postgres storage (store-postgres.js), on a local Postgres set up like a Supabase database.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { available, startPostgres } = require('./postgres');
const { openPostgresStore, poolConfig } = require('../store-postgres');

process.env.JCONNECT_CLOUD_QUIET = '1';
const skip = available() ? false : 'run npm install in server/cloud first';

const b64 = (bytes) => crypto.randomBytes(bytes).toString('base64');
const deviceId = () => crypto.randomBytes(10).toString('hex');
const verifier = () => `${b64(16)}:${b64(32)}`;

async function open(t, options) {
  const pg = await startPostgres(options);
  const store = openPostgresStore(pg.url, { max: 1 });
  t.after(async () => {
    await store.close();
    await pg.stop();
  });
  return store;
}

async function newUser(store, email) {
  const id = crypto.randomUUID();
  assert.ok(await store.createUser({ id, email, salt: b64(16), auth: verifier(), createdAt: Date.now() }));
  return id;
}

test('accounts, the vault, two-step sign-in and sessions', { skip }, async (t) => {
  const store = await open(t);
  await store.ready();
  const at = Date.now();
  const id = await newUser(store, 'a@example.com');
  assert.strictEqual(await store.createUser({ id: crypto.randomUUID(), email: 'a@example.com', salt: b64(16), auth: verifier(), createdAt: at }), false, 'one account per email');
  assert.deepStrictEqual(await store.putVault(id, 0, 'cipher-1', at), { ok: true, version: 1, blob: 'cipher-1' });
  assert.deepStrictEqual(await store.putVault(id, 0, 'cipher-2', at), { ok: false, version: 1, blob: 'cipher-1' }, 'stale writes are refused');
  assert.deepStrictEqual(await store.putVault(id, 2 ** 40, 'cipher-2', at), { ok: false, version: 1, blob: 'cipher-1' }, 'a version out of range is refused, not an error');
  await store.setTotp(id, { secret: 'ABC', enabled: true }, at);
  const user = await store.userByEmail('a@example.com');
  assert.deepStrictEqual([user.id, user.vault.version, user.vault.blob, user.totp], [id, 1, 'cipher-1', { secret: 'ABC', enabled: true }]);
  assert.strictEqual(await store.userById('not-an-account-id'), undefined);
  assert.match(await store.secret(), /^[A-Za-z0-9+/]{43}=$/, 'the migration made a prelogin secret');

  const live = b64(32);
  const old = b64(32);
  await store.createSession(live, id, at, at + 60000);
  await store.createSession(old, id, at - 2000, at - 1000);
  assert.deepStrictEqual(await store.session(live), { tokenHash: live, userId: id, createdAt: at, expiresAt: at + 60000 });
  assert.strictEqual(await store.purgeExpiredSessions(at), 1);
  assert.strictEqual(await store.session(old), undefined);
  await store.deleteSession(live);
  assert.strictEqual(await store.session(live), undefined);
});

test('devices can be registered again and removed, and an account has at most 50', { skip }, async (t) => {
  const store = await open(t);
  const id = await newUser(store, 'b@example.com');
  const at = Date.now();
  const first = deviceId();
  const publicKey = b64(32);
  await store.saveDevice(id, { id: first, publicKey, name: 'Old name', os: '', lastSeen: at });
  await store.saveDevice(id, { id: first, publicKey, name: 'New name', os: 'Linux', lastSeen: at + 1 });
  const saved = await store.device(id, first);
  assert.deepStrictEqual([await store.deviceCount(id), saved.name, saved.os, saved.lastSeen], [1, 'New name', 'Linux', at + 1]);
  assert.strictEqual(await store.device(id, { not: 'a string' }), undefined);

  for (let i = 1; i < 50; i++) await store.saveDevice(id, { id: deviceId(), publicKey: b64(32), name: `PC ${i}`, os: '', lastSeen: at });
  await assert.rejects(store.saveDevice(id, { id: deviceId(), publicKey: b64(32), name: 'One too many', os: '', lastSeen: at }), { message: 'too-many-devices', status: 429 });
  await store.saveDevice(id, { id: first, publicKey, name: 'Registered again', os: '', lastSeen: at });
  assert.ok(await store.removeDevice(id, first));
  assert.strictEqual(await store.removeDevice(id, first), false);
  assert.strictEqual((await store.devices(id)).length, 49);
});

test('a password change swaps the keys and the vault together and signs out every session', { skip }, async (t) => {
  const store = await open(t);
  const id = await newUser(store, 'c@example.com');
  const other = await newUser(store, 'other@example.com');
  const at = Date.now();
  await store.putVault(id, 0, 'cipher-old-key', at);
  const session = b64(32);
  const otherSession = b64(32);
  await store.createSession(session, id, at, at + 60000);
  await store.createSession(otherSession, other, at, at + 60000);

  const next = { salt: b64(16), auth: verifier(), blob: 'cipher-new-key', at };
  assert.deepStrictEqual(await store.changePassword(id, { ...next, baseVersion: 0 }), { ok: false, version: 1, blob: 'cipher-old-key' });
  assert.ok(await store.session(session), 'a refused change signs nobody out');
  assert.deepStrictEqual(await store.changePassword(id, { ...next, baseVersion: 1 }), { ok: true, version: 2, blob: 'cipher-new-key' });
  const user = await store.userById(id);
  assert.deepStrictEqual([user.salt, user.auth], [next.salt, next.auth]);
  assert.strictEqual(await store.session(session), undefined);
  assert.ok(await store.session(otherSession), 'other accounts stay signed in');

  await store.saveDevice(id, { id: deviceId(), publicKey: b64(32), name: 'PC', os: '', lastSeen: at });
  assert.ok(await store.deleteUser(id));
  const rows = await store.dump();
  assert.deepStrictEqual([rows.accounts.length, rows.devices.length, rows.sessions.length, rows.settings.length], [1, 0, 1, 1]);
});

test('JConnect Cloud won’t start on a database without its tables', { skip }, async (t) => {
  const store = await open(t, { migrate: false });
  await assert.rejects(store.ready(), /Apply server\/cloud\/supabase\/migrations/);
});

test('databases away from this computer are reached over TLS with the certificate checked', () => {
  const supabase = poolConfig('postgresql://postgres.abcdefghijklmnopqrst:p%40ss@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require', { ca: '' });
  assert.deepStrictEqual(supabase.ssl, { rejectUnauthorized: true });
  assert.strictEqual(supabase.connectionString, 'postgresql://postgres.abcdefghijklmnopqrst:p%40ss@aws-0-eu-central-1.pooler.supabase.com:5432/postgres', 'SSL settings in the address are dropped');

  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  assert.strictEqual(poolConfig('postgres://u:p@db.example.com/postgres', { ca: pem }).ssl.ca, pem);
  assert.deepStrictEqual(poolConfig('postgres://u:p@db.example.com/postgres?sslmode=disable', { ca: '' }).ssl, { rejectUnauthorized: true }, 'only a private network can turn TLS off');
  assert.strictEqual(poolConfig('postgres://u:p@192.168.1.5/postgres?sslmode=disable', { ca: '' }).ssl, false);
  assert.strictEqual(poolConfig('postgres://u:p@127.0.0.1:5432/postgres', { ca: '' }).ssl, false);
  assert.throws(() => poolConfig('mysql://u:p@db.example.com/jconnect', { ca: '' }), /postgres:\/\//);
});
