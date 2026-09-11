const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const nacl = require('tweetnacl');
const { app, safeStorage } = require('electron');
const JCSecure = require('../shared/secure-channel');
const { scryptSync } = require('./kdf');

const DEFAULT_SETTINGS = {
  deviceName: null,
  remoteAccess: true,
  requirePassword: false,
  passwordHash: null,
  startAtLogin: true,
  travelMode: false,
  travelOwnerOnly: true,
  emergencyShutdown: false,
  quality: 'auto',
  // Security
  hideFromNearby: false,
  allowBrowserClients: true,
  accountTrust: false,
  // JVPN and networks
  jvpnEnabled: true,
  defaultVia: 'jvpn',
  stunServers: ['stun:stun.l.google.com:19302'],
  // Services other devices may reach through JVPN
  shareSsh: false,
  sshPort: 22,
  shareRdp: false,
};

const EMPTY = () => ({
  settings: { ...DEFAULT_SETTINGS },
  trusted: [],
  computers: [],
  securityLog: [],
  lockdown: null,
  account: null,
  vpn: {},
  ssh: { hosts: [], keys: [], knownHosts: {} },
  tombstones: { computers: {}, sshHosts: {} },
});

function osLabel() {
  switch (process.platform) {
    case 'win32': {
      const build = Number(os.release().split('.')[2] || 0);
      return build >= 22000 ? 'Windows 11' : 'Windows 10';
    }
    case 'darwin': return 'macOS';
    case 'linux': return linuxLabel();
    case 'freebsd':
    case 'openbsd':
    case 'netbsd': return 'BSD';
    default: return process.platform;
  }
}

