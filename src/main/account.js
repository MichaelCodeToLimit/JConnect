// JConnect account: optional sign-in for sync.
//
// The password stays on this device. scrypt turns it into two keys: an auth key the server checks,
// and a vault key the server never sees. Computers, SSH hosts and the account's device list are synced
// inside a vault encrypted with the vault key, so JConnect Cloud only ever stores ciphertext.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const { EventEmitter } = require('events');
const JCSecure = require('../shared/secure-channel');
const { scrypt } = require('./kdf');

const MIN_KDF = { N: 32768, r: 8, p: 1 };
const SYNC_DEBOUNCE_MS = 3000;
const SYNC_INTERVAL_MS = 60000;
const COMPUTER_FIELDS = ['id', 'type', 'name', 'os', 'publicKey', 'addresses', 'mac', 'person', 'via', 'rdp', 'host', 'port', 'services', 'source', 'renamed', 'paired', 'addedAt', 'updatedAt'];
const SSH_FIELDS = ['id', 'name', 'host', 'port', 'username', 'auth', 'keyId', 'via', 'computerId', 'source', 'addedAt', 'updatedAt'];

const fail = (code, extra) => JCSecure.failure(code, extra);
const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => obj[f] !== undefined).map((f) => [f, obj[f]]));
const sha512 = (...parts) => crypto.createHash('sha512').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const emptyVault = () => ({ v: 1, devices: {}, computers: {}, sshHosts: {}, tombstones: {} });

// JConnect Cloud answers calls that need the password again with 403, because 401 means the session ended.
function reauthError(res) {
  if (res.status === 403) return fail(['totp', 'totp-required'].includes(res.data.error) ? res.data.error : 'wrong-password');
  if (res.status === 429) return fail('slow-down');
  return fail(res.data.error || 'server');
}

function normalizeServer(value) {
  let text = String(value || '').trim();
  if (!text) throw fail('server');
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)/.test(url.hostname);
  if (url.protocol === 'http:' && !local) throw fail('insecure-server');
  return url.origin;
}

function request(base, method, pathname, { token, body, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, `${base}/`);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = lib.request(url, {
      method,
      timeout,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(fail('unreachable')));
    req.on('error', () => reject(fail('unreachable')));
    if (payload) req.write(payload);
    req.end();
  });
}

function mergeSection(a = {}, b = {}, tombstones = {}) {
  const out = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id];
    const y = b[id];
    const winner = !x ? y : !y ? x : ((y.updatedAt || 0) > (x.updatedAt || 0) ? y : x);
    if (!winner) continue;
    if ((tombstones[id] || 0) >= (winner.updatedAt || 0)) continue;
    out[id] = winner;
  }
  return out;
}

function mergeTombstones(a = {}, b = {}) {
  const out = { ...a };
  for (const [id, ts] of Object.entries(b)) out[id] = Math.max(out[id] || 0, ts);
  return out;
}

function mergeVaults(remote, local) {
  const tomb = {
    computers: mergeTombstones(remote.tombstones && remote.tombstones.computers, local.tombstones.computers),
    sshHosts: mergeTombstones(remote.tombstones && remote.tombstones.sshHosts, local.tombstones.sshHosts),
    devices: mergeTombstones(remote.tombstones && remote.tombstones.devices, local.tombstones.devices),
  };
  return {
    v: 1,
    devices: mergeSection(remote.devices, local.devices, tomb.devices),
    computers: mergeSection(remote.computers, local.computers, tomb.computers),
    sshHosts: mergeSection(remote.sshHosts, local.sshHosts, tomb.sshHosts),
    tombstones: tomb,
  };
}

class Account extends EventEmitter {
  constructor({ store }) {
    super();
    this.store = store;
    this.vault = null;
    this.state = this.signedIn() ? 'signed-in' : 'signed-out';
    this.error = null;
    this._syncing = null;
    this._applying = false;
    this._pendingKeys = null;
  }

  get data() { return this.store.data.account; }
  signedIn() { return !!(this.data && this.data.token); }

  start() {
    this.store.on('change', () => {
      if (!this._applying && this.signedIn()) this.scheduleSync();
    });
    this._interval = setInterval(() => { if (this.signedIn()) this.sync().catch(() => {}); }, SYNC_INTERVAL_MS);
    if (this.signedIn()) this.sync().catch(() => {});
  }

  stop() { clearInterval(this._interval); clearTimeout(this._debounce); }

  cloud() {
    if (!this.signedIn()) return null;
    const token = this.store.unseal(this.data.token);
    return token ? { url: this.data.server, token } : null;
  }

