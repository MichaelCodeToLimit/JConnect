// Keeps JConnect up to date on Windows, macOS and Linux.
//
// Next to each download, the website publishes <download>.json with the download's version, size and SHA-256
// (written by scripts/update-info.js). JConnect reads that file, downloads the new version, makes sure it has exactly
// that size and SHA-256, then installs it the way this copy was installed and starts again:
//   Windows  the installer runs silently. JConnect is installed per user, so no administrator rights are needed.
//   macOS    the JConnect.app from the new disk image replaces this one.
//   Linux    the .deb is installed after the system's own password prompt.
// The portable Windows app, an AppImage, and a Mac app that can't replace itself are updated from the website by hand.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { finished } = require('stream/promises');
const { EventEmitter } = require('events');
const { run, psQuote } = require('./vpn/util');

const UPDATE_BASE = 'https://jconnect-1dsx.onrender.com/download/';
const APP_ID = 'app.jconnect.desktop';
const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const IDLE_RETRY_MS = 60 * 1000;
const MIN_SIZE = 1024 * 1024;
const MAX_SIZE = 1024 * 1024 * 1024;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const failure = (code, detail) => Object.assign(new Error(detail || code), { code });
const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

// -1, 0 or 1 like a sort comparator, or null when either isn't a version. 0.1.0-beta.10 is newer than 0.1.0-beta.9,
// and 0.1.0 is newer than any 0.1.0 beta.
function compareVersions(a, b) {
  const pa = SEMVER.exec(String(a));
  const pb = SEMVER.exec(String(b));
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  if (!pa[4] || !pb[4]) return pa[4] === pb[4] ? 0 : pa[4] ? -1 : 1;
  const xa = pa[4].split('.');
  const xb = pb[4].split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb) {
      const d = Number(xa[i]) - Number(xb[i]);
      if (d) return Math.sign(d);
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (xa[i] !== xb[i]) {
      return xa[i] < xb[i] ? -1 : 1;
    }
  }
  return 0;
}

// The website's description of a download. Anything unexpected in it means there's no usable update.
function parseUpdateInfo(text, file) {
  let info;
  try { info = JSON.parse(text); } catch { return null; }
  if (!info || info.app !== 'jconnect' || info.file !== file) return null;
  if (typeof info.version !== 'string' || info.version.length > 64 || !SEMVER.test(info.version)) return null;
  if (typeof info.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(info.sha256)) return null;
  if (!Number.isInteger(info.size) || info.size < MIN_SIZE || info.size > MAX_SIZE) return null;
  return { file, version: info.version, sha256: info.sha256, size: info.size };
}

// Which download updates this copy of JConnect, and how it can be installed.
function updateTarget({ platform, arch, env = {}, execPath, exists = fs.existsSync }) {
  if (platform === 'win32') {
    const installed = !env.PORTABLE_EXECUTABLE_FILE && exists(path.win32.join(path.win32.dirname(execPath), 'Uninstall JConnect.exe'));
    return { file: 'JConnect-Setup.exe', method: installed ? 'nsis' : 'manual' };
  }
  if (platform === 'darwin') {
    const bundle = path.posix.resolve(execPath, '..', '..', '..');
    // A Mac app opened straight from the disk image, or moved there by App Translocation, can't be replaced.
    const replaceable = /\.app$/.test(bundle) && !execPath.includes('/AppTranslocation/') && !execPath.startsWith('/Volumes/');
    return { file: arch === 'arm64' ? 'JConnect-Mac-AppleSilicon.dmg' : 'JConnect-Mac-Intel.dmg', method: replaceable ? 'dmg' : 'manual', bundle };
  }
  if (platform === 'linux') {
    const deb = !env.APPIMAGE && exists('/var/lib/dpkg/info/jconnect.list');
    return { file: 'JConnect-Linux.deb', method: deb ? 'deb' : 'manual' };
  }
  return null;
}

