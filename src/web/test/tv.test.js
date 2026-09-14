// JConnect on a TV: which devices get the TV layout, and where the remote's arrows move to.
//   node --test src/web/test/tv.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// On a device that isn't a TV, tv.js only publishes its helpers, so a bare sandbox can load it.
function loadTv() {
  const sandbox = {
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' },
    location: { search: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'tv.js'), 'utf8'), sandbox);
  return sandbox.JCTV;
}

test('TVs get the TV layout, and other devices do not', () => {
  const tv = loadTv();
  assert.strictEqual(tv.on, false);

  const tvs = [
    'Mozilla/5.0 (Linux; Android 14; Chromecast Build/UTTK.250729.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36 JConnectTV',
    'Mozilla/5.0 (Linux; Android 11; BRAVIA 4K VH2 Build/RTT2.211108.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7285; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0 Mobile Safari/537.36',
    'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36',
    'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0 Safari/537.36 WebAppManager',
  ];
  for (const ua of tvs) assert.strictEqual(tv.detect(ua, ''), true, ua);

  const others = [
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 After',
  ];
  for (const ua of others) assert.strictEqual(tv.detect(ua, ''), false, ua);
  assert.strictEqual(tv.detect(others[0], '?tv=1'), true);
});

test('the arrows move to the nearest control in that direction', () => {
  const { nearest } = loadTv();
  const rect = (left, top, width = 100, height = 40) => ({ left, top, width, height });
  // My Computers: two rows of [⋯][Connect], with Add Computer across the bottom.
  const moreA = rect(300, 100, 40);
  const connectA = rect(360, 100);
  const moreB = rect(300, 160, 40);
  const connectB = rect(360, 160);
  const add = rect(20, 240, 440);
  const all = [moreA, connectA, moreB, connectB, add];
  const pick = (from, dir) => {
    const list = all.filter((r) => r !== from);
    const i = nearest(from, list, dir);
    return i < 0 ? null : list[i];
  };

  assert.strictEqual(pick(connectA, 'down'), connectB);
  assert.strictEqual(pick(connectA, 'left'), moreA);
  assert.strictEqual(pick(moreB, 'up'), moreA);
  assert.strictEqual(pick(moreB, 'right'), connectB);
  assert.strictEqual(pick(connectB, 'down'), add);
  assert.strictEqual(pick(add, 'up'), moreB);
  assert.strictEqual(pick(connectA, 'up'), null);
  assert.strictEqual(pick(connectA, 'right'), null);
});