  snapshot() {
    return {
      signedIn: this.signedIn(),
      email: this.data ? this.data.email : null,
      server: this.data ? this.data.server : null,
      state: this.state,
      error: this.error,
      lastSync: this.data ? this.data.lastSync : null,
      totp: this.data ? !!this.data.totp : false,
      devices: this.devices().map((d) => ({ id: d.id, name: d.name, os: d.os, updatedAt: d.updatedAt })),
    };
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('change', this.snapshot());
  }

  async _keys(password, saltB64, kdf) {
    const params = { N: Math.max(MIN_KDF.N, Number(kdf && kdf.N) || 0), r: Math.max(MIN_KDF.r, Number(kdf && kdf.r) || 0), p: Math.max(MIN_KDF.p, Number(kdf && kdf.p) || 0) };
    if (params.N > 1048576 || params.r > 32 || params.p > 16) throw fail('server');
    const master = await scrypt(JCSecure.normalizeSecret(password), Buffer.from(saltB64, 'base64'), { ...params, dkLen: 64 });
    return {
      authKey: sha512('jconnect-cloud-auth', master).subarray(0, 32),
      vaultKey: sha512('jconnect-cloud-vault', master).subarray(0, 32),
    };
  }

  async signUp({ server, email, password }) {
    const base = normalizeServer(server);
    if (String(password || '').length < 10) throw fail('weak-password');
    const salt = crypto.randomBytes(16).toString('base64');
    const keys = await this._keys(password, salt, MIN_KDF);
    const res = await request(base, 'POST', '/v1/signup', { body: { email, salt, authKey: keys.authKey.toString('base64') } });
    if (res.status === 409) throw fail('exists');
    if (res.status === 429) throw fail('slow-down');
    if (res.status !== 200) throw fail(res.data.error || 'server');
    await this._begin(base, email, res.data, keys.vaultKey);
  }

  async signIn({ server, email, password, totp }) {
    const base = normalizeServer(server);
    const cacheKey = `${base}|${email}|${password}`;
    let keys = this._pendingKeys && this._pendingKeys.key === cacheKey ? this._pendingKeys.keys : null;
    if (!keys) {
      const pre = await request(base, 'POST', '/v1/prelogin', { body: { email } });
      if (pre.status !== 200) throw fail(pre.data.error || 'server');
      keys = await this._keys(password, pre.data.salt, pre.data.kdf);
    }
    const res = await request(base, 'POST', '/v1/login', { body: { email, authKey: keys.authKey.toString('base64'), totp: totp || undefined } });
    if (res.status === 401 && res.data.error === 'totp-required') {
      this._pendingKeys = { key: cacheKey, keys };
      setTimeout(() => { this._pendingKeys = null; }, 5 * 60 * 1000);
      throw fail('totp-required');
    }
    this._pendingKeys = null;
    if (res.status === 401) throw fail(res.data.error === 'totp' ? 'totp' : 'credentials');
    if (res.status === 429) throw fail('slow-down');
    if (res.status !== 200) throw fail(res.data.error || 'server');
    await this._begin(base, email, res.data, keys.vaultKey);
  }

  async _begin(server, email, session, vaultKey) {
    this.store.update((d) => {
      d.account = {
        server,
        email: String(email).toLowerCase(),
        userId: session.userId,
        token: this.store.seal(session.token),
        vaultKey: this.store.seal(Buffer.from(vaultKey).toString('base64')),
        expiresAt: session.expiresAt,
        lastSync: null,
      };
    });
    this.store.log({ kind: 'account', level: 'info', message: `Signed in to JConnect as ${String(email).toLowerCase()}.` });
    this._set('signed-in');
    await this.registerDevice();
    await this.sync();
  }

  async signOut() {
    const cloud = this.cloud();
    if (cloud) await request(cloud.url, 'POST', '/v1/logout', { token: cloud.token }).catch(() => {});
    const email = this.data && this.data.email;
    this.store.update((d) => { d.account = null; });
    this.vault = null;
    if (email) this.store.log({ kind: 'account', level: 'info', message: `Signed out of ${email}.` });
    this._set('signed-out');
  }

  // Checks the password on this device before it's used: it must give the vault key this device already holds.
  async _reauth(password) {
    const pre = await request(this.data.server, 'POST', '/v1/prelogin', { body: { email: this.data.email } });
    if (pre.status !== 200) throw fail(pre.data.error || 'server');
    const keys = await this._keys(password, pre.data.salt, pre.data.kdf);
    if (!crypto.timingSafeEqual(Buffer.from(keys.vaultKey), Buffer.from(this._vaultKey()))) throw fail('wrong-password');
    return keys;
  }

