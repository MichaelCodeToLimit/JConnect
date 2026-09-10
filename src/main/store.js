const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const nacl = require('tweetnacl');
const { app, safeStorage } = require('electron');

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
};

function osLabel() {
  switch (process.platform) {
    case 'win32': {
      const build = Number(os.release().split('.')[2] || 0);
      return build >= 22000 ? 'Windows 11' : 'Windows 10';
    }
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    case 'freebsd':
    case 'openbsd':
    case 'netbsd': return 'BSD';
    default: return process.platform;
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
    const empty = { settings: { ...DEFAULT_SETTINGS }, trusted: [], computers: [], securityLog: [], lockdown: null };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...empty, ...raw, settings: { ...DEFAULT_SETTINGS, ...raw.settings } };
    } catch {
      return empty;
    }
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

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 150);
    this.emit('change');
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
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

  setPassword(password) {
    this.update((d) => {
      if (!password) {
        d.settings.passwordHash = null;
        d.settings.requirePassword = false;
        return;
      }
      const salt = crypto.randomBytes(16);
      const hash = crypto.scryptSync(String(password), salt, 32);
      d.settings.passwordHash = `${salt.toString('base64')}:${hash.toString('base64')}`;
      d.settings.requirePassword = true;
    });
  }

  checkPassword(password) {
    const stored = this.settings.passwordHash;
    if (!stored || typeof password !== 'string') return false;
    const [salt, hash] = stored.split(':').map((s) => Buffer.from(s, 'base64'));
    const candidate = crypto.scryptSync(password, salt, 32);
    return crypto.timingSafeEqual(candidate, hash);
  }

  // Devices allowed to use this computer.
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

  // Computers this device can use.
  getComputer(id) { return this.data.computers.find((c) => c.id === id) || null; }

  upsertComputer(computer) {
    this.update((d) => {
      const existing = d.computers.find((c) => c.id === computer.id);
      if (existing) {
        const addresses = mergeAddresses(existing.addresses, computer.addresses);
        Object.assign(existing, computer, { addresses, name: existing.renamed ? existing.name : computer.name || existing.name });
      } else {
        d.computers.push({ type: 'jconnect', addresses: [], mac: [], person: null, addedAt: Date.now(), ...computer });
      }
    });
    return this.getComputer(computer.id);
  }

  updateComputer(id, patch) {
    this.update((d) => {
      const c = d.computers.find((x) => x.id === id);
      if (!c) return;
      if (patch.addresses) patch = { ...patch, addresses: mergeAddresses(c.addresses, patch.addresses) };
      Object.assign(c, patch);
    });
  }

  removeComputer(id) {
    this.update((d) => { d.computers = d.computers.filter((c) => c.id !== id); });
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

module.exports = { Store, osLabel, deviceIdFromKey, verify };
