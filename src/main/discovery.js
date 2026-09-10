const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const DISCOVERY_PORT = 47802;
const DEFAULT_AGENT_PORT = 47801;
const PATH_RANK = { local: 0, lan: 1, private: 2, internet: 3 };

function isTailscaleIp(ip) {
  if (/^fd7a:115c:a1e0:/i.test(ip)) return true;
  const m = /^100\.(\d+)\./.exec(ip);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

function pathKind(host) {
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return 'local';
  if (isTailscaleIp(host) || /\.ts\.net$/i.test(host)) return 'private';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fc|fd)/i.test(host)) return 'lan';
  return 'internet';
}

function broadcastOf(address, netmask) {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((octet, i) => (octet | (~m[i] & 255))).join('.');
}

function localInterfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.internal || i.family !== 'IPv4') continue;
      out.push({
        name,
        address: i.address,
        mac: i.mac,
        tailscale: isTailscaleIp(i.address) || /tailscale/i.test(name),
        broadcast: broadcastOf(i.address, i.netmask),
      });
    }
  }
  return out;
}

function macAddresses() {
  const macs = new Set();
  for (const i of localInterfaces()) {
    if (!i.tailscale && i.mac && i.mac !== '00:00:00:00:00:00') macs.add(i.mac);
  }
  return [...macs];
}

function probe(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get({ host, port, path: '/api/info', timeout, headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) req.destroy();
      });
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve(info && info.app === 'jconnect' ? { info, ms: Date.now() - started } : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function tcpProbe(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function findTailscale() {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

class Discovery extends EventEmitter {
  constructor({ selfId, getAnnouncement, isTravelMode }) {
    super();
    this.selfId = selfId;
    this.getAnnouncement = getAnnouncement;
    this.isTravelMode = isTravelMode;
    this.peers = new Map();
    this.tailscale = { available: false, online: false };
  }

  start() {
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
    this.sock.on('error', (err) => console.warn('[jconnect] discovery:', err.message));
    this.sock.bind(DISCOVERY_PORT, () => {
      this.sock.setBroadcast(true);
      this.announce();
    });
    const loop = () => {
      this.announce();
      this._prune();
      this._announceTimer = setTimeout(loop, this.isTravelMode() ? 15000 : 4000);
    };
    this._announceTimer = setTimeout(loop, 4000);
    this.scanTailscale();
    this._tailscaleTimer = setInterval(() => { if (!this.isTravelMode()) this.scanTailscale(); }, 30000);
  }

  stop() {
    clearTimeout(this._announceTimer);
    clearInterval(this._tailscaleTimer);
    try { this.sock.close(); } catch { /* already closed */ }
  }

  announce(state = 'ready') {
    if (!this.sock) return;
    const payload = this.getAnnouncement();
    if (!payload) return;
    const msg = Buffer.from(JSON.stringify({ app: 'jconnect', v: 1, ...payload, state }));
    const targets = new Set(['255.255.255.255']);
    for (const i of localInterfaces()) if (!i.tailscale) targets.add(i.broadcast);
    for (const target of targets) {
      try { this.sock.send(msg, DISCOVERY_PORT, target, () => {}); } catch { /* socket closing */ }
    }
  }

  _onMessage(buf, rinfo) {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!msg || msg.app !== 'jconnect' || typeof msg.id !== 'string' || msg.id === this.selfId) return;
    if (typeof msg.publicKey !== 'string' || !Number.isInteger(msg.port)) return;
    this._upsertPeer(msg, rinfo.address, pathKind(rinfo.address), msg.state || 'ready');
  }

  _upsertPeer(info, address, kind, state) {
    const now = Date.now();
    const peer = this.peers.get(info.id) || { id: info.id, addresses: new Map() };
    Object.assign(peer, {
      name: String(info.name || 'Computer').slice(0, 64),
      os: String(info.os || '').slice(0, 32),
      publicKey: info.publicKey,
      port: info.port,
      mac: Array.isArray(info.mac) ? info.mac.slice(0, 8) : peer.mac || [],
      travelMode: !!info.travelMode,
      lockdown: !!info.lockdown,
      state,
      lastSeen: now,
    });
    peer.addresses.set(address, { kind, lastSeen: now });
    this.peers.set(info.id, peer);
    this.emit('update', peer);
  }

  _prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers) {
      for (const [addr, meta] of peer.addresses) {
        const ttl = meta.kind === 'private' ? 90000 : 15000;
        if (now - meta.lastSeen > ttl) { peer.addresses.delete(addr); changed = true; }
      }
      if (peer.addresses.size === 0 && peer.state !== 'sleeping') { this.peers.delete(id); changed = true; }
    }
    if (changed) this.emit('update');
  }

  async scanTailscale() {
    const bin = findTailscale();
    if (!bin) { this.tailscale = { available: false, online: false }; return; }
    execFile(bin, ['status', '--json'], { timeout: 5000, windowsHide: true }, async (err, stdout) => {
      if (err) { this.tailscale = { available: true, online: false }; return; }
      let status;
      try { status = JSON.parse(stdout); } catch { return; }
      this.tailscale = { available: true, online: status.BackendState === 'Running' };
      const peers = Object.values(status.Peer || {}).filter((p) => p.Online);
      await Promise.all(peers.map(async (p) => {
        const ip = (p.TailscaleIPs || []).find((x) => x.includes('.'));
        if (!ip) return;
        const hit = await probe(ip, DEFAULT_AGENT_PORT, 2500);
        if (hit && hit.info.id !== this.selfId) this._upsertPeer(hit.info, ip, 'private', 'ready');
      }));
    });
  }

  list() {
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      os: p.os,
      publicKey: p.publicKey,
      port: p.port,
      mac: p.mac,
      state: p.state,
      travelMode: p.travelMode,
      lockdown: p.lockdown,
      lastSeen: p.lastSeen,
      addresses: [...p.addresses.entries()].map(([host, meta]) => ({ host, port: p.port, kind: meta.kind })),
    }));
  }
}

