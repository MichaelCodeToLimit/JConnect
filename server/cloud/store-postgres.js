// JConnect Cloud storage in Postgres, such as a Supabase database, with the same methods as store.js except
// that each one returns a promise. The tables come from supabase/migrations, which must be applied to the
// database first; ready() checks for them. Times are milliseconds since 1970, like Date.now().
const fs = require('fs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toDate = (ms) => new Date(ms);
const toMs = (value) => new Date(value).getTime();
// vault_version is an integer column, so a version outside its range can't match.
const validVersion = (v) => Number.isInteger(v) && v >= 0 && v <= 2147483647;

const toUser = (row) => row && {
  id: row.id,
  email: row.email,
  salt: row.kdf_salt,
  auth: row.auth_verifier,
  totp: row.totp_secret ? { secret: row.totp_secret, enabled: row.totp_enabled } : null,
  vault: { version: row.vault_version, blob: row.vault_blob, updatedAt: toMs(row.vault_updated_at) },
  createdAt: toMs(row.created_at),
};

const toDevice = (row) => row && { id: row.device_id, publicKey: row.public_key, name: row.name, os: row.os, lastSeen: toMs(row.last_seen) };

// node-postgres settings for a connection string. A database on this computer is reached without TLS. Any
// other uses TLS with its certificate checked, against DATABASE_CA_CERT when that's set (the path or text of a
// PEM file, such as the certificate from Supabase's Database Settings) or else the system's certificates. Only
// a database on a private network may turn TLS off, with sslmode=disable. SSL options in the string itself are
// dropped, because node-postgres would let them replace these.
function poolConfig(connectionString, { ca = process.env.DATABASE_CA_CERT, max = 5 } = {}) {
  const url = new URL(connectionString);
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error('The database address must start with postgres:// or postgresql://');
  const disabled = url.searchParams.get('sslmode') === 'disable';
  for (const name of [...url.searchParams.keys()]) if (/^(ssl|uselibpqcompat)/i.test(name)) url.searchParams.delete(name);
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(url.hostname);
  const privateNetwork = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
  let ssl = false;
  if (!loopback && !(privateNetwork && disabled)) {
    ssl = { rejectUnauthorized: true };
    if (ca) ssl.ca = ca.includes('-----BEGIN') ? ca : fs.readFileSync(ca, 'utf8');
  }
  return { connectionString: url.toString(), ssl, max, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 };
}

function openPostgresStore(connectionString, options = {}) {
  const { Pool } = require('pg');
  const pool = new Pool(poolConfig(connectionString, options));
  // The database may close idle connections (Supabase's pooler does). The pool reconnects, so the server carries on.
  pool.on('error', (err) => {
    if (!process.env.JCONNECT_CLOUD_QUIET) console.error(new Date().toISOString(), '[cloud] database connection closed:', err.message);
  });
  const query = async (text, params) => (await pool.query(text, params)).rows;
  const one = async (text, params) => (await query(text, params))[0];
  let secret = null;

  return {
    file: null,

    async ready() {
      const { ok } = await one("select to_regclass('jconnect.accounts') is not null as ok");
      if (!ok) throw new Error('The database has no JConnect tables. Apply server/cloud/supabase/migrations to it first.');
      secret = (await one('select prelogin_secret from jconnect.settings where id')).prelogin_secret;
    },

    // The prelogin secret never changes, so it's read once.
    async secret() {
      if (!secret) secret = (await one('select prelogin_secret from jconnect.settings where id')).prelogin_secret;
      return secret;
    },

    userByEmail: async (email) => toUser(await one('select * from jconnect.accounts where email = $1', [String(email)])),
    userById: async (id) => (UUID.test(id) ? toUser(await one('select * from jconnect.accounts where id = $1', [id])) : undefined),

    // Returns false when the email address already has an account.
    async createUser({ id, email, salt, auth, createdAt }) {
      try {
        await query('insert into jconnect.accounts (id, email, kdf_salt, auth_verifier, vault_updated_at, created_at, updated_at) values ($1, $2, $3, $4, $5, $5, $5)',
          [id, email, salt, auth, toDate(createdAt)]);
        return true;
      } catch (err) {
        if (err.code === '23505' && err.constraint === 'accounts_email_key') return false;
        throw err;
      }
    },

    // Writes only if the vault is still at baseVersion, so two devices can't overwrite each other.
    async putVault(userId, baseVersion, blob, at) {
      const changed = validVersion(baseVersion) && await one(
        'update jconnect.accounts set vault_version = vault_version + 1, vault_blob = $1, vault_updated_at = $2 where id = $3 and vault_version = $4 returning vault_version, vault_blob',
        [blob, toDate(at), userId, baseVersion]);
      const row = changed || await one('select vault_version, vault_blob from jconnect.accounts where id = $1', [userId]);
      return { ok: !!changed, version: row.vault_version, blob: row.vault_blob };
    },

    // Same as store.js: the new salt, verifier and re-encrypted vault are written together, every session is
    // signed out, and nothing changes unless the vault is still at baseVersion. One statement, so it's atomic.
    async changePassword(userId, { salt, auth, baseVersion, blob, at }) {
      const row = await one(`
        with changed as (
          update jconnect.accounts set kdf_salt = $1, auth_verifier = $2, vault_version = vault_version + 1, vault_blob = $3, vault_updated_at = $4
          where id = $5 and vault_version = $6 returning vault_version, vault_blob
        ), signed_out as (
          delete from jconnect.sessions where account_id = $5 and exists (select 1 from changed)
        )
        select exists (select 1 from changed) as ok,
          coalesce((select vault_version from changed), a.vault_version) as vault_version,
          coalesce((select vault_blob from changed), a.vault_blob) as vault_blob
        from jconnect.accounts a where a.id = $5`,
      [salt, auth, blob, toDate(at), userId, validVersion(baseVersion) ? baseVersion : -1]);
      return { ok: row.ok, version: row.vault_version, blob: row.vault_blob };
    },

    // The account's devices and sessions go with it.
    deleteUser: async (userId) => (await query('delete from jconnect.accounts where id = $1 returning 1', [userId])).length > 0,

    // updated_at is kept by a trigger.
    async setTotp(userId, totp) {
      await query('update jconnect.accounts set totp_secret = $1, totp_enabled = $2 where id = $3', [totp ? totp.secret : null, !!(totp && totp.enabled), userId]);
    },

    devices: async (userId) => (await query('select * from jconnect.devices where account_id = $1 order by created_at, device_id', [userId])).map(toDevice),
    device: async (userId, id) => (typeof id === 'string' ? toDevice(await one('select * from jconnect.devices where account_id = $1 and device_id = $2', [userId, id])) : undefined),
    deviceCount: async (userId) => (await one('select count(*)::int as n from jconnect.devices where account_id = $1', [userId])).n,
    async saveDevice(userId, { id, publicKey, name, os, lastSeen }) {
      try {
        await query(`insert into jconnect.devices (account_id, device_id, public_key, name, os, last_seen, created_at) values ($1, $2, $3, $4, $5, $6, $6)
          on conflict (account_id, device_id) do update set public_key = excluded.public_key, name = excluded.name, os = excluded.os, last_seen = excluded.last_seen`,
        [userId, id, publicKey, name, os, toDate(lastSeen)]);
      } catch (err) {
        // The database allows 50 devices an account, even when two registrations arrive at once.
        if (/too-many-devices/.test(err.message)) throw Object.assign(new Error('too-many-devices'), { status: 429 });
        throw err;
      }
    },
    removeDevice: async (userId, id) => (await query('delete from jconnect.devices where account_id = $1 and device_id = $2 returning 1', [userId, String(id)])).length > 0,

    async createSession(tokenHash, userId, createdAt, expiresAt) {
      await query('insert into jconnect.sessions (token_hash, account_id, created_at, expires_at) values ($1, $2, $3, $4)', [tokenHash, userId, toDate(createdAt), toDate(expiresAt)]);
    },
    async session(tokenHash) {
      const row = await one('select * from jconnect.sessions where token_hash = $1', [tokenHash]);
      return row && { tokenHash: row.token_hash, userId: row.account_id, createdAt: toMs(row.created_at), expiresAt: toMs(row.expires_at) };
    },
    async deleteSession(tokenHash) {
      await query('delete from jconnect.sessions where token_hash = $1', [tokenHash]);
    },
    purgeExpiredSessions: async (at) => (await one('with removed as (delete from jconnect.sessions where expires_at < $1 returning 1) select count(*)::int as n from removed', [toDate(at)])).n,

    // Every row the server keeps, for tests and backups.
    async dump() {
      const all = (table) => query(`select * from jconnect.${table}`);
      return { settings: await all('settings'), accounts: await all('accounts'), devices: await all('devices'), sessions: await all('sessions') };
    },

    close: () => pool.end(),
  };
}

module.exports = { openPostgresStore, poolConfig };
