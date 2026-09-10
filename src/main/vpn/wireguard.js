const fs = require('fs');
const path = require('path');
const { run, firstExisting, windowsService, elevate, waitFor, fail } = require('./util');

const APP = {
  win32: ['C:\\Program Files\\WireGuard\\wireguard.exe'],
  darwin: ['/opt/homebrew/bin/wg-quick', '/usr/local/bin/wg-quick'],
  linux: ['/usr/bin/wg-quick'],
};

function parseConfig(text) {
  const peers = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    if (/^\[peer\]$/i.test(line)) { current = { allowed: [] }; peers.push(current); continue; }
    if (/^\[/.test(line)) { current = null; continue; }
    const m = /^([^=]+)=(.*)$/.exec(line);
    if (m && current && /^allowedips$/i.test(m[1].trim())) current.allowed.push(...m[2].split(',').map((s) => s.trim()).filter(Boolean));
    if (m && current && /^endpoint$/i.test(m[1].trim())) current.endpoint = m[2].trim();
  }
  return { peers };
}

function create({ store }) {
  const tunnels = () => (store.data.vpn.wireguard && store.data.vpn.wireguard.tunnels) || [];
  const app = () => firstExisting(APP[process.platform] || []);
  const serviceName = (name) => `WireGuardTunnel$${name}`;

  async function active(name) {
    if (process.platform === 'win32') return (await windowsService(serviceName(name))) === 'running';
    return (await run('ip', ['link', 'show', name], { timeout: 4000 })).code === 0;
  }

  return {
    id: 'wireguard',
    name: 'WireGuard',
    kind: 'tunnel',
    website: 'https://www.wireguard.com/install/',

    async detect() {
      if (!app()) return { installed: false };
      const list = tunnels();
      const states = await Promise.all(list.map((t) => active(t.name)));
      return {
        installed: true,
        running: true,
        connected: states.some(Boolean),
        account: list.map((t) => t.name).join(', ') || null,
        tunnels: list.map((t, i) => ({ name: t.name, connected: states[i] })),
        canImport: list.length > 0,
        detail: list.length ? `${list.length} tunnel${list.length === 1 ? '' : 's'}` : 'Add a tunnel file',
      };
    },

    async connect({ arg, onProgress = () => {} } = {}) {
      const exe = app();
      if (!exe) throw fail('not-installed');
      const tunnel = tunnels().find((t) => t.name === arg) || tunnels()[0];
      if (!tunnel) throw fail('account-required');
      if (await active(tunnel.name)) return;
      onProgress(`Connecting WireGuard (${tunnel.name})…`);
      if (process.platform === 'win32') await elevate(exe, ['/installtunnelservice', tunnel.path]);
      else await elevate(exe, ['up', tunnel.path]);
      const ok = await waitFor(() => active(tunnel.name), { timeoutMs: 30000 });
      if (!ok) throw fail('vpn-not-connected');
    },

    async disconnect({ arg } = {}) {
      const exe = app();
      for (const tunnel of tunnels().filter((t) => !arg || t.name === arg)) {
        if (process.platform === 'win32') await elevate(exe, ['/uninstalltunnelservice', tunnel.name]);
        else await elevate(exe, ['down', tunnel.path]);
      }
    },

    // Remember a tunnel file (it stays where it is; it holds a private key).
    async signIn({ filePath }) {
      const text = fs.readFileSync(filePath, 'utf8');
      if (!/\[interface\]/i.test(text)) throw fail('bad-config');
      const name = path.basename(filePath, path.extname(filePath)).replace(/[^\w.-]/g, '').slice(0, 32) || 'tunnel';
      store.update((d) => {
        const list = ((d.vpn.wireguard && d.vpn.wireguard.tunnels) || []).filter((t) => t.name !== name);
        d.vpn.wireguard = { tunnels: [...list, { name, path: filePath }] };
      });
    },

    async signOut({ arg } = {}) {
      store.update((d) => {
        const list = ((d.vpn.wireguard && d.vpn.wireguard.tunnels) || []).filter((t) => arg && t.name !== arg);
        d.vpn.wireguard = { tunnels: list };
      });
    },

    async machines() {
      const out = [];
      for (const tunnel of tunnels()) {
        let text;
        try { text = fs.readFileSync(tunnel.path, 'utf8'); } catch { continue; }
        parseConfig(text).peers.forEach((peer, i) => {
          for (const cidr of peer.allowed) {
            const m = /^(\d+\.\d+\.\d+\.\d+)\/32$/.exec(cidr);
            if (m) out.push({ key: `wireguard:${tunnel.name}:${m[1]}`, name: `${tunnel.name} peer ${i + 1}`, host: m[1], online: null });
          }
        });
      }
      return out;
    },

    async addressesFor() { return []; },
  };
}

module.exports = { create, parseConfig };
