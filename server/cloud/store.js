// JConnect Cloud storage: accounts, devices, sessions and settings in SQLite, through Node's built-in
// node:sqlite (Node.js 22.13 or later). store-postgres.js keeps the same data in Postgres (Supabase), with
// the same methods. Times are milliseconds since 1970, like Date.now().
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// Each entry upgrades the database by one version (PRAGMA user_version). Only ever append.
const MIGRATIONS = [
  `
  create table settings (
    id integer primary key check (id = 1),
    prelogin_secret text not null,
    created_at integer not null
  );

  create table accounts (
    id text primary key,
    email text not null unique check (email = lower(email) and length(email) <= 254),
    kdf_salt text not null,
    auth_verifier text not null,
    totp_secret text,
    totp_enabled integer not null default 0 check (totp_enabled in (0, 1) and (totp_enabled = 0 or totp_secret is not null)),
    vault_version integer not null default 0 check (vault_version >= 0),
    vault_blob text check (vault_blob is null or length(vault_blob) <= 2097152),
    vault_updated_at integer not null,
    created_at integer not null,
    updated_at integer not null
  );

  create table devices (
    account_id text not null references accounts (id) on delete cascade,
    device_id text not null,
    public_key text not null,
    name text not null default '' check (length(name) <= 64),
    os text not null default '' check (length(os) <= 32),
    last_seen integer not null,
    created_at integer not null,
    primary key (account_id, device_id)
  );
  create index devices_device_id on devices (device_id);

  create table sessions (
    token_hash text primary key,
    account_id text not null references accounts (id) on delete cascade,
    created_at integer not null,
    expires_at integer not null check (expires_at > created_at)
  );
  create index sessions_account_id on sessions (account_id);
  create index sessions_expires_at on sessions (expires_at);
  `,
];

function transaction(db, fn) {
  db.exec('begin immediate');
  try {
    const result = fn();
    db.exec('commit');
    return result;
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
}

function migrate(db) {
  const { user_version: version } = db.prepare('pragma user_version').get();
  for (let v = version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`pragma user_version = ${v + 1}`);
    });
  }
}

const toUser = (row) => row && {
  id: row.id,
  email: row.email,
  salt: row.kdf_salt,
  auth: row.auth_verifier,
  totp: row.totp_secret ? { secret: row.totp_secret, enabled: row.totp_enabled === 1 } : null,
  vault: { version: row.vault_version, blob: row.vault_blob, updatedAt: row.vault_updated_at },
  createdAt: row.created_at,
};

const toDevice = (row) => row && { id: row.device_id, publicKey: row.public_key, name: row.name, os: row.os, lastSeen: row.last_seen };

