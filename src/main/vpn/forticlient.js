const fs = require('fs');
const { spawn } = require('child_process');
const { run, powershell, firstExisting, waitFor, fail } = require('./util');

// FortiClient and the free FortiClient VPN from Fortinet. FortiClient for Linux has commands for its VPN. The Windows
// and macOS versions have none, so there JConnect opens FortiClient for the sign-in and waits for the tunnel.

const APP = {
  win32: ['C:\\Program Files\\Fortinet\\FortiClient\\FortiClient.exe', 'C:\\Program Files (x86)\\Fortinet\\FortiClient\\FortiClient.exe'],
  darwin: ['/Applications/FortiClient.app'],
  linux: ['/opt/forticlient/gui/FortiClient', '/opt/forticlient/gui/FortiClient-linux-x64/FortiClient'],
};
const LINUX_CLI = ['/usr/bin/forticlient', '/opt/forticlient/forticlient-cli'];
const MAC_PROFILES = '/Library/Application Support/Fortinet/FortiClient/conf/vpn.plist';
const SIGN_IN_WAIT_MS = 120000;

// Connections saved in FortiClient for Windows (SSL VPN and IPsec), and the state of Fortinet's virtual network adapters.
const WINDOWS_STATE = String.raw`$profiles = @(foreach ($root in 'HKLM:\SOFTWARE\Fortinet\FortiClient', 'HKLM:\SOFTWARE\WOW6432Node\Fortinet\FortiClient') { foreach ($kind in 'Sslvpn', 'IPSec') { Get-ChildItem -LiteralPath ($root + '\' + $kind + '\Tunnels') -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Name = $_.PSChildName; Server = [string](Get-ItemProperty -LiteralPath $_.PSPath).Server } } } }); $adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -like 'Fortinet*' } | Select-Object InterfaceDescription, Status); [pscustomobject]@{ profiles = $profiles; adapters = $adapters } | ConvertTo-Json -Compress -Depth 4`;

