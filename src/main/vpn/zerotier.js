const https = require('https');
const { run, firstExisting, startWindowsService, elevate, waitFor, fail } = require('./util');

const CLI = {
  win32: ['C:\\ProgramData\\ZeroTier\\One\\zerotier-one_x64.exe', 'C:\\ProgramData\\ZeroTier\\One\\zerotier-one_x86.exe'],
  darwin: ['/usr/local/bin/zerotier-cli', '/opt/homebrew/bin/zerotier-cli'],
  linux: ['/usr/sbin/zerotier-cli', '/usr/bin/zerotier-cli'],
};

function central(token, pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: 'api.zerotier.com', path: `/api/v1${pathname}`, headers: { Authorization: `token ${token}` }, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) { reject(fail('credentials')); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(fail('api')); }
      });
    });
    req.on('timeout', () => req.destroy(fail('unreachable')));
    req.on('error', () => reject(fail('unreachable')));
    req.end();
  });
}

function create({ store }) {
  const settings = () => store.data.vpn.zerotier || {};
  const exe = () => firstExisting(CLI[process.platform] || []);
  const cli = async (args) => {
    const file = exe();
    if (!file) return null;
    const full = process.platform === 'win32' ? ['-q', '-j', ...args] : ['-j', ...args];
    const r = await run(file, full, { timeout: 8000 });
    try { return JSON.parse(r.stdout); } catch { return null; }
  };

  return {
    id: 'zerotier',
    name: 'ZeroTier',
    kind: 'mesh',
    website: 'https://www.zerotier.com/download/',

    async detect() {
      if (!exe()) return { installed: false };
      const info = await cli(['info']);
      const networks = (await cli(['listnetworks'])) || [];
      return {
        installed: true,
        running: !!info,
        connected: networks.some((n) => n.status === 'OK'),
        account: (settings().networks || []).join(', ') || null,
        canImport: !!settings().token,
        detail: info ? (info.online ? 'Online' : 'Offline') : 'Service stopped (may need administrator rights to check)',
      };
    },

    async connect({ onProgress = () => {} } = {}) {
      if (!exe()) throw fail('not-installed');
      onProgress('Starting ZeroTier…');
      if (process.platform === 'win32') await startWindowsService('ZeroTierOneService');
      for (const id of settings().networks || []) {
        if (process.platform === 'win32') await elevate(exe(), ['-q', 'join', id]);
        else await elevate(exe(), ['join', id]);
      }
      const ok = await waitFor(async () => (await this.detect()).connected, { timeoutMs: 45000 });
      if (!ok) throw fail('vpn-not-connected');
    },

    async disconnect() {
      for (const id of settings().networks || []) {
        if (process.platform === 'win32') await elevate(exe(), ['-q', 'leave', id]);
        else await elevate(exe(), ['leave', id]);
      }
    },

    async signIn({ token, networks }) {
      const ids = String(networks || '').split(/[\s,]+/).filter((id) => /^[0-9a-f]{16}$/i.test(id));
      if (!ids.length) throw fail('network');
      if (token) await central(String(token).trim(), `/network/${ids[0]}`);
      store.update((d) => { d.vpn.zerotier = { networks: ids, token: token ? store.seal(String(token).trim()) : null }; });
    },

    async signOut() {
      store.update((d) => { delete d.vpn.zerotier; });
    },

    async machines() {
      const token = store.unseal(settings().token);
      if (!token) throw fail('account-required');
      const out = [];
      for (const id of settings().networks || []) {
        const members = await central(token, `/network/${id}/member`);
        for (const m of members) {
          const ip = m.config && (m.config.ipAssignments || [])[0];
          if (!ip) continue;
          out.push({ key: `zerotier:${m.nodeId || m.id}`, name: m.name || m.nodeId, host: ip, online: m.lastSeen ? Date.now() - m.lastSeen < 5 * 60 * 1000 : null });
        }
      }
      return out;
    },

    async addressesFor() { return []; },
  };
}

module.exports = { create };