// Try every known path to a computer at once and pick the best one that proves it is the right machine.
async function resolveComputer(computer, discovery) {
  const candidates = new Map();
  const add = (host, port) => { if (host && port) candidates.set(`${host}|${port}`, { host, port, kind: pathKind(host) }); };
  for (const a of computer.addresses || []) add(a.host, a.port);
  const live = discovery && discovery.peers.get(computer.id);
  if (live) for (const host of live.addresses.keys()) add(host, live.port);

  const results = await Promise.all([...candidates.values()].map(async (c) => {
    const hit = await probe(c.host, c.port);
    return hit && hit.info.publicKey === computer.publicKey ? { ...c, info: hit.info, ms: hit.ms } : null;
  }));
  const reachable = results.filter(Boolean).sort((a, b) => PATH_RANK[a.kind] - PATH_RANK[b.kind] || a.ms - b.ms);
  return reachable[0] || null;
}

function wakeOnLan(macs, hosts = []) {
  return new Promise((resolve) => {
    const valid = (macs || []).map((m) => m.replace(/[^0-9a-f]/gi, '')).filter((m) => m.length === 12);
    if (!valid.length) { resolve(false); return; }
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => {});
    sock.bind(() => {
      sock.setBroadcast(true);
      const targets = new Set(['255.255.255.255', ...hosts]);
      for (const i of localInterfaces()) if (!i.tailscale) targets.add(i.broadcast);
      for (const mac of valid) {
        const bytes = Buffer.from(mac, 'hex');
        const packet = Buffer.alloc(6 + 16 * 6, 0xff);
        for (let i = 0; i < 16; i++) bytes.copy(packet, 6 + i * 6);
        for (const t of targets) for (const port of [9, 7]) sock.send(packet, port, t, () => {});
      }
      setTimeout(() => { sock.close(); resolve(true); }, 400);
    });
  });
}

module.exports = {
  Discovery, resolveComputer, wakeOnLan, probe, tcpProbe, pathKind, macAddresses, localInterfaces,
  DEFAULT_AGENT_PORT, DISCOVERY_PORT,
};
