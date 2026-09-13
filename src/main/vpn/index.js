// Networks JConnect can use to reach computers: its own JVPN plus VPNs already on this device.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { scanServices, fail } = require('./util');

const STATUS_TTL_MS = 15000;

class VpnManager extends EventEmitter {
  constructor({ store, shell, account, relayLink }) {
    super();
    this.store = store;
    this.account = account;
    this.relayLink = relayLink;
    const ctx = { store, shell };
    this.providers = new Map([
      ['jvpn', this._jvpnProvider()],
      ...['tailscale', 'twingate', 'zerotier', 'wireguard', 'forticlient', 'windows'].map((id) => [id, require(`./${id}`).create(ctx)]),
    ]);
    this.cache = new Map();
  }

  _jvpnProvider() {
    const { store, account, relayLink } = this;
    return {
      id: 'jvpn',
      name: 'JVPN',
      kind: 'builtin',
      builtin: true,
      async detect() {
        const s = store.settings;
        const link = relayLink.status();
        return {
          installed: true,
          running: !!s.jvpnEnabled,
          connected: !!s.jvpnEnabled && account.signedIn() && link.state === 'online',
          account: account.signedIn() ? account.data.email : null,
          needsSignIn: !account.signedIn(),
          detail: !s.jvpnEnabled ? 'Off' : !account.signedIn() ? 'Works on your network. Sign in to reach your computers from anywhere.' : link.state === 'online' ? 'Connected' : (link.error || 'Connecting…'),
        };
      },
      async connect() {
        if (!store.settings.jvpnEnabled) store.setSetting('jvpnEnabled', true);
        if (!account.signedIn()) throw fail('account-required');
        relayLink.refresh();
      },
      async disconnect() { store.setSetting('jvpnEnabled', false); relayLink.refresh(); },
      async machines() {
        return account.devices().map((d) => ({ key: `jvpn:${d.id}`, name: d.name, os: d.os, jconnect: { id: d.id, publicKey: d.publicKey, name: d.name, os: d.os } }));
      },
      async addressesFor() { return []; },
    };
  }

  get(id) { return this.providers.get(String(id || '').split(':')[0]) || null; }

  async status(force = false) {
    const out = [];
    await Promise.all([...this.providers.values()].map(async (p) => {
      const cached = this.cache.get(p.id);
      let status = cached && !force && Date.now() - cached.at < STATUS_TTL_MS ? cached.status : null;
      if (!status) {
        try { status = await p.detect(); } catch (err) { status = { installed: false, detail: err.message }; }
        this.cache.set(p.id, { at: Date.now(), status });
      }
      out.push({ id: p.id, name: p.name, kind: p.kind, website: p.website, builtin: !!p.builtin, ...status });
    }));
    const order = [...this.providers.keys()];
    return out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }

  invalidate(id) {
    if (id) this.cache.delete(id);
    else this.cache.clear();
    this.emit('change');
  }

  // Makes sure the VPN picked for a computer is running and connected (starting its service if needed).
  async ensure(via, { onProgress, computer } = {}) {
    const [id, ...rest] = String(via).split(':');
    const provider = this.get(id);
    if (!provider) throw fail('unknown-network');
    try {
      await provider.connect({ onProgress, computer, arg: rest.join(':') || undefined });
    } finally {
      this.invalidate(id);
    }
  }

  async act(id, action, options = {}) {
    const provider = this.get(id);
    if (!provider || typeof provider[action] !== 'function') throw fail('unknown-network');
    try {
      return await provider[action](options);
    } finally {
      this.invalidate(id);
    }
  }

  // Everything this network already knows about, with what JConnect can do on each machine.
  async importable(id) {
    const provider = this.get(id);
    if (!provider) throw fail('unknown-network');
    const machines = await provider.machines();
    const known = new Set(this.store.data.computers.map((c) => c.id));
    const results = await Promise.all(machines.map(async (m) => {
      if (m.jconnect) return { ...m, services: { jconnect: true, ssh: false, rdp: false }, id: m.jconnect.id, exists: known.has(m.jconnect.id) };
      const scan = m.online === false ? { jconnect: null, ssh: false, rdp: false } : await scanServices(m.host);
      const hostId = scan.jconnect ? scan.jconnect.id : `host-${crypto.createHash('sha1').update(`${id}|${m.host}`).digest('hex').slice(0, 16)}`;
      return {
        ...m,
        id: hostId,
        jconnect: scan.jconnect ? { id: scan.jconnect.id, publicKey: scan.jconnect.publicKey, name: scan.jconnect.name, os: scan.jconnect.os, port: scan.jconnect.port } : null,
        services: { jconnect: !!scan.jconnect, ssh: scan.ssh, rdp: scan.rdp },
        exists: known.has(hostId),
      };
    }));
    return results.sort((a, b) => Number(b.online !== false) - Number(a.online !== false) || a.name.localeCompare(b.name));
  }

  // Adds chosen machines to My Computers, remembering which network reaches them.
  import(id, items) {
    // Names and addresses come from the network's own service, so they're cleaned before they're kept. An
    // address also ends up in Remote Desktop files, where a line break would add settings.
    const clean = (value, max) => String(value || '').replace(/\p{Cc}/gu, '').trim().slice(0, max);
    const hostOf = (value) => (/^[\w.:[\]-]{1,255}$/.test(String(value || '')) ? String(value) : null);
    const added = [];
    for (const item of items) {
      const host = hostOf(item.host);
      if (item.jconnect) {
        if (!/^[0-9a-f]{20}$/.test(String(item.jconnect.id))) continue;
        const existing = this.store.getComputer(item.jconnect.id);
        const port = Number.isInteger(item.jconnect.port) && item.jconnect.port > 0 && item.jconnect.port < 65536 ? item.jconnect.port : 47801;
        const computer = this.store.upsertComputer({
          id: item.jconnect.id,
          type: 'jconnect',
          name: existing ? existing.name : clean(item.jconnect.name || item.name, 64) || 'Computer',
          os: clean(item.jconnect.os || item.os, 32),
          publicKey: item.jconnect.publicKey,
          addresses: host ? [{ host, port }] : [],
          via: existing && existing.via && existing.via !== 'auto' ? existing.via : id,
          source: id,
          paired: existing ? existing.paired !== false : false,
        });
        added.push(computer.id);
      } else if (host) {
        const computer = this.store.upsertComputer({
          id: item.id,
          type: 'host',
          name: clean(item.name, 64) || host,
          os: clean(item.os, 32),
          host,
          services: { ssh: !!(item.services && item.services.ssh), rdp: !!(item.services && item.services.rdp) },
          via: id,
          source: id,
        });
        added.push(computer.id);
      }
    }
    return added;
  }

  // Extra addresses connected VPNs know for a computer (for example its Tailscale IP).
  async addressesFor(computer) {
    const statuses = await this.status();
    const lists = await Promise.all(statuses.filter((s) => s.connected).map((s) => this.get(s.id).addressesFor(computer).catch(() => [])));
    return lists.flat();
  }
}

module.exports = { VpnManager };