// file: path to the database, or null for one that lives only in memory (used by tests).
function openStore(file) {
  const memory = !file || file === ':memory:';
  if (!memory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(memory ? ':memory:' : file);
  db.exec('pragma foreign_keys = on');
  if (!memory) {
    db.exec('pragma journal_mode = wal');
    db.exec('pragma busy_timeout = 5000');
    try { fs.chmodSync(file, 0o600); } catch { /* not supported on this system */ }
  }
  migrate(db);

  const q = {
    secret: db.prepare('select prelogin_secret from settings where id = 1'),
    setSecret: db.prepare('insert into settings (id, prelogin_secret, created_at) values (1, ?, ?) on conflict (id) do update set prelogin_secret = excluded.prelogin_secret'),
    accountCount: db.prepare('select count(*) as n from accounts'),
    userByEmail: db.prepare('select * from accounts where email = ?'),
    userById: db.prepare('select * from accounts where id = ?'),
    insertUser: db.prepare('insert into accounts (id, email, kdf_salt, auth_verifier, vault_updated_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)'),
    setVault: db.prepare('update accounts set vault_version = ?, vault_blob = ?, vault_updated_at = ? where id = ?'),
    putVault: db.prepare('update accounts set vault_version = vault_version + 1, vault_blob = ?, vault_updated_at = ?, updated_at = ? where id = ? and vault_version = ?'),
    changePassword: db.prepare('update accounts set kdf_salt = ?, auth_verifier = ?, vault_version = vault_version + 1, vault_blob = ?, vault_updated_at = ?, updated_at = ? where id = ? and vault_version = ?'),
    deleteUser: db.prepare('delete from accounts where id = ?'),
    setTotp: db.prepare('update accounts set totp_secret = ?, totp_enabled = ?, updated_at = ? where id = ?'),
    devices: db.prepare('select * from devices where account_id = ? order by created_at, device_id'),
    device: db.prepare('select * from devices where account_id = ? and device_id = ?'),
    deviceCount: db.prepare('select count(*) as n from devices where account_id = ?'),
    saveDevice: db.prepare(`insert into devices (account_id, device_id, public_key, name, os, last_seen, created_at) values (?, ?, ?, ?, ?, ?, ?)
      on conflict (account_id, device_id) do update set public_key = excluded.public_key, name = excluded.name, os = excluded.os, last_seen = excluded.last_seen`),
    removeDevice: db.prepare('delete from devices where account_id = ? and device_id = ?'),
    insertSession: db.prepare('insert into sessions (token_hash, account_id, created_at, expires_at) values (?, ?, ?, ?)'),
    session: db.prepare('select * from sessions where token_hash = ?'),
    deleteSession: db.prepare('delete from sessions where token_hash = ?'),
    deleteSessions: db.prepare('delete from sessions where account_id = ?'),
    purgeSessions: db.prepare('delete from sessions where expires_at < ?'),
  };

  if (!q.secret.get()) q.setSecret.run(crypto.randomBytes(32).toString('base64'), Date.now());

  const store = {
    file: memory ? null : file,

    // Nothing to wait for: the database is open and up to date. (store-postgres.js checks its tables here.)
    ready() {},

    secret: () => q.secret.get().prelogin_secret,

    userByEmail: (email) => toUser(q.userByEmail.get(String(email))),
    userById: (id) => toUser(q.userById.get(String(id))),

    // Returns false when the email address already has an account.
    createUser({ id, email, salt, auth, createdAt }) {
      try {
        q.insertUser.run(id, email, salt, auth, createdAt, createdAt, createdAt);
        return true;
      } catch (err) {
        if (/UNIQUE constraint failed: accounts\.email/.test(err.message)) return false;
        throw err;
      }
    },

    // Writes only if the vault is still at baseVersion, so two devices can't overwrite each other.
    putVault(userId, baseVersion, blob, at) {
      const { changes } = q.putVault.run(blob, at, at, userId, baseVersion);
      const row = q.userById.get(userId);
      return { ok: changes === 1, version: row.vault_version, blob: row.vault_blob };
    },

    // A new password brings a new salt, verifier and vault key, so the vault encrypted with the new key is
    // written in the same step, and every session is signed out. Nothing changes unless the vault is still at
    // baseVersion.
    changePassword(userId, { salt, auth, baseVersion, blob, at }) {
      return transaction(db, () => {
        const { changes } = q.changePassword.run(salt, auth, blob, at, at, userId, baseVersion);
        if (changes === 1) q.deleteSessions.run(userId);
        const row = q.userById.get(userId);
        return { ok: changes === 1, version: row.vault_version, blob: row.vault_blob };
      });
    },

    // The account's devices and sessions go with it.
    deleteUser: (userId) => q.deleteUser.run(String(userId)).changes > 0,

    setTotp(userId, totp, at) {
      q.setTotp.run(totp ? totp.secret : null, totp && totp.enabled ? 1 : 0, at, userId);
    },

    devices: (userId) => q.devices.all(userId).map(toDevice),
    device: (userId, id) => (typeof id === 'string' ? toDevice(q.device.get(userId, id)) : undefined),
    deviceCount: (userId) => q.deviceCount.get(userId).n,
    saveDevice(userId, { id, publicKey, name, os, lastSeen }) {
      q.saveDevice.run(userId, id, publicKey, name, os, lastSeen, lastSeen);
    },
    removeDevice: (userId, id) => q.removeDevice.run(userId, String(id)).changes > 0,

    createSession(tokenHash, userId, createdAt, expiresAt) {
      q.insertSession.run(tokenHash, userId, createdAt, expiresAt);
    },
    session(tokenHash) {
      const row = q.session.get(tokenHash);
      return row && { tokenHash: row.token_hash, userId: row.account_id, createdAt: row.created_at, expiresAt: row.expires_at };
    },
    deleteSession(tokenHash) {
      q.deleteSession.run(tokenHash);
    },
    purgeExpiredSessions: (at) => q.purgeSessions.run(at).changes,

    // Moves accounts over from the JSON file older versions of JConnect Cloud used. It runs only while the
    // database has no accounts, and keeps the file as <name>.imported. Returns how many accounts it imported.
    importJson(jsonFile) {
      if (!jsonFile || !fs.existsSync(jsonFile) || q.accountCount.get().n > 0) return 0;
      const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      const users = Object.values(data.users || {});
      const at = Date.now();
      transaction(db, () => {
        if (data.secret) q.setSecret.run(data.secret, at);
        for (const u of users) {
          const createdAt = u.createdAt || at;
          q.insertUser.run(u.id, String(u.email).toLowerCase(), u.salt, u.auth, createdAt, createdAt, at);
          const vault = u.vault || {};
          q.setVault.run(vault.version || 0, vault.blob ?? null, vault.updatedAt || at, u.id);
          if (u.totp && u.totp.secret) q.setTotp.run(u.totp.secret, u.totp.enabled ? 1 : 0, at, u.id);
          for (const [id, d] of Object.entries(u.devices || {})) {
            q.saveDevice.run(u.id, id, d.publicKey, String(d.name || '').slice(0, 64), String(d.os || '').slice(0, 32), d.lastSeen || at, d.lastSeen || at);
          }
        }
        for (const [tokenHash, s] of Object.entries(data.sessions || {})) {
          if (s.expiresAt > at && data.users && data.users[s.userId]) q.insertSession.run(tokenHash, s.userId, s.createdAt || at, s.expiresAt);
        }
      });
      fs.renameSync(jsonFile, `${jsonFile}.imported`);
      return users.length;
    },

    // Every row the server keeps, for tests and backups.
    dump() {
      const all = (table) => db.prepare(`select * from ${table}`).all();
      return { settings: all('settings'), accounts: all('accounts'), devices: all('devices'), sessions: all('sessions') };
    },

    close() {
      db.close();
    },
  };
  return store;
}

module.exports = { openStore };