  // A new password gives new keys, so the synced data is encrypted again with the new vault key and sent with
  // the new salt and auth key. JConnect Cloud signs out every session; this device carries on with a new one.
  async changePassword({ current, next, totp }) {
    if (!this.signedIn()) throw fail('signed-out');
    if (String(next || '').length < 10) throw fail('weak-password');
    const old = await this._reauth(current);
    const salt = crypto.randomBytes(16).toString('base64');
    const keys = await this._keys(next, salt, MIN_KDF);
    for (let attempt = 0; attempt < 3; attempt++) {
      const got = await this._call('GET', '/v1/vault');
      if (got.status !== 200) throw fail('server');
      const merged = mergeVaults(got.data.blob ? this._decrypt(got.data.blob) : emptyVault(), this._local());
      const res = await this._call('POST', '/v1/password', {
        authKey: old.authKey.toString('base64'),
        totp: totp || undefined,
        salt,
        newAuthKey: keys.authKey.toString('base64'),
        baseVersion: got.data.version,
        blob: this._encrypt(merged, new Uint8Array(keys.vaultKey)),
      });
      // Another device synced in between, so start again from its version.
      if (res.status === 409) continue;
      if (res.status !== 200) throw reauthError(res);
      this.store.update((d) => {
        d.account.token = this.store.seal(res.data.token);
        d.account.vaultKey = this.store.seal(Buffer.from(keys.vaultKey).toString('base64'));
        d.account.expiresAt = res.data.expiresAt;
        d.account.lastSync = Date.now();
      });
      this.vault = merged;
      this._apply(merged);
      this.store.log({ kind: 'account', level: 'info', message: 'Changed the JConnect account password. Other devices need to sign in again.' });
      this._set('signed-in');
      return;
    }
    throw fail('server');
  }

  // Deletes the account and everything JConnect Cloud keeps for it. Computers and SSH hosts stay on this device.
  async deleteAccount({ password, totp }) {
    if (!this.signedIn()) throw fail('signed-out');
    const keys = await this._reauth(password);
    const res = await this._call('DELETE', '/v1/account', { authKey: keys.authKey.toString('base64'), totp: totp || undefined });
    if (res.status !== 200) throw reauthError(res);
    const { email } = this.data;
    this.store.update((d) => { d.account = null; });
    this.vault = null;
    this.store.log({ kind: 'account', level: 'info', message: `Deleted the JConnect account ${email}.` });
    this._set('signed-out');
  }

  async _call(method, pathname, body) {
    const cloud = this.cloud();
    if (!cloud) throw fail('signed-out');
    const res = await request(cloud.url, method, pathname, { token: cloud.token, body });
    if (res.status === 401) {
      this._set('expired', 'Sign in again to keep syncing.');
      throw fail('expired');
    }
    return res;
  }

  async registerDevice() {
    const d = this.store.device();
    const ts = Date.now();
    const sig = this.store.sign(`jconnect-cloud-device:${d.id}:${this.data.userId}:${ts}`);
    const res = await this._call('POST', '/v1/devices', { id: d.id, publicKey: d.publicKey, name: d.name, os: d.os, ts, sig });
    if (res.status !== 200) throw fail(res.data.error || 'server');
  }

  _vaultKey() {
    const key = this.store.unseal(this.data && this.data.vaultKey);
    if (!key) throw fail('vault-key');
    return new Uint8Array(Buffer.from(key, 'base64'));
  }

  _encrypt(obj, key = this._vaultKey()) {
    const nonce = nacl.randomBytes(24);
    const box = nacl.secretbox(new Uint8Array(Buffer.from(JSON.stringify(obj), 'utf8')), nonce, key);
    return Buffer.concat([Buffer.from(nonce), Buffer.from(box)]).toString('base64');
  }

