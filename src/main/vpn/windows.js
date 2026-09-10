const { spawn } = require('child_process');
const { run, powershell, waitFor, fail } = require('./util');

// VPN connections set up in Windows Settings (IKEv2, SSTP, L2TP, PPTP and vendor plug-ins).
function create() {
  async function profiles() {
    if (process.platform !== 'win32') return [];
    const r = await powershell('@(Get-VpnConnection; Get-VpnConnection -AllUserConnection) | Select-Object Name,ServerAddress,ConnectionStatus,TunnelType | ConvertTo-Json -Compress', { timeout: 10000 });
    try {
      const parsed = JSON.parse(r.stdout || '[]');
      return (Array.isArray(parsed) ? parsed : [parsed]).filter((p) => p && p.Name);
    } catch {
      return [];
    }
  }

  return {
    id: 'windows',
    name: 'Windows VPN',
    kind: 'system',
    website: 'ms-settings:network-vpn',

    async detect() {
      if (process.platform !== 'win32') return { installed: false };
      const list = await profiles();
      return {
        installed: list.length > 0,
        running: true,
        connected: list.some((p) => p.ConnectionStatus === 'Connected'),
        account: list.map((p) => p.Name).join(', ') || null,
        tunnels: list.map((p) => ({ name: p.Name, connected: p.ConnectionStatus === 'Connected', server: p.ServerAddress })),
        detail: list.length ? `${list.length} connection${list.length === 1 ? '' : 's'}` : 'No VPN connections in Windows Settings',
      };
    },

    async connect({ arg, onProgress = () => {} } = {}) {
      const list = await profiles();
      const profile = list.find((p) => p.Name === arg) || list[0];
      if (!profile) throw fail('not-installed');
      if (profile.ConnectionStatus === 'Connected') return;
      onProgress(`Connecting ${profile.Name}…`);
      const r = await run('rasdial.exe', [profile.Name], { timeout: 60000 });
      if (r.code !== 0) {
        // Needs credentials Windows hasn't saved: hand over to Windows' own VPN screen.
        spawn('explorer.exe', ['ms-settings:network-vpn'], { detached: true, stdio: 'ignore' }).unref();
        const ok = await waitFor(async () => (await profiles()).some((p) => p.Name === profile.Name && p.ConnectionStatus === 'Connected'), { timeoutMs: 90000, everyMs: 2000 });
        if (!ok) throw fail('vpn-not-connected');
      }
    },

    async disconnect({ arg } = {}) {
      for (const p of (await profiles()).filter((x) => !arg || x.Name === arg)) {
        await run('rasdial.exe', [p.Name, '/disconnect'], { timeout: 20000 });
      }
    },

    async machines() { return []; },
    async addressesFor() { return []; },
  };
}

module.exports = { create };