const clean = (value) => String(value == null ? '' : value).replace(/\p{Cc}/gu, '').trim().slice(0, 128);
const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const stripAnsi = (text) => String(text || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');

function unique(profiles) {
  const seen = new Set();
  return profiles.filter((p) => p.name && !seen.has(p.name) && seen.add(p.name));
}

function parseWindows(text) {
  let data = {};
  try { data = JSON.parse(text) || {}; } catch { /* nothing readable */ }
  return {
    profiles: unique(asList(data.profiles).filter(Boolean).map((p) => ({ name: clean(p.Name), server: clean(p.Server) || null }))),
    connected: asList(data.adapters).some((a) => a && a.Status === 'Up'),
  };
}

function parseMacProfiles(data) {
  if (!data || typeof data !== 'object') return [];
  const key = Object.keys(data).find((k) => /^profiles$/i.test(k));
  const value = key ? data[key] : null;
  const entries = Array.isArray(value)
    ? value.map((p) => [p && (p.Name || p.name), p])
    : Object.entries(value && typeof value === 'object' ? value : {});
  const serverOf = (p) => (p && typeof p === 'object' ? clean(p.Server || p.server || p.ServerAddress || '') : '');
  return unique(entries.map(([name, p]) => ({ name: typeof name === 'string' ? clean(name) : '', server: serverOf(p) || null })));
}

// FortiClient for macOS adds its tunnel to the system's list of VPN services.
function macConnected(text) {
  return String(text || '').split('\n').some((line) => /\(Connected\)/.test(line) && /fortinet|forticlient/i.test(line));
}

// Lines such as "Status: Connected" or "  Remote Gateway: vpn.example.com", by lowercase label.
function parseFields(text) {
  const fields = {};
  for (const line of stripAnsi(text).split('\n')) {
    const m = /^\s*([A-Za-z][^:]*?)\s*:\s*(.*)$/.exec(line);
    if (m && !(m[1].toLowerCase() in fields)) fields[m[1].toLowerCase()] = clean(m[2]);
  }
  return fields;
}

// "forticlient vpn status" prints "Status: Not Running", "Status: Connecting", or "Status: Connected" with details.
function parseLinuxStatus(text) {
  const fields = parseFields(text);
  return { connected: /^connected\b/i.test(fields.status || ''), name: fields['vpn name'] || null };
}

// "forticlient vpn list" prints headings that end in a colon ("VPNs:", "Personal VPNs:") with one profile per line
// under them, or "(No VPN profile found)".
function parseLinuxList(text) {
  return unique(stripAnsi(text).split('\n').map((line) => line.trim())
    .filter((line) => line && !line.endsWith(':') && !/^\(.*\)$/.test(line))
    .map((line) => ({ name: clean(line), server: null })));
}

// "forticlient vpn view <name>". The command line can only connect when nothing has to be asked: no single sign-on,
// and a saved password or none needed.
function parseLinuxProfile(text) {
  const fields = parseFields(text);
  const enabled = (label) => /^enabled$/i.test(fields[label] || '');
  return {
    server: fields['remote gateway'] || null,
    asks: enabled('single sign on (sso) for vpn tunnel') || (/prompt/i.test(fields.authentication || '') && !enabled('save password')),
  };
}

function cliProblem(result) {
  const m = /Error:\s*([^\n]+)/.exec(stripAnsi(`${result.stderr}\n${result.stdout}`));
  return m ? clean(m[1]) : null;
}

function create() {
  const platform = process.platform;
  const app = () => firstExisting(APP[platform] || []);
  const cli = () => (platform === 'linux' ? firstExisting(LINUX_CLI) : null);
  // FortiClient for Windows and macOS doesn't say which connection is up, so JConnect remembers the one it started.
  let lastProfile = null;

  async function state() {
    const none = { installed: false, profiles: [], connected: false };
    if (platform === 'win32') {
      if (!app()) return none;
      return { installed: true, ...parseWindows((await powershell(WINDOWS_STATE, { timeout: 15000 })).stdout) };
    }
    if (platform === 'darwin') {
      if (!app()) return none;
      const [plist, services] = await Promise.all([
        fs.existsSync(MAC_PROFILES) ? run('plutil', ['-convert', 'json', '-o', '-', MAC_PROFILES], { timeout: 5000 }) : { stdout: '' },
        run('scutil', ['--nc', 'list'], { timeout: 5000 }),
      ]);
      let data = null;
      try { data = JSON.parse(plist.stdout); } catch { /* unreadable, so no saved connections are listed */ }
      return { installed: true, profiles: parseMacProfiles(data), connected: macConnected(services.stdout) };
    }
    const exe = cli();
    if (!exe) return app() ? { ...none, installed: true } : none;
    const [list, status] = await Promise.all([run(exe, ['vpn', 'list'], { timeout: 10000 }), run(exe, ['vpn', 'status'], { timeout: 10000 })]);
    const now = parseLinuxStatus(status.stdout);
    return {
      installed: true,
      profiles: list.code === 0 ? parseLinuxList(list.stdout) : [],
      connected: now.connected,
      current: now.name,
      problem: list.code === 0 ? null : cliProblem(list),
    };
  }

  const connected = async () => (await state()).connected;

  function openApp() {
    const exe = app();
    const [file, args] = platform === 'darwin' && exe ? ['open', ['-a', exe]] : exe ? [exe, []] : cli() ? [cli(), ['gui']] : [];
    if (!file) return false;
    const child = spawn(file, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  }

  return {
    id: 'forticlient',
    name: 'FortiClient',
    kind: 'tunnel',
    website: 'https://www.fortinet.com/support/product-downloads#vpn',

    async detect() {
      const s = await state();
      if (!s.installed) return { installed: false };
      const isUp = (p) => s.connected && (s.current ? p.name === s.current : s.profiles.length === 1 || p.name === lastProfile);
      return {
        installed: true,
        running: true,
        connected: s.connected,
        account: s.profiles.map((p) => p.name).join(', ') || null,
        tunnels: s.profiles.map((p) => ({ name: p.name, connected: isUp(p), server: p.server })),
        detail: s.problem || (s.profiles.length ? `${s.profiles.length} connection${s.profiles.length === 1 ? '' : 's'}` : 'Add a VPN connection in FortiClient'),
      };
    },

    async connect({ arg, onProgress = () => {} } = {}) {
      const s = await state();
      if (!s.installed) throw fail('not-installed');
      if (s.connected) return;
      const profile = s.profiles.find((p) => p.name === (arg || lastProfile)) || (arg ? null : s.profiles[0]) || null;
      const exe = cli();
      if (exe && profile) {
        const settings = parseLinuxProfile((await run(exe, ['vpn', 'view', profile.name], { timeout: 10000 })).stdout);
        if (!settings.asks) {
          onProgress(`Connecting FortiClient (${profile.name})…`);
          await run(exe, ['vpn', 'connect', profile.name], { timeout: 60000 });
          if (await connected()) {
            lastProfile = profile.name;
            return;
          }
        }
      }
      if (!openApp()) throw fail('vpn-not-connected');
      onProgress(profile ? `Connect ${profile.name} in FortiClient…` : 'Connect your VPN in FortiClient…');
      if (!(await waitFor(connected, { timeoutMs: SIGN_IN_WAIT_MS, everyMs: 2000 }))) throw fail('vpn-not-connected');
      if (profile) lastProfile = profile.name;
    },

    async disconnect({ onProgress = () => {} } = {}) {
      const exe = cli();
      if (exe) await run(exe, ['vpn', 'disconnect'], { timeout: 30000 });
      if (!(await connected()) || !openApp()) return;
      onProgress('Disconnect in FortiClient…');
      await waitFor(async () => !(await connected()), { timeoutMs: 60000, everyMs: 2000 });
    },

    // Opens FortiClient, where connections are added and signed in to.
    async signIn() {
      if (!openApp()) throw fail('not-installed');
    },

    async machines() { return []; },
    async addressesFor() { return []; },
  };
}

module.exports = { create, parseWindows, parseMacProfiles, macConnected, parseLinuxStatus, parseLinuxList, parseLinuxProfile };