// The distribution and its version from /etc/os-release, such as "Ubuntu 24.04" or "Fedora Linux 42".
function linuxLabel() {
  try {
    const release = {};
    for (const line of fs.readFileSync('/etc/os-release', 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) release[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
    return [release.NAME, release.VERSION_ID].filter(Boolean).join(' ').slice(0, 40) || 'Linux';
  } catch {
    return 'Linux';
  }
}

// Device ids are derived from the public key so an id can never be claimed by a different key.
function deviceIdFromKey(publicKeyB64) {
  return crypto.createHash('sha512').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 20);
}

function verify(text, sigB64, publicKeyB64) {
  try {
    return nacl.sign.detached.verify(
      Buffer.from(String(text), 'utf8'),
      Buffer.from(String(sigB64), 'base64'),
      Buffer.from(String(publicKeyB64), 'base64'),
    );
  } catch {
    return false;
  }
}

class Store extends EventEmitter {
  constructor() {
    super();
    this.file = path.join(app.getPath('userData'), 'jconnect.json');
    this.data = this._load();
    this._ensureIdentity();
  }

  _load() {
    const empty = EMPTY();
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return empty;
    }
    const data = {
      ...empty,
      ...raw,
      settings: { ...DEFAULT_SETTINGS, ...raw.settings },
      ssh: { ...empty.ssh, ...raw.ssh },
      tombstones: { ...empty.tombstones, ...raw.tombstones },
    };
    // Passwords from before protocol v2 can't produce proofs; they have to be set again.
    if (data.settings.passwordHash && !String(data.settings.passwordHash).startsWith('v2:')) {
      data.settings.passwordHash = null;
      data.settings.requirePassword = false;
    }
    return data;
  }

  _ensureIdentity() {
    const saved = this.data.identity;
    if (saved) {
      try {
        const secretB64 = saved.sealed
          ? safeStorage.decryptString(Buffer.from(saved.secretKey, 'base64'))
          : saved.secretKey;
        this.keyPair = nacl.sign.keyPair.fromSecretKey(new Uint8Array(Buffer.from(secretB64, 'base64')));
      } catch (err) {
        console.error('[jconnect] could not unlock device identity, creating a new one:', err.message);
      }
    }
    if (!this.keyPair) {
      this.keyPair = nacl.sign.keyPair();
      const secretB64 = Buffer.from(this.keyPair.secretKey).toString('base64');
      const sealed = safeStorage.isEncryptionAvailable();
      this.data.identity = {
        sealed,
        secretKey: sealed ? safeStorage.encryptString(secretB64).toString('base64') : secretB64,
      };
      this.saveNow();
    }
    this.publicKey = Buffer.from(this.keyPair.publicKey).toString('base64');
    this.id = deviceIdFromKey(this.publicKey);
  }

  get settings() { return this.data.settings; }

  device() {
    return { id: this.id, name: this.settings.deviceName || os.hostname(), os: osLabel(), publicKey: this.publicKey };
  }

  sign(text) {
    return Buffer.from(nacl.sign.detached(Buffer.from(String(text), 'utf8'), this.keyPair.secretKey)).toString('base64');
  }

  // Secrets (API keys, tokens, SSH keys, saved passwords) are encrypted with the OS keychain.
  seal(text) {
    if (text == null) return null;
    if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(String(text)).toString('base64')}`;
    return `raw:${Buffer.from(String(text)).toString('base64')}`;
  }

  unseal(value) {
    if (!value || typeof value !== 'string') return null;
    try {
      if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
      if (value.startsWith('raw:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
    } catch {
      return null;
    }
    return null;
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 150);
    this.emit('change');
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  update(mutator) {
    mutator(this.data);
    this.save();
  }

  setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS) || key === 'passwordHash') throw new Error(`Unknown setting ${key}`);
    this.update((d) => { d.settings[key] = value; });
  }

  // ---- password (stored as a scrypt verifier; the password itself never leaves the other device) ----

  setPassword(password) {
    this.update((d) => {
      if (!password) {
        d.settings.passwordHash = null;
        d.settings.requirePassword = false;
        return;
      }
      const salt = crypto.randomBytes(16);
      const verifier = scryptSync(JCSecure.normalizeSecret(password), salt);
      d.settings.passwordHash = `v2:${salt.toString('base64')}:${Buffer.from(verifier).toString('base64')}`;
      d.settings.requirePassword = true;
    });
  }

  passwordSalt() {
    const parts = String(this.settings.passwordHash || '').split(':');
    return parts[0] === 'v2' ? parts[1] : null;
  }

  checkPasswordProof(proofB64, th) {
    const parts = String(this.settings.passwordHash || '').split(':');
    if (parts[0] !== 'v2' || typeof proofB64 !== 'string') return false;
    const expected = Buffer.from(JCSecure.passwordProof(new Uint8Array(Buffer.from(parts[2], 'base64')), th));
    const given = Buffer.from(proofB64, 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  // ---- devices allowed to use this computer ----

  findTrusted(publicKey) { return this.data.trusted.find((t) => t.publicKey === publicKey) || null; }

  addTrusted(device) {
    this.update((d) => {
      d.trusted = d.trusted.filter((t) => t.publicKey !== device.publicKey);
      d.trusted.push({ permission: 'control', owner: false, pairedAt: Date.now(), lastSeen: Date.now(), ...device });
    });
  }

  updateTrusted(id, patch) {
    this.update((d) => {
      const t = d.trusted.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    });
  }

  removeTrusted(id) {
    this.update((d) => { d.trusted = d.trusted.filter((t) => t.id !== id); });
  }

  // ---- computers this device can use ----

  getComputer(id) { return this.data.computers.find((c) => c.id === id) || null; }

  upsertComputer(computer) {
    this.update((d) => {
      const existing = d.computers.find((c) => c.id === computer.id);
      if (existing) {
        const addresses = mergeAddresses(existing.addresses, computer.addresses);
        Object.assign(existing, computer, {
          addresses,
          name: existing.renamed ? existing.name : computer.name || existing.name,
          updatedAt: Date.now(),
        });
      } else {
        d.computers.push({ type: 'jconnect', via: 'auto', addresses: [], mac: [], person: null, addedAt: Date.now(), updatedAt: Date.now(), ...computer });
      }
      delete d.tombstones.computers[computer.id];
    });
    return this.getComputer(computer.id);
  }

  updateComputer(id, patch, { quiet = false } = {}) {
    this.update((d) => {
      const c = d.computers.find((x) => x.id === id);
      if (!c) return;
      const next = { ...patch };
      if (next.addresses) next.addresses = mergeAddresses(c.addresses, next.addresses);
      Object.assign(c, next);
      if (!quiet) c.updatedAt = Date.now();
    });
  }

  removeComputer(id) {
    this.update((d) => {
      d.computers = d.computers.filter((c) => c.id !== id);
      d.tombstones.computers[id] = Date.now();
    });
  }

  log(event) {
    this.update((d) => {
      d.securityLog.unshift({ at: Date.now(), ...event });
      d.securityLog.length = Math.min(d.securityLog.length, 500);
    });
  }
}

function mergeAddresses(a = [], b = []) {
  const map = new Map();
  for (const addr of [...a, ...b]) {
    if (!addr || !addr.host || !addr.port) continue;
    const key = `${addr.host}|${addr.port}`;
    map.set(key, { ...map.get(key), ...addr });
  }
  return [...map.values()].sort((x, y) => (y.lastOk || 0) - (x.lastOk || 0)).slice(0, 12);
}

module.exports = { Store, osLabel, deviceIdFromKey, verify, DEFAULT_SETTINGS };
