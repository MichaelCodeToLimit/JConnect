// JConnect Cloud storage: the SQLite database, and moving accounts over from the old JSON file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../store');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jconnect-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('accounts, devices, sessions and the vault survive a restart', (t) => {
  const file = path.join(tempDir(t), 'cloud.db');
  const at = Date.now();
  let store = openStore(file);
  assert.ok(store.createUser({ id: 'u1', email: 'a@example.com', salt: 'c2FsdHNhbHRzYWx0c2FsdA==', auth: 'x:y', createdAt: at }));
  assert.strictEqual(store.createUser({ id: 'u2', email: 'a@example.com', salt: 's', auth: 'x:y', createdAt: at }), false, 'one account per email');
  store.saveDevice('u1', { id: 'd1', publicKey: 'pk', name: 'PC', os: 'Windows 11', lastSeen: at });
  store.createSession('h1', 'u1', at, at + 60000);
  assert.deepStrictEqual(store.putVault('u1', 0, 'cipher-1', at), { ok: true, version: 1, blob: 'cipher-1' });
  assert.deepStrictEqual(store.putVault('u1', 0, 'cipher-2', at), { ok: false, version: 1, blob: 'cipher-1' }, 'stale writes are refused');
  store.setTotp('u1', { secret: 'ABC', enabled: true }, at);
  const secret = store.secret();
  store.close();

  store = openStore(file);
  try {
    assert.strictEqual(store.secret(), secret, 'the prelogin secret is kept');
    const user = store.userByEmail('a@example.com');
    assert.deepStrictEqual([user.id, user.vault.version, user.vault.blob, user.totp], ['u1', 1, 'cipher-1', { secret: 'ABC', enabled: true }]);
    assert.deepStrictEqual(store.devices('u1').map((d) => [d.id, d.name]), [['d1', 'PC']]);
    assert.strictEqual(store.session('h1').userId, 'u1');
  } finally {
    store.close();
  }
});

test('devices can be registered again and removed, and expired sessions are purged', () => {
  const store = openStore(null);
  try {
    const at = Date.now();
    store.createUser({ id: 'u1', email: 'b@example.com', salt: 's', auth: 'x:y', createdAt: at });
    store.saveDevice('u1', { id: 'd1', publicKey: 'pk', name: 'Old name', os: '', lastSeen: at });
    store.saveDevice('u1', { id: 'd1', publicKey: 'pk', name: 'New name', os: '', lastSeen: at + 1 });
    assert.deepStrictEqual([store.deviceCount('u1'), store.device('u1', 'd1').name], [1, 'New name']);
    assert.strictEqual(store.device('u1', { not: 'a string' }), undefined);
    assert.ok(store.removeDevice('u1', 'd1'));
    assert.strictEqual(store.device('u1', 'd1'), undefined);

    store.createSession('old', 'u1', at - 2000, at - 1000);
    store.createSession('live', 'u1', at, at + 60000);
    assert.strictEqual(store.purgeExpiredSessions(at), 1);
    assert.deepStrictEqual([store.session('old'), store.session('live').userId], [undefined, 'u1']);
  } finally {
    store.close();
  }
});

test('accounts move over from the old JSON file once, and the file is kept', (t) => {
  const dir = tempDir(t);
  const json = path.join(dir, 'cloud.json');
  const at = Date.now();
  fs.writeFileSync(json, JSON.stringify({
    secret: 'legacy-secret',
    users: {
      u1: {
        id: 'u1',
        email: 'old@example.com',
        salt: 'c2FsdA==',
        auth: 'x:y',
        totp: { secret: 'ABC', enabled: true },
        vault: { version: 3, blob: 'cipher-3', updatedAt: at },
        devices: { d1: { publicKey: 'pk', name: 'Laptop', os: 'macOS', lastSeen: at } },
        createdAt: at,
      },
    },
    emails: { 'old@example.com': 'u1' },
    sessions: {
      live: { userId: 'u1', createdAt: at, expiresAt: at + 60000 },
      expired: { userId: 'u1', createdAt: at - 2000, expiresAt: at - 1000 },
    },
  }));

  const store = openStore(path.join(dir, 'cloud.db'));
  try {
    assert.strictEqual(store.importJson(json), 1);
    assert.strictEqual(store.secret(), 'legacy-secret', 'unknown emails keep getting the same fake salt');
    const user = store.userByEmail('old@example.com');
    assert.deepStrictEqual([user.totp, user.vault.version, user.vault.blob], [{ secret: 'ABC', enabled: true }, 3, 'cipher-3']);
    assert.deepStrictEqual(store.devices('u1').map((d) => d.name), ['Laptop']);
    assert.ok(store.session('live'));
    assert.strictEqual(store.session('expired'), undefined);
    assert.ok(fs.existsSync(`${json}.imported`) && !fs.existsSync(json));
    assert.strictEqual(store.importJson(json), 0, 'nothing is imported twice');
  } finally {
    store.close();
  }
});
