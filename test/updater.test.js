// The updater: comparing versions, trusting only a well-formed description of a download, picking the right download
// for each kind of install, and downloading only what matches the published size and SHA-256.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { compareVersions, parseUpdateInfo, updateTarget, updateBase, download, UPDATE_BASE } = require('../src/main/updater');

test('versions compare the way releases are numbered', () => {
  assert.strictEqual(compareVersions('0.1.0-beta.3', '0.1.0-beta.2'), 1);
  assert.strictEqual(compareVersions('0.1.0-beta.10', '0.1.0-beta.9'), 1);
  assert.strictEqual(compareVersions('0.1.0', '0.1.0-beta.9'), 1);
  assert.strictEqual(compareVersions('0.1.0-beta.2', '0.1.0'), -1);
  assert.strictEqual(compareVersions('0.2.0-beta.1', '0.1.9'), 1);
  assert.strictEqual(compareVersions('1.0.0', '0.99.99'), 1);
  assert.strictEqual(compareVersions('0.1.0-beta.2', '0.1.0-beta.2'), 0);
  assert.strictEqual(compareVersions('0.1.0-beta', '0.1.0-beta.1'), -1);
  assert.strictEqual(compareVersions('0.1.0-alpha.9', '0.1.0-beta.1'), -1);
  assert.strictEqual(compareVersions('0.1', '0.1.0'), null);
  assert.strictEqual(compareVersions('latest', '0.1.0'), null);
});

test('only a well-formed description of the expected download is used', () => {
  const good = { app: 'jconnect', file: 'JConnect-Setup.exe', version: '0.1.0-beta.2', size: 95438202, sha256: 'b'.repeat(64), released: '2026-09-14' };
  assert.deepStrictEqual(parseUpdateInfo(JSON.stringify(good), 'JConnect-Setup.exe'), {
    file: 'JConnect-Setup.exe', version: '0.1.0-beta.2', sha256: 'b'.repeat(64), size: 95438202,
  });
  const bad = [
    'not json',
    JSON.stringify({ ...good, app: 'other' }),
    JSON.stringify({ ...good, file: 'JConnect-Linux.deb' }),
    JSON.stringify({ ...good, version: 'newest' }),
    JSON.stringify({ ...good, sha256: 'B'.repeat(64) }),
    JSON.stringify({ ...good, sha256: 'b'.repeat(63) }),
    JSON.stringify({ ...good, size: 12 }),
    JSON.stringify({ ...good, size: 2 ** 40 }),
    JSON.stringify({ ...good, size: '95438202' }),
  ];
  for (const text of bad) assert.strictEqual(parseUpdateInfo(text, 'JConnect-Setup.exe'), null, text);
});

test('each kind of install gets its own download and way of updating', () => {
  const none = () => false;
  const all = () => true;
  const win = 'C:\\Users\\sam\\AppData\\Local\\Programs\\JConnect\\JConnect.exe';
  assert.deepStrictEqual(updateTarget({ platform: 'win32', arch: 'x64', env: {}, execPath: win, exists: (p) => p.endsWith('Uninstall JConnect.exe') }), { file: 'JConnect-Setup.exe', method: 'nsis' });
  assert.strictEqual(updateTarget({ platform: 'win32', arch: 'x64', env: { PORTABLE_EXECUTABLE_FILE: 'D:\\JConnect.exe' }, execPath: win, exists: all }).method, 'manual');
  assert.strictEqual(updateTarget({ platform: 'win32', arch: 'x64', env: {}, execPath: 'C:\\build\\win-unpacked\\JConnect.exe', exists: none }).method, 'manual');

  const mac = '/Applications/JConnect.app/Contents/MacOS/JConnect';
  assert.deepStrictEqual(updateTarget({ platform: 'darwin', arch: 'arm64', execPath: mac }), { file: 'JConnect-Mac-AppleSilicon.dmg', method: 'dmg', bundle: '/Applications/JConnect.app' });
  assert.strictEqual(updateTarget({ platform: 'darwin', arch: 'x64', execPath: mac }).file, 'JConnect-Mac-Intel.dmg');
  assert.strictEqual(updateTarget({ platform: 'darwin', arch: 'arm64', execPath: '/Volumes/JConnect 0.1.0/JConnect.app/Contents/MacOS/JConnect' }).method, 'manual');
  assert.strictEqual(updateTarget({ platform: 'darwin', arch: 'arm64', execPath: '/private/var/folders/x/AppTranslocation/1234/d/JConnect.app/Contents/MacOS/JConnect' }).method, 'manual');

  assert.deepStrictEqual(updateTarget({ platform: 'linux', arch: 'x64', env: {}, execPath: '/opt/JConnect/jconnect', exists: (p) => p === '/var/lib/dpkg/info/jconnect.list' }), { file: 'JConnect-Linux.deb', method: 'deb' });
  assert.strictEqual(updateTarget({ platform: 'linux', arch: 'x64', env: { APPIMAGE: '/home/sam/JConnect.AppImage' }, execPath: '/tmp/.mount_JConn/jconnect', exists: all }).method, 'manual');
  assert.strictEqual(updateTarget({ platform: 'freebsd', arch: 'x64', execPath: '/usr/local/bin/jconnect' }), null);
});

