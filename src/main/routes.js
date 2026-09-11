// Picks how to reach a computer. Direct paths win; then networks that are already connected; then JVPN
// through JConnect Cloud; and finally the VPN chosen for that computer is started and tried.
const { resolveComputer, tcpProbe } = require('./discovery');
const { wsBase } = require('./jvpn');
const JCSecure = require('../shared/secure-channel');

const wsUrl = (host, port) => `ws://${host.includes(':') ? `[${host}]` : host}:${port}/ws`;

function createRouter({ store, discovery, vpn, account }) {
  const NAMES = () => Object.fromEntries([...vpn.providers.values()].map((p) => [p.id, p.name]));

  async function direct(computer) {
    const found = await resolveComputer(computer, discovery);
    return found ? { url: wsUrl(found.host, found.port), kind: found.kind, host: found.host, port: found.port } : null;
  }

  async function throughVpns(computer) {
    const extra = await vpn.addressesFor(computer).catch(() => []);
    if (!extra.length) return null;
    return direct({ ...computer, addresses: [...(computer.addresses || []), ...extra] });
  }

  async function throughJvpn(computer) {
    if (!store.settings.jvpnEnabled || !account.signedIn()) return null;
    const online = await account.presence([computer.id]).catch(() => []);
    if (!online.includes(computer.id)) return null;
    const ticket = await account.relayTicket(computer.id);
    return { url: `${wsBase(account.cloud().url)}/connect?to=${encodeURIComponent(computer.id)}&ticket=${encodeURIComponent(ticket)}`, kind: 'jvpn' };
  }

  // For a JConnect computer: a WebSocket URL for the encrypted channel.
  async function resolveJconnect(computer, { onProgress = () => {} } = {}) {
    const via = computer.via && computer.via !== 'auto' ? computer.via : null;

    let route = await direct(computer);
    if (route) return route;

    if (via && via !== 'jvpn') {
      const name = NAMES()[via.split(':')[0]] || 'your VPN';
      onProgress(`Starting ${name}…`);
      await vpn.ensure(via, { onProgress, computer });
      onProgress(`Looking for ${computer.name} through ${name}…`);
      for (let i = 0; i < 10 && !route; i++) {
        route = (await direct(computer)) || (await throughVpns(computer));
        if (!route) await new Promise((r) => setTimeout(r, 2000));
      }
      return route;
    }

    route = await throughVpns(computer);
    if (route) return route;

    onProgress(`Looking for ${computer.name} through JVPN…`);
    route = await throughJvpn(computer);
    if (route) return route;

    const fallback = store.settings.defaultVia;
    if (!via && fallback && fallback !== 'jvpn') {
      const name = NAMES()[fallback.split(':')[0]] || 'your VPN';
      onProgress(`Starting ${name}…`);
      await vpn.ensure(fallback, { onProgress, computer }).catch(() => {});
      route = (await direct(computer)) || (await throughVpns(computer));
    }
    return route;
  }

  // For other machines (SSH hosts, Remote Desktop, imported hosts): make sure their network is up and
  // the port answers.
  async function resolveHost({ host, port, via, name }, { onProgress = () => {} } = {}) {
    if (await tcpProbe(host, port, 2000)) return { host, port };
    if (via && via !== 'auto' && via !== 'direct' && !via.startsWith('computer:')) {
      const label = NAMES()[via.split(':')[0]] || 'your VPN';
      onProgress(`Starting ${label}…`);
      await vpn.ensure(via, { onProgress });
      onProgress(`Looking for ${name || host}…`);
      for (let i = 0; i < 10; i++) {
        if (await tcpProbe(host, port, 2000)) return { host, port };
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw JCSecure.failure('unreachable');
  }

  return { resolveJconnect, resolveHost };
}

module.exports = { createRouter, wsUrl };
