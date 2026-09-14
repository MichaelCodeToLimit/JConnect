// Checks JConnect's updater on Windows from start to finish, on a machine that can be thrown away, such as a CI
// runner. It installs an older build, serves a newer build from this computer the way JConnect's website does, starts
// the older JConnect, and waits for it to update itself and start again.
//   node scripts/windows-update-check.js <old installer> <new installer> <new version> [log folder]
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const [oldInstaller, newInstaller, newVersion, logs = 'ci-logs'] = process.argv.slice(2);
const PORT = 8123;
const WAIT_MS = 10 * 60 * 1000;

fs.mkdirSync(logs, { recursive: true });
const log = (...parts) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${parts.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(logs, 'update-check.log'), `${line}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The version Windows lists for JConnect under Installed apps.
function installedVersion() {
  const script = "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'JConnect*' } | Select-Object -First 1).DisplayVersion";
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function running() {
  try {
    return /JConnect\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq JConnect.exe', '/NH'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}

async function main() {
  if (!oldInstaller || !newInstaller || !newVersion) throw new Error('Usage: node scripts/windows-update-check.js <old installer> <new installer> <new version> [log folder]');

  const served = fs.mkdtempSync(path.join(os.tmpdir(), 'jconnect-updates-'));
  const setup = path.join(served, 'JConnect-Setup.exe');
  fs.copyFileSync(newInstaller, setup);
  execFileSync(process.execPath, [path.join(__dirname, 'update-info.js'), setup, newVersion], { stdio: 'inherit' });

  // Stands in for JConnect's website.
  const requests = [];
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(req.url.split('?')[0]));
    requests.push(name);
    log('served', req.method, req.url);
    const file = path.join(served, name);
    if (!name || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  log('installing', path.basename(oldInstaller));
  execFileSync(oldInstaller, ['/S'], { stdio: 'inherit' });
  const before = installedVersion();
  log('installed version:', before);
  const exe = path.join(process.env.LOCALAPPDATA, 'Programs', 'JConnect', 'JConnect.exe');
  if (!fs.existsSync(exe)) throw new Error(`the installer didn't put JConnect at ${exe}`);

  log('starting the older JConnect, with updates from', `http://127.0.0.1:${PORT}/`);
  spawn(exe, ['--hidden'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, JCONNECT_UPDATE_URL: `http://127.0.0.1:${PORT}/` },
  }).unref();

  const deadline = Date.now() + WAIT_MS;
  let version = before;
  let isRunning = false;
  while (Date.now() < deadline) {
    await sleep(10000);
    version = installedVersion();
    isRunning = running();
    log(`installed ${version} · running ${isRunning}`);
    if (version === newVersion && isRunning) break;
  }
  server.close();

  if (!requests.includes('JConnect-Setup.exe.json')) throw new Error('JConnect never asked for the update description');
  if (!requests.includes('JConnect-Setup.exe')) throw new Error('JConnect never downloaded the update');
  if (version !== newVersion) throw new Error(`JConnect is still ${version}, not ${newVersion}`);
  if (!isRunning) throw new Error('JConnect updated but didn\'t start again');
  log(`PASS: JConnect ${before} updated itself to ${version} and started again`);
}

main().then(() => process.exit(0), (err) => {
  log('FAIL:', err.message);
  process.exit(1);
});
