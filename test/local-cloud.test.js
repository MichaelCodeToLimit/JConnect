// Accounts on this PC: JConnect runs JConnect Cloud itself, and the customer's other devices sign in to it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

process.env.JCONNECT_CLOUD_QUIET = '1';
process.env.JCONNECT_RELAY_QUIET = '1';

const { LocalCloud } = require('../src/main/local-cloud');
const { Account } = require('../src/main/account');
const { FakeStore } = require('./fake-store');

// The server is stopped before its folder is removed, because Windows can't delete an open database.
function localCloud(t, port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jconnect-local-cloud-'));
  const local = new LocalCloud({ dataDir, port });
  t.after(async () => {
    await local.apply(false);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { local, dataDir };
}

test('a PC keeps accounts across restarts, and other devices sign in with its address', async (t) => {
  const { local, dataDir } = localCloud(t, 0);
  await local.apply(true);
  assert.strictEqual(local.status().running, true);

  const credentials = { email: 'family@example.com', password: 'correct horse battery staple' };
  const pc = new FakeStore('Family PC');
  const here = new Account({ store: pc });
  await here.signUp({ ...credentials, server: local.url });
  pc.addComputer({ id: 'c1', type: 'jconnect', name: 'Grandma’s laptop' });
  await here.sync();

  await local.apply(false);
  assert.strictEqual(local.status().running, false);
  await local.apply(true);
  assert.ok(fs.existsSync(path.join(dataDir, 'cloud.db')));

  // Another device on the network types this PC's address, as Settings shows it.
  const laptop = new FakeStore('Laptop');
  const there = new Account({ store: laptop });
  await there.signIn({ ...credentials, server: `127.0.0.1:${local.status().port}` });
  assert.deepStrictEqual(laptop.data.computers.map((c) => c.name), ['Grandma’s laptop']);
});

test('a port another program is using is reported, and nothing is left running', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, resolve));
  t.after(() => blocker.close());
  const { local } = localCloud(t, blocker.address().port);
  await assert.rejects(local.apply(true), { message: 'accounts-port' });
  assert.strictEqual(local.status().running, false);
  assert.match(local.status().error, /Another program is using port/);
});
