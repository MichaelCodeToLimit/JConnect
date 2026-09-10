const http = require('http');
const { spawn } = require('child_process');
const { run, firstExisting, windowsService, startWindowsService, waitFor, fail, elevate } = require('./util');

const BINARIES = {
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'],
  darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'],
  linux: ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale'],
};

// Tailscale's local API, used only to switch "connected" back on without changing any other setting.
function localApiWantRunning() {
  const socketPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\ProtectedPrefix\\Administrators\\Tailscale\\tailscaled'
    : '/var/run/tailscale/tailscaled.sock';
  return new Promise((resolve) => {
    const body = JSON.stringify({ WantRunning: true, WantRunningSet: true });
    const req = http.request({
      socketPath,
      path: '/localapi/v0/prefs',
      method: 'PATCH',
      headers: { Host: 'local-tailscaled.sock', 'Sec-Tailscale': 'localapi', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000,
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

function create({ shell }) {
  const bin = () => firstExisting(BINARIES[process.platform] || []);

  async function statusJson() {
    const exe = bin();
    if (!exe) return null;
    const r = await run(exe, ['status', '--json'], { timeout: 8000 });
    try { return JSON.parse(r.stdout); } catch { return null; }
  }

  const ipv4 = (ips) => (ips || []).find((ip) => ip.includes('.')) || (ips || [])[0] || null;

  return {
    id: 'tailscale',
    name: 'Tailscale',
    kind: 'mesh',
    website: 'https://tailscale.com/download',

    async detect() {
      if (!bin()) return { installed: false };
      const s = await statusJson();
      if (!s) {
        const service = await windowsService('Tailscale');
        return { installed: true, running: false, connected: false, detail: service === 'stopped' ? 'The Tailscale service is stopped' : 'Tailscale isn’t running' };
      }
      const selfUser = s.Self && s.User && s.User[s.Self.UserID];
      return {
        installed: true,
        running: true,
        connected: s.BackendState === 'Running',
        needsSignIn: s.BackendState === 'NeedsLogin' || s.BackendState === 'NeedsMachineAuth',
        account: (s.CurrentTailnet && s.CurrentTailnet.Name) || (selfUser && selfUser.LoginName) || null,
        machines: Object.keys(s.Peer || {}).length,
        detail: s.BackendState,
      };
    },

    async connect({ onProgress = () => {} } = {}) {
      const exe = bin();
      if (!exe) throw fail('not-installed');
      let status = await this.detect();
      if (!status.running) {
        onProgress('Starting Tailscale…');
        if (process.platform === 'win32') await startWindowsService('Tailscale');
        else if (process.platform === 'darwin') spawn('open', ['-a', 'Tailscale'], { detached: true, stdio: 'ignore' }).unref();
        else await elevate('systemctl', ['start', 'tailscaled']);
        status = await waitFor(async () => { const s = await this.detect(); return s.running ? s : null; }, { timeoutMs: 30000 }) || status;
      }
      if (status.needsSignIn) {
        await this.signIn({ onProgress });
        status = await this.detect();
      }
      if (!status.connected) {
        onProgress('Connecting Tailscale…');
        const r = await run(exe, ['up'], { timeout: 30000 });
        if (r.code !== 0) await localApiWantRunning();
        const up = await waitFor(async () => (await this.detect()).connected, { timeoutMs: 30000 });
        if (!up) throw fail('vpn-not-connected');
      }
    },

    async disconnect() {
      const exe = bin();
      if (exe) await run(exe, ['down'], { timeout: 15000 });
    },

    async signIn({ onProgress = () => {} } = {}) {
      const exe = bin();
      if (!exe) throw fail('not-installed');
      onProgress('Sign in to Tailscale in your browser…');
      await new Promise((resolve) => {
        const child = spawn(exe, ['login'], { windowsHide: true });
        let opened = false;
        const onData = (chunk) => {
          const match = /https:\/\/login\.tailscale\.com\/\S+/.exec(String(chunk));
          if (match && !opened) {
            opened = true;
            shell.openExternal(match[0]);
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        const timer = setTimeout(() => { child.kill(); resolve(); }, 5 * 60 * 1000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
        child.on('error', () => { clearTimeout(timer); resolve(); });
      });
    },

    async machines() {
      const s = await statusJson();
      if (!s) return [];
      return Object.values(s.Peer || {}).map((p) => ({
        key: `tailscale:${p.ID || p.PublicKey}`,
        name: p.HostName || (p.DNSName || '').split('.')[0] || 'Tailscale device',
        host: ipv4(p.TailscaleIPs),
        dns: (p.DNSName || '').replace(/\.$/, ''),
        os: p.OS || '',
        online: !!p.Online,
      })).filter((m) => m.host);
    },

    // A JConnect computer paired at home can still be reached over Tailscale by its Tailscale address.
    async addressesFor(computer) {
      const list = await this.machines();
      const name = String(computer.name || '').toLowerCase();
      return list
        .filter((m) => m.online && (m.name.toLowerCase() === name || (computer.addresses || []).some((a) => a.host === m.host)))
        .map((m) => ({ host: m.host, port: ((computer.addresses || [])[0] || {}).port || 47801 }));
    },
  };
}

module.exports = { create };
