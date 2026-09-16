// Account sync between two devices through a real JConnect Cloud server.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.JCONNECT_CLOUD_QUIET = '1';
process.env.JCONNECT_RELAY_QUIET = '1';

const { Account, normalizeServer, JCONNECT_CLOUD } = require('../src/main/account');
const { createCloud } = require('../server/cloud/cloud');
const { FakeStore } = require('./fake-store');

async function startCloud(t) {
  const cloud = createCloud({ port: 0, host: '127.0.0.1', dataFile: null, stun: [] });
  const port = await cloud.listen();
  t.after(() => cloud.close());
  return { cloud, server: `http://127.0.0.1:${port}` };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('two devices on one account sync computers and SSH hosts, including removals', async (t) => {
  const { cloud, server } = await startCloud(t);
  const credentials = { server, email: 'Michael@Example.com', password: 'correct horse battery staple' };

  const laptop = new FakeStore('Laptop');
  const a = new Account({ store: laptop });
  await a.signUp(credentials);
  laptop.addComputer({ id: 'c1', type: 'jconnect', name: 'Home PC', os: 'Windows 11', publicKey: 'AAAA', addresses: [{ host: '192.168.1.20', port: 47801 }] });
  await a.sync();

  const desktop = new FakeStore('Office PC');
  const b = new Account({ store: desktop });
  await b.signIn(credentials);
  assert.deepStrictEqual(desktop.data.computers.map((c) => c.name), ['Home PC']);
  assert.deepStrictEqual(b.devices().map((d) => d.name), ['Laptop']);

  await tick();
  desktop.update((d) => {
    Object.assign(d.computers[0], { name: 'Dad’s PC', person: 'Dad', updatedAt: Date.now() });
    d.ssh.hosts.push({ id: 'ssh-pi', name: 'Raspberry Pi', host: '10.0.0.5', port: 22, username: 'pi', addedAt: Date.now(), updatedAt: Date.now() });
  });
  await b.sync();
  await a.sync();
  assert.strictEqual(laptop.data.computers[0].name, 'Dad’s PC');
  assert.strictEqual(laptop.data.computers[0].person, 'Dad');
  assert.deepStrictEqual(laptop.data.ssh.hosts.map((h) => h.name), ['Raspberry Pi']);
  assert.deepStrictEqual(a.devices().map((d) => d.name), ['Office PC']);

  await tick();
  laptop.update((d) => {
    d.computers = [];
    d.tombstones.computers.c1 = Date.now();
  });
  await a.sync();
  await b.sync();
  assert.deepStrictEqual(desktop.data.computers, [], 'removal reached the other device');

  const rows = cloud.db.dump();
  assert.strictEqual(rows.accounts.length, 1);
  assert.ok(rows.accounts[0].vault_blob, 'the server holds a vault');
  const stored = JSON.stringify(rows);
  for (const secret of ['Home PC', 'Dad', 'Raspberry Pi', '10.0.0.5', credentials.password]) {
    assert.ok(!stored.includes(secret), `server storage must not contain "${secret}"`);
  }
});

test('wrong passwords are refused and the server address must be secure', async (t) => {
  const { server } = await startCloud(t);
  const store = new FakeStore('Laptop');
  const account = new Account({ store });
  await account.signUp({ server, email: 'me@example.com', password: 'correct horse battery staple' });

  const other = new Account({ store: new FakeStore('Phone') });
  await assert.rejects(other.signIn({ server, email: 'me@example.com', password: 'wrong horse battery staple' }), { code: 'credentials' });
  await assert.rejects(account.signUp({ server, email: 'short@example.com', password: 'short' }), { code: 'weak-password' });
  assert.throws(() => normalizeServer('http://cloud.example.com'), { code: 'insecure-server' });
  assert.strictEqual(normalizeServer('cloud.example.com'), 'https://cloud.example.com');
  assert.strictEqual(normalizeServer('http://192.168.1.10:47900'), 'http://192.168.1.10:47900');
  assert.strictEqual(normalizeServer('192.168.1.20'), 'http://192.168.1.20:47900', 'a PC on the network that keeps accounts');
  assert.strictEqual(normalizeServer('192.168.1.20:48000'), 'http://192.168.1.20:48000');
  assert.throws(() => normalizeServer('http://[not an address'), { code: 'bad-address' });
  assert.match(JCONNECT_CLOUD, /^https:\/\//);

  await account.signOut();
  assert.strictEqual(store.data.account, null);
});

test('an address that isn’t a JConnect account server is refused before the password is used', async (t) => {
  const website = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<h1>Not here</h1>');
  });
  await new Promise((resolve) => website.listen(0, '127.0.0.1', resolve));
  t.after(() => website.close());
  const account = new Account({ store: new FakeStore('Laptop') });
  const credentials = { email: 'me@example.com', password: 'correct horse battery staple' };
  await assert.rejects(account.signIn({ ...credentials, server: `http://127.0.0.1:${website.address().port}` }), { code: 'not-cloud' });

  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(account.signUp({ ...credentials, server: `http://127.0.0.1:${port}` }), { code: 'cloud-unreachable' });
});

test('a password change keeps this device syncing, and other devices sign in again with the new password', async (t) => {
  const { server } = await startCloud(t);
  const credentials = { server, email: 'me@example.com', password: 'correct horse battery staple' };
  const laptop = new FakeStore('Laptop');
  const a = new Account({ store: laptop });
  await a.signUp(credentials);
  laptop.addComputer({ id: 'c1', type: 'jconnect', name: 'Home PC', os: 'Windows 11', publicKey: 'AAAA' });
  await a.sync();
  const b = new Account({ store: new FakeStore('Office PC') });
  await b.signIn(credentials);

  await assert.rejects(a.changePassword({ current: 'wrong horse battery staple', next: 'a brand new passphrase' }), { code: 'wrong-password' });
  await assert.rejects(a.changePassword({ current: credentials.password, next: 'short' }), { code: 'weak-password' });
  await a.changePassword({ current: credentials.password, next: 'a brand new passphrase' });
  await tick();
  laptop.addComputer({ id: 'c2', type: 'jconnect', name: 'Garage Pi', os: 'Linux', publicKey: 'BBBB' });
  await a.sync();
  assert.strictEqual(a.state, 'signed-in');

  await assert.rejects(b.sync(), { code: 'expired' });
  const phone = new Account({ store: new FakeStore('Phone') });
  await assert.rejects(phone.signIn(credentials), { code: 'credentials' });
  await phone.signIn({ ...credentials, password: 'a brand new passphrase' });
  assert.deepStrictEqual(phone.store.data.computers.map((c) => c.name).sort(), ['Garage Pi', 'Home PC'], 'synced data opens with the new password');
});

test('deleting the account signs this device out and keeps its computers', async (t) => {
  const { cloud, server } = await startCloud(t);
  const store = new FakeStore('Laptop');
  const account = new Account({ store });
  await account.signUp({ server, email: 'gone@example.com', password: 'correct horse battery staple' });
  store.addComputer({ id: 'c1', type: 'jconnect', name: 'Home PC' });
  await account.sync();

  await assert.rejects(account.deleteAccount({ password: 'wrong horse battery staple' }), { code: 'wrong-password' });
  await account.deleteAccount({ password: 'correct horse battery staple' });
  assert.deepStrictEqual([store.data.account, account.state, store.data.computers.map((c) => c.name)], [null, 'signed-out', ['Home PC']]);
  assert.strictEqual(cloud.db.dump().accounts.length, 0);
});
