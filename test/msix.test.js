const test = require('node:test');
const assert = require('node:assert');
const { startedAtSignIn } = require('../src/main/msix');

// Answers the PowerShell query as if this session's explorer.exe started `before` ms before this process.
const explorer = (before) => (_file, _args, _options, done) => done(null, `${Math.round(Date.now() - process.uptime() * 1000 - before)}\r\n`);

test('a Store copy started soon after explorer.exe started at sign-in', async () => {
  assert.strictEqual(await startedAtSignIn({ run: explorer(30000) }), true);
  assert.strictEqual(await startedAtSignIn({ run: explorer(10 * 60000) }), false);
  // explorer.exe restarted after JConnect started.
  assert.strictEqual(await startedAtSignIn({ run: explorer(-5000) }), false);
});

test('a Store copy that can not tell counts as opened by someone', async () => {
  assert.strictEqual(await startedAtSignIn({ run: (_f, _a, _o, done) => done(new Error('timed out'), '') }), false);
  assert.strictEqual(await startedAtSignIn({ run: (_f, _a, _o, done) => done(null, '') }), false);
});