// Updates come from JConnect's website. JCONNECT_UPDATE_URL can point a development copy anywhere, and any copy at a
// server on this computer for testing: something already running here could do more harm than that anyway.
function updateBase(env, isPackaged) {
  if (!env.JCONNECT_UPDATE_URL) return UPDATE_BASE;
  let url;
  try { url = new URL(env.JCONNECT_UPDATE_URL); } catch { return UPDATE_BASE; }
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (isPackaged && !local) return UPDATE_BASE;
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

// Downloads url to dest. It only ends up there with exactly the expected size and SHA-256.
async function download(url, dest, { size, sha256, onProgress = () => {}, signal } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let res;
  try {
    res = await fetch(url, { cache: 'no-store', signal });
  } catch (err) {
    throw failure('update-download', err.message);
  }
  if (!res.ok || !res.body) throw failure('update-download', `HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length'));
  if (length && length !== size) throw failure('update-corrupt', `the server offers ${length} bytes instead of ${size}`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let received = 0;
  let reported = 0;
  try {
    for await (const chunk of res.body) {
      received += chunk.length;
      if (received > size) throw failure('update-corrupt', 'the download is larger than announced');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      if (received - reported >= size / 100) {
        reported = received;
        onProgress(received / size);
      }
    }
    out.end();
    await finished(out);
    if (received !== size) throw failure('update-corrupt', `the download stopped at ${received} of ${size} bytes`);
    if (hash.digest('hex') !== sha256) throw failure('update-corrupt', 'the download doesn’t match its SHA-256');
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw String(err.code).startsWith('update-') ? err : failure('update-download', err.message);
  }
  fs.renameSync(part, dest);
  return dest;
}

// ---------- installing ----------

// Waits for this JConnect to close, runs the silent installer, then starts the new JConnect. What happens goes to
// update-install.log next to JConnect's settings.
function startWindowsInstall(installer, hidden) {
  const logFile = path.join(path.dirname(path.dirname(installer)), 'update-install.log');
  const exeName = path.win32.parse(process.execPath).name;
  const script = [
    `Start-Transcript -Path ${psQuote(logFile)} -Force | Out-Null`,
    `Wait-Process -Id ${process.pid} -Timeout 30 -ErrorAction SilentlyContinue`,
    // Electron's helper processes can outlive the main one for a moment, and the installer won't replace files in use.
    `Get-Process -Name ${psQuote(exeName)} -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${psQuote(process.execPath)} } | Wait-Process -Timeout 30 -ErrorAction SilentlyContinue`,
    `$setup = Start-Process -Wait -PassThru -FilePath ${psQuote(installer)} -ArgumentList '/S','--updated'`,
    `"installer exit code: $($setup.ExitCode)"`,
    `Start-Process -FilePath ${psQuote(process.execPath)}${hidden ? " -ArgumentList '--hidden'" : ''}`,
    'Stop-Transcript | Out-Null',
  ].join('; ');
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], {
    detached: true, stdio: 'ignore', windowsHide: true,
  }).unref();
}

// Copies JConnect.app out of the disk image next to this one, after checking it's JConnect and its signature is intact.
async function stageMacApp(dmg, bundle) {
  const parent = path.dirname(bundle);
  try {
    fs.accessSync(parent, fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch {
    throw failure('update-permission');
  }
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'jconnect-update-'));
  const staged = path.join(parent, `.JConnect-update-${process.pid}.app`);
  const attached = await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg], { timeout: 180000 });
  if (attached.code !== 0) throw failure('update-install', attached.stderr);
  try {
    const source = path.join(mount, 'JConnect.app');
    const id = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(source, 'Contents', 'Info.plist')]);
    if (id.stdout.trim() !== APP_ID) throw failure('update-corrupt', 'the disk image doesn’t contain JConnect');
    const signature = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source], { timeout: 180000 });
    if (signature.code !== 0) throw failure('update-corrupt', signature.stderr);
    fs.rmSync(staged, { recursive: true, force: true });
    const copied = await run('/usr/bin/ditto', [source, staged], { timeout: 600000 });
    if (copied.code !== 0) throw failure('update-install', copied.stderr);
    return staged;
  } catch (err) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw err;
  } finally {
    await run('/usr/bin/hdiutil', ['detach', mount, '-force'], { timeout: 60000 });
    fs.rmdir(mount, () => {});
  }
}

// Waits for this JConnect to close, swaps in the new app (putting the old one back if that fails), and opens it.
function startMacSwap(staged, bundle, hidden) {
  const old = `${bundle}.previous-${process.pid}`;
  const script = [
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
    `if mv ${shellQuote(bundle)} ${shellQuote(old)}; then`,
    `  if mv ${shellQuote(staged)} ${shellQuote(bundle)}; then rm -rf ${shellQuote(old)}; else mv ${shellQuote(old)} ${shellQuote(bundle)}; fi`,
    'fi',
    `xattr -dr com.apple.quarantine ${shellQuote(bundle)} 2>/dev/null`,
    `open ${shellQuote(bundle)}${hidden ? ' --args --hidden' : ''}`,
  ].join('\n');
  spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
}

// The system asks for an administrator password, then installs the package over this one.
async function installDeb(deb) {
  const command = fs.existsSync('/usr/bin/apt-get') ? ['/usr/bin/apt-get', 'install', '-y', deb] : ['/usr/bin/dpkg', '-i', deb];
  const result = await run('pkexec', command, { timeout: 15 * 60 * 1000 });
  if (result.code === 126 || result.code === 127) throw failure('elevation-cancelled');
  if (result.code !== 0) throw failure('update-install', (result.stderr || result.stdout).slice(-500));
}

// Starts JConnect again once this copy has closed.
function startRelaunch(exe, hidden) {
  const script = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done; exec ${shellQuote(exe)}${hidden ? ' --hidden' : ''}`;
  spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
}

// ---------- the updater ----------

// isIdle: nobody is using JConnect right now. beforeInstall(version): tells connected devices and saves, and returns
// { hidden } so the new JConnect starts the way this one was showing. quit: closes JConnect for the installer.
function createUpdater({ app, store, isIdle, beforeInstall, quit, notify, openExternal }) {
  const events = new EventEmitter();
  const base = updateBase(process.env, app.isPackaged);
  const target = updateTarget({ platform: process.platform, arch: process.arch, env: process.env, execPath: process.execPath });
  const canCheck = !!target && (app.isPackaged || base !== UPDATE_BASE);
  const dir = path.join(app.getPath('userData'), 'updates');
  const s = { state: canCheck ? 'idle' : 'unavailable', available: null, progress: 0, error: null, checkedAt: 0 };
  let downloaded = null;
  let busy = false;
  let checkTimer = null;
  let idleTimer = null;
  const told = new Set();

  const change = (patch) => {
    Object.assign(s, patch);
    events.emit('change');
  };
  const auto = () => store.settings.autoUpdate !== false;
  // Only the Windows installer updates without asking anything. macOS asks again for Screen Recording and
  // Accessibility after an update, and a .deb needs an administrator password, so those wait for someone to agree.
  const unattended = () => !!target && target.method === 'nsis';

  function tell(key, title, body) {
    if (told.has(key)) return;
    told.add(key);
    notify(title, body);
  }

  function snapshot() {
    return {
      current: app.getVersion(),
      state: s.state,
      method: target ? target.method : null,
      available: s.available ? { version: s.available.version, size: s.available.size } : null,
      progress: s.progress,
      error: s.error,
      checkedAt: s.checkedAt,
      unattended: unattended(),
      downloadPage: base,
    };
  }

  async function check() {
    if (!canCheck || busy) return snapshot();
    busy = true;
    change({ state: 'checking', error: null });
    try {
      const res = await fetch(`${base}${target.file}.json`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      // No description published for this download yet.
      if (res.status === 404) {
        change({ state: 'up-to-date', available: null, checkedAt: Date.now() });
        return snapshot();
      }
      if (!res.ok) throw failure('update-check', `HTTP ${res.status}`);
      const info = parseUpdateInfo((await res.text()).slice(0, 4096), target.file);
      if (!info) throw failure('update-check', 'the update description is unusable');
      if (compareVersions(info.version, app.getVersion()) !== 1) {
        downloaded = null;
        change({ state: 'up-to-date', available: null, checkedAt: Date.now() });
        return snapshot();
      }
      const ready = downloaded && downloaded.sha256 === info.sha256 && fs.existsSync(downloaded.path);
      change({ state: ready ? 'ready' : 'available', available: info, checkedAt: Date.now() });
    } catch (err) {
      const state = s.available ? (downloaded ? 'ready' : 'available') : 'error';
      change({ state, error: err.code || 'update-check', checkedAt: Date.now() });
      return snapshot();
    } finally {
      busy = false;
      schedule(CHECK_EVERY_MS);
    }
    if (s.state === 'available') {
      if (auto() && target.method !== 'manual') await fetchUpdate().catch(() => {});
      else tell(`available ${s.available.version}`, 'JConnect update available', `JConnect ${s.available.version} is available.`);
    }
    if (s.state === 'ready') whenReady();
    return snapshot();
  }

  async function fetchUpdate() {
    if (!s.available || busy) return;
    const info = s.available;
    if (downloaded && downloaded.sha256 === info.sha256 && fs.existsSync(downloaded.path)) {
      change({ state: 'ready' });
      return;
    }
    busy = true;
    change({ state: 'downloading', progress: 0, error: null });
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      const file = await download(`${base}${info.file}`, path.join(dir, info.file), {
        size: info.size,
        sha256: info.sha256,
        onProgress: (progress) => change({ progress }),
      });
      downloaded = { path: file, sha256: info.sha256 };
      change({ state: 'ready', progress: 1 });
    } catch (err) {
      change({ state: 'error', error: err.code || 'update-download' });
      throw err;
    } finally {
      busy = false;
    }
  }

  // An update is downloaded: install it now if nobody would notice, otherwise say it's ready.
  function whenReady() {
    clearTimeout(idleTimer);
    if (s.state !== 'ready') return;
    if (auto() && unattended()) {
      if (isIdle()) install().catch(() => {});
      else idleTimer = setTimeout(whenReady, IDLE_RETRY_MS);
      return;
    }
    tell(`ready ${s.available.version}`, 'JConnect update ready', `JConnect ${s.available.version} is ready. Open JConnect to restart and update.`);
  }

  async function install() {
    if (!target || !s.available || busy) return;
    if (target.method === 'manual') {
      openExternal(base);
      return;
    }
    // A development copy never replaces itself.
    if (!app.isPackaged) throw failure('update-dev');
    if (s.state !== 'ready') await fetchUpdate();
    busy = true;
    change({ state: 'installing', error: null });
    try {
      const version = s.available.version;
      if (target.method === 'nsis') {
        const { hidden } = await beforeInstall(version);
        startWindowsInstall(downloaded.path, hidden);
      } else if (target.method === 'dmg') {
        const staged = await stageMacApp(downloaded.path, target.bundle);
        const { hidden } = await beforeInstall(version);
        startMacSwap(staged, target.bundle, hidden);
      } else {
        await installDeb(downloaded.path);
        const { hidden } = await beforeInstall(version);
        startRelaunch(process.execPath, hidden);
      }
      quit();
    } catch (err) {
      busy = false;
      change({ state: downloaded ? 'ready' : 'error', error: err.code || 'update-install' });
      throw err;
    }
  }

  function schedule(ms) {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => { check().catch(() => {}); }, ms);
  }

  return {
    events,
    snapshot,
    check,
    install,
    get downloadPage() { return base; },
    start() {
      if (!canCheck) return;
      fs.rm(dir, { recursive: true, force: true }, () => {});
      schedule(FIRST_CHECK_MS);
    },
    // Called when "Update automatically" changes.
    settingsChanged() {
      if (s.state === 'available' && auto() && target.method !== 'manual') fetchUpdate().then(whenReady).catch(() => {});
      else if (s.state === 'ready') whenReady();
    },
    stop() {
      clearTimeout(checkTimer);
      clearTimeout(idleTimer);
    },
  };
}

module.exports = { createUpdater, compareVersions, parseUpdateInfo, updateTarget, updateBase, download, UPDATE_BASE };