  _decrypt(blob) {
    const bytes = new Uint8Array(Buffer.from(blob, 'base64'));
    const plain = nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), this._vaultKey());
    if (!plain) throw fail('vault-key');
    return JSON.parse(Buffer.from(plain).toString('utf8'));
  }

  _local() {
    const { data } = this.store;
    const self = this.store.device();
    const previous = this.vault && this.vault.devices && this.vault.devices[self.id];
    const selfEntry = { id: self.id, name: self.name, os: self.os, publicKey: self.publicKey };
    const changed = !previous || previous.name !== self.name || previous.os !== self.os;
    return {
      devices: { [self.id]: { ...selfEntry, updatedAt: changed ? Date.now() : previous.updatedAt } },
      computers: Object.fromEntries(data.computers.map((c) => [c.id, pick({ updatedAt: c.addedAt || 0, ...c }, COMPUTER_FIELDS)])),
      sshHosts: Object.fromEntries(((data.ssh && data.ssh.hosts) || []).map((h) => [h.id, pick({ updatedAt: h.addedAt || 0, ...h }, SSH_FIELDS)])),
      tombstones: {
        computers: (data.tombstones && data.tombstones.computers) || {},
        sshHosts: (data.tombstones && data.tombstones.sshHosts) || {},
        devices: {},
      },
    };
  }

  _apply(merged) {
    this._applying = true;
    try {
      this.store.update((d) => {
        d.tombstones = { ...d.tombstones, computers: merged.tombstones.computers, sshHosts: merged.tombstones.sshHosts };
        const syncList = (list, section, tombs, fields) => {
          const byId = new Map(list.map((item) => [item.id, item]));
          for (const [id, entry] of Object.entries(section)) {
            // Only the fields JConnect syncs are taken from the vault, and an entry must carry its own id.
            const remote = pick(entry && typeof entry === 'object' ? entry : {}, fields);
            if (remote.id !== id) continue;
            const local = byId.get(id);
            if (!local) list.push(remote);
            else if ((remote.updatedAt || 0) > (local.updatedAt || 0)) Object.assign(local, remote);
          }
          return list.filter((item) => section[item.id] || !((tombs[item.id] || 0) >= (item.updatedAt || item.addedAt || 0)));
        };
        d.computers = syncList(d.computers, merged.computers, merged.tombstones.computers, COMPUTER_FIELDS);
        d.ssh = d.ssh || { hosts: [], keys: [], knownHosts: {} };
        d.ssh.hosts = syncList(d.ssh.hosts, merged.sshHosts, merged.tombstones.sshHosts, SSH_FIELDS);
      });
    } finally {
      const timer = setTimeout(() => { this._applying = false; }, SYNC_DEBOUNCE_MS + 200);
      if (timer.unref) timer.unref();
    }
  }

  scheduleSync() {
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this.sync().catch(() => {}), SYNC_DEBOUNCE_MS);
  }

  sync() {
    if (!this.signedIn()) return Promise.resolve();
    if (this._syncing) return this._syncing;
    this._syncing = (async () => {
      this._set('syncing');
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const got = await this._call('GET', '/v1/vault');
          if (got.status !== 200) throw fail('server');
          const remote = got.data.blob ? this._decrypt(got.data.blob) : emptyVault();
          const merged = mergeVaults(remote, this._local());
          this.vault = merged;
          this._apply(merged);
          if (JSON.stringify(merged) === JSON.stringify(remote) && got.data.blob) break;
          const put = await this._call('PUT', '/v1/vault', { baseVersion: got.data.version, blob: this._encrypt(merged) });
          if (put.status === 409) continue;
          if (put.status !== 200) throw fail('server');
          break;
        }
        this.store.update((d) => { if (d.account) d.account.lastSync = Date.now(); });
        this._set('signed-in');
      } catch (err) {
        if (err.code === 'vault-key') this._set('error', 'This device can’t open your synced data. Sign out and sign in again.');
        else if (err.code !== 'expired') this._set('error', err.code === 'unreachable' ? 'JConnect Cloud isn’t reachable right now.' : 'Sync didn’t finish. JConnect will try again.');
        throw err;
      } finally {
        this._syncing = null;
      }
    })();
    return this._syncing;
  }

  // Other devices signed in to this account (public keys come from the encrypted vault).
  devices() {
    if (!this.vault || !this.vault.devices) return [];
    const selfId = this.store.id;
    return Object.values(this.vault.devices).filter((d) => d.id !== selfId);
  }

  async removeDevice(id) {
    await this._call('DELETE', `/v1/devices/${encodeURIComponent(id)}`);
    if (this.vault) {
      this.vault.tombstones.devices[id] = Date.now();
      delete this.vault.devices[id];
    }
    await this.sync().catch(() => {});
  }

  async iceServers() {
    const res = await this._call('GET', '/v1/ice');
    return res.status === 200 && Array.isArray(res.data.iceServers) ? res.data.iceServers : [];
  }

  async relayTicket(to) {
    const res = await this._call('POST', '/v1/relay/ticket', { to });
    if (res.status !== 200) throw fail(res.status === 404 ? 'not-on-account' : 'server');
    return res.data.ticket;
  }

  async presence(ids) {
    const cloud = this.cloud();
    if (!cloud || !ids.length) return [];
    const res = await request(cloud.url, 'GET', `/presence?ids=${encodeURIComponent(ids.join(','))}`, { token: cloud.token, timeout: 5000 });
    return res.status === 200 && Array.isArray(res.data.online) ? res.data.online : [];
  }

  async totpSetup() {
    const res = await this._call('POST', '/v1/totp/setup');
    if (res.status !== 200) throw fail('server');
    return res.data;
  }

  async totpSet(enable, code) {
    const res = await this._call('POST', enable ? '/v1/totp/enable' : '/v1/totp/disable', { code });
    if (res.status !== 200) throw fail('totp');
    this.store.update((d) => { if (d.account) d.account.totp = !!res.data.totp; });
    this._set(this.state);
  }
}

module.exports = { Account, mergeVaults, normalizeServer };
