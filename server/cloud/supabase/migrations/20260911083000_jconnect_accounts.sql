-- JConnect Cloud accounts.
--
-- Everything lives in its own "jconnect" schema. Supabase's Data API doesn't expose new schemas, and
-- the anon and authenticated roles get no access, so nothing here can be read or changed from the
-- public API. The JConnect Cloud server is the only client: it connects as the database owner or with
-- the service role. Row level security is still turned on, with no policies, in case the schema is
-- ever exposed.
--
-- The password never reaches this database. The app derives an auth key and a vault key from it
-- with scrypt. Only a salted scrypt hash of the auth key is stored, and the vault is ciphertext that
-- only the user's devices can decrypt.

create schema if not exists jconnect;
revoke all on schema jconnect from public;
grant usage on schema jconnect to service_role;

-- ---- accounts ----

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
  constraint accounts_email_format check (char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint accounts_kdf_salt_format check (kdf_salt ~ '^[A-Za-z0-9+/]{22}==$'),
  constraint accounts_auth_verifier_format check (auth_verifier ~ '^[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]{43}=$'),
  constraint accounts_totp_needs_secret check (not totp_enabled or totp_secret is not null),
  constraint accounts_vault_version_not_negative check (vault_version >= 0),
  constraint accounts_vault_blob_size check (vault_blob is null or char_length(vault_blob) <= 2097152)
);

create unique index accounts_email_key on jconnect.accounts (email);

comment on table jconnect.accounts is 'JConnect Cloud accounts. Holds no passwords and no readable sync data.';
comment on column jconnect.accounts.kdf_salt is 'Base64 salt the app uses to derive its auth and vault keys from the password.';
comment on column jconnect.accounts.auth_verifier is 'serverSalt:hash, both base64: a scrypt hash of the auth key the app sends.';
comment on column jconnect.accounts.totp_secret is 'Base32 authenticator secret while two-step sign-in is being set up or is on.';
comment on column jconnect.accounts.vault_blob is 'Sync vault encrypted on the device with XSalsa20-Poly1305. The server cannot read it.';
comment on column jconnect.accounts.vault_version is 'Increases on every vault write; writes must name the version they are based on.';

-- ---- devices ----

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

comment on table jconnect.devices is 'Devices registered to an account, each proven with its Ed25519 signing key.';

-- An account can register at most 50 devices. Registering a device again is always allowed.
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

-- ---- sessions ----

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

comment on table jconnect.sessions is 'Signed-in sessions. Only a SHA-256 hash of each token is stored.';

create function jconnect.purge_expired_sessions() returns integer
language sql
set search_path = ''
as $$
  with removed as (delete from jconnect.sessions where expires_at < now() returning 1)
  select count(*)::integer from removed;
$$;

-- ---- settings ----

create table jconnect.settings (
  id boolean primary key default true,
  prelogin_secret text not null default encode(extensions.gen_random_bytes(32), 'base64'),
  created_at timestamptz not null default now(),
  constraint settings_single_row check (id)
);

comment on table jconnect.settings is 'One row of server settings. prelogin_secret gives unknown email addresses a stable fake salt, so sign-in can''t be used to find accounts.';

insert into jconnect.settings default values;

-- ---- housekeeping ----

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

-- ---- access ----

alter table jconnect.accounts enable row level security;
alter table jconnect.devices enable row level security;
alter table jconnect.sessions enable row level security;
alter table jconnect.settings enable row level security;

revoke all on all tables in schema jconnect from public, anon, authenticated;
revoke all on all functions in schema jconnect from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema jconnect to service_role;
grant execute on function jconnect.purge_expired_sessions() to service_role;
