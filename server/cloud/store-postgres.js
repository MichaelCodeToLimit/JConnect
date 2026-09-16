// JConnect Cloud storage in Postgres (such as Render Postgres), with the same methods as store.js except that each
// one returns a promise. ready() creates or updates the tables, in a "jconnect" schema, before the server takes
// requests. Times are milliseconds since 1970, like Date.now().
const fs = require('fs');
const crypto = require('crypto');

// Each entry upgrades the schema by one version, recorded in jconnect.migrations. Only ever append.
const MIGRATIONS = [
  `
  create table jconnect.accounts (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    kdf_salt text not null,
    auth_verifier text not null,
    totp_secret text,
    totp_enabled boolean not null default false,
    vault_version integer not null default 0,
    vault_blob text,
    vault_updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint accounts_email_lowercase check (email = lower(email)),
    constraint accounts_email_format check (char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
    constraint accounts_kdf_salt_format check (kdf_salt ~ '^[A-Za-z0-9+/]{22}==$'),
    constraint accounts_auth_verifier_format check (auth_verifier ~ '^[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]{43}=$'),
    constraint accounts_totp_needs_secret check (not totp_enabled or totp_secret is not null),
    constraint accounts_vault_version_not_negative check (vault_version >= 0),
    constraint accounts_vault_blob_size check (vault_blob is null or char_length(vault_blob) <= 2097152)
  );
  create unique index accounts_email_key on jconnect.accounts (email);

  create table jconnect.devices (
    account_id uuid not null references jconnect.accounts (id) on delete cascade,
    device_id text not null,
    public_key text not null,
    name text not null default '',
    os text not null default '',
    last_seen timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (account_id, device_id),
    constraint devices_id_format check (device_id ~ '^[0-9a-f]{20}$'),
    constraint devices_public_key_format check (public_key ~ '^[A-Za-z0-9+/]{43}=$'),
    constraint devices_name_length check (char_length(name) <= 64),
    constraint devices_os_length check (char_length(os) <= 32)
  );
  create index devices_device_id_idx on jconnect.devices (device_id);

  -- An account can register at most 50 devices, even when registrations arrive at once. Registering a device again is always allowed.
  create function jconnect.enforce_device_limit() returns trigger
  language plpgsql
  set search_path = ''
  as $$
  begin
    if not exists (select 1 from jconnect.devices d where d.account_id = new.account_id and d.device_id = new.device_id)
      and (select count(*) from jconnect.devices d where d.account_id = new.account_id) >= 50 then
      raise exception 'too-many-devices' using errcode = 'check_violation';
    end if;
    return new;
  end;
  $$;
  create trigger devices_limit before insert on jconnect.devices
    for each row execute function jconnect.enforce_device_limit();

  -- Only a SHA-256 hash of each session token is kept.
  create table jconnect.sessions (
    token_hash text primary key,
    account_id uuid not null references jconnect.accounts (id) on delete cascade,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    constraint sessions_token_hash_format check (token_hash ~ '^[A-Za-z0-9+/]{43}=$'),
    constraint sessions_expire_after_creation check (expires_at > created_at)
  );
  create index sessions_account_id_idx on jconnect.sessions (account_id);
  create index sessions_expires_at_idx on jconnect.sessions (expires_at);

  -- One row. prelogin_secret gives unknown email addresses a stable fake salt, so sign-in can't reveal which have accounts.
  create table jconnect.settings (
    id boolean primary key default true,
    prelogin_secret text not null,
    created_at timestamptz not null default now(),
    constraint settings_single_row check (id)
  );

  create function jconnect.touch_updated_at() returns trigger
  language plpgsql
  set search_path = ''
  as $$
  begin
    new.updated_at = now();
    return new;
  end;
  $$;
  create trigger accounts_touch_updated_at before update on jconnect.accounts
    for each row execute function jconnect.touch_updated_at();
  `,
];

// Any number will do, as long as nothing else sharing the database locks it.
const MIGRATION_LOCK = 4790001;

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

// node-postgres settings for a connection string:
//  - a database on this computer is reached without TLS.
//  - one on a private network (a private address, or a name without dots such as Render's internal addresses)
//    uses TLS without checking the certificate, because those are self-signed. sslmode=disable turns TLS off.
//  - any other uses TLS with the certificate checked.
// DATABASE_CA_CERT (the text or path of a PEM file) makes TLS check against that certificate everywhere. SSL
// options in the string are dropped, because node-postgres would let them replace these.
function poolConfig(connectionString, { ca = process.env.DATABASE_CA_CERT, max = 5 } = {}) {
  const url = new URL(connectionString);
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error('The database address must start with postgres:// or postgresql://');
  const disabled = url.searchParams.get('sslmode') === 'disable';
  for (const name of [...url.searchParams.keys()]) if (/^(ssl|uselibpqcompat)/i.test(name)) url.searchParams.delete(name);
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(url.hostname);
  const privateNetwork = /^[a-z0-9-]+$/i.test(url.hostname) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
  let ssl = false;
  if (!loopback && !(privateNetwork && disabled)) {
    ssl = ca
      ? { ca: ca.includes('-----BEGIN') ? ca : fs.readFileSync(ca, 'utf8'), rejectUnauthorized: true }
      : { rejectUnauthorized: !privateNetwork };
  }
  return { connectionString: url.toString(), ssl, max, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 };
}

function openPostgresStore(connectionString, options = {}) {
  const { Pool } = require('pg');
  const pool = new Pool(poolConfig(connectionString, options));
  // The database may close idle connections. The pool opens new ones, so the server carries on.
  pool.on('error', (err) => {
    if (!process.env.JCONNECT_CLOUD_QUIET) console.error(new Date().toISOString(), '[cloud] database connection closed:', err.message);
  });
  const query = async (text, params) => (await pool.query(text, params)).rows;
  const one = async (text, params) => (await query(text, params))[0];
  let secret = null;

  return {
    file: null,

    // Creates or updates the tables. The lock stops two servers starting together from both doing it.
    async ready() {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
        await client.query('create schema if not exists jconnect');
        await client.query('create table if not exists jconnect.migrations (version integer primary key, applied_at timestamptz not null default now())');
        const { rows: [{ version }] } = await client.query('select coalesce(max(version), 0)::int as version from jconnect.migrations');
        for (let v = version; v < MIGRATIONS.length; v++) {
          await client.query(MIGRATIONS[v]);
          await client.query('insert into jconnect.migrations (version) values ($1)', [v + 1]);
        }
        await client.query('insert into jconnect.settings (id, prelogin_secret) values (true, $1) on conflict (id) do nothing', [crypto.randomBytes(32).toString('base64')]);
        const { rows: [settings] } = await client.query('select prelogin_secret from jconnect.settings where id');
        await client.query('commit');
        secret = settings.prelogin_secret;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
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