test('updates come from the website, or from this computer when testing', () => {
  assert.strictEqual(updateBase({}, true), UPDATE_BASE);
  assert.strictEqual(updateBase({ JCONNECT_UPDATE_URL: 'https://example.com/downloads' }, true), UPDATE_BASE);
  assert.strictEqual(updateBase({ JCONNECT_UPDATE_URL: 'http://127.0.0.1:8080/d' }, true), 'http://127.0.0.1:8080/d/');
  assert.strictEqual(updateBase({ JCONNECT_UPDATE_URL: 'http://192.168.1.5:8080/' }, true), UPDATE_BASE);
  assert.strictEqual(updateBase({ JCONNECT_UPDATE_URL: 'https://example.com/downloads/' }, false), 'https://example.com/downloads/');
  assert.strictEqual(updateBase({ JCONNECT_UPDATE_URL: 'not a url' }, false), UPDATE_BASE);
});

test('a download is kept only when it matches the published size and SHA-256', async () => {
  const body = crypto.randomBytes(2 * 1024 * 1024 + 123);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const server = http.createServer((req, res) => {
    if (req.url === '/JConnect-Setup.exe') {
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    } else if (req.url === '/short.exe') {
      // Claims the full size, then stops early.
      res.writeHead(200, { 'content-length': body.length });
      res.write(body.subarray(0, 1024 * 1024));
      res.destroy();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = (name) => `http://127.0.0.1:${server.address().port}/${name}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jconnect-updater-test-'));
  try {
    const progress = [];
    const dest = path.join(dir, 'JConnect-Setup.exe');
    await download(url('JConnect-Setup.exe'), dest, { size: body.length, sha256, onProgress: (p) => progress.push(p) });
    assert.ok(fs.readFileSync(dest).equals(body));
    assert.ok(progress.length > 10 && progress[progress.length - 1] > 0.99);

    const wrong = path.join(dir, 'wrong.exe');
    await assert.rejects(download(url('JConnect-Setup.exe'), wrong, { size: body.length, sha256: 'a'.repeat(64) }), { code: 'update-corrupt' });
    await assert.rejects(download(url('JConnect-Setup.exe'), wrong, { size: body.length + 1, sha256 }), { code: 'update-corrupt' });
    await assert.rejects(download(url('short.exe'), wrong, { size: body.length, sha256 }), (err) => /^update-(corrupt|download)$/.test(err.code));
    await assert.rejects(download(url('missing.exe'), wrong, { size: body.length, sha256 }), { code: 'update-download' });
    assert.deepStrictEqual(fs.readdirSync(dir), ['JConnect-Setup.exe']);

    // What the release steps publish is exactly what the updater accepts.
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'update-info.js'), dest, '0.1.0-beta.3']);
    const info = parseUpdateInfo(fs.readFileSync(`${dest}.json`, 'utf8'), 'JConnect-Setup.exe');
    assert.deepStrictEqual(info, { file: 'JConnect-Setup.exe', version: '0.1.0-beta.3', sha256, size: body.length });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
