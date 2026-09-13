const fs = require('fs');
const net = require('net');
const http = require('http');
const { execFile } = require('child_process');
const JCSecure = require('../../shared/secure-channel');

const fail = (code, extra) => JCSecure.failure(code, extra);

// Runs a program and always resolves: { code, stdout, stderr }.
function run(file, args = [], { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : err.code || 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    // Nothing is ever typed into these programs, so one that asks for a password gets end of input at once
    // instead of waiting for the timeout.
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end();
    }
  });
}

function powershell(script, options) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], options);
}

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

// Asks the operating system for administrator rights in its normal way (UAC, a password prompt, pkexec).
async function elevate(file, args = []) {
  if (process.platform === 'win32') {
    const argList = args.map((a) => `'"${String(a).replace(/'/g, "''").replace(/"/g, '\\"')}"'`).join(',');
    const script = `$p = Start-Process -FilePath ${psQuote(file)} ${args.length ? `-ArgumentList ${argList}` : ''} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
    const r = await powershell(script, { timeout: 120000 });
    if (/canceled by the user|operation was canceled/i.test(r.stderr)) throw fail('elevation-cancelled');
    return r;
  }
  if (process.platform === 'darwin') {
    const command = [file, ...args].map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');
    return run('osascript', ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`], { timeout: 120000 });
  }
  return run('pkexec', [file, ...args], { timeout: 120000 });
}

const firstExisting = (paths) => paths.find((p) => p && fs.existsSync(p)) || null;

async function windowsService(name) {
  if (process.platform !== 'win32') return 'unknown';
  const r = await run('sc.exe', ['query', name], { timeout: 5000 });
  if (/FAILED 1060/.test(r.stdout)) return 'missing';
  if (/STATE\s*:\s*4\s+RUNNING/.test(r.stdout)) return 'running';
  if (/STATE\s*:\s*[23]/.test(r.stdout)) return 'starting';
  if (/STATE\s*:\s*1\s+STOPPED/.test(r.stdout)) return 'stopped';
  return 'unknown';
}

async function startWindowsService(name) {
  const state = await windowsService(name);
  if (state === 'running' || state === 'missing') return state;
  const r = await elevate('powershell.exe', ['-NoProfile', '-Command', `Start-Service -Name ${psQuote(name)}`]);
  return r.code === 0 ? 'running' : 'stopped';
}

function tcpOpen(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function jconnectInfo(host, port = 47801, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/info', timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve(info && info.app === 'jconnect' && JCSecure.deviceIdFromKey(info.publicKey) === info.id ? info : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// What can we do with this machine? JConnect, SSH, Remote Desktop.
async function scanServices(host) {
  const [jconnect, ssh, rdp] = await Promise.all([jconnectInfo(host), tcpOpen(host, 22), tcpOpen(host, 3389)]);
  return { jconnect, ssh, rdp };
}

async function waitFor(check, { timeoutMs = 30000, everyMs = 1000 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

module.exports = { run, powershell, elevate, firstExisting, windowsService, startWindowsService, tcpOpen, jconnectInfo, scanServices, waitFor, fail, psQuote };
