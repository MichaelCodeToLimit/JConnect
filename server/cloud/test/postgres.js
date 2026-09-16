// A throwaway Postgres for tests: PGlite (Postgres compiled to WebAssembly), set up the way a new Supabase
// database starts out and with JConnect's migrations applied. It's served on a local port, so JConnect Cloud
// reaches it through node-postgres, the driver it uses with a real database.
const fs = require('fs');
const net = require('net');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');

// The test packages come from npm install in server/cloud.
function available() {
  try {
    ['pg', '@electric-sql/pglite', '@electric-sql/pglite-socket'].forEach((name) => require.resolve(name));
    return true;
  } catch {
    return false;
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function startPostgres({ migrate = true } = {}) {
  const { PGlite } = require('@electric-sql/pglite');
  const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
  const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
  const db = await PGlite.create({ extensions: { pgcrypto } });
  // What every Supabase database has before any migration.
  await db.exec(`
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
  `);
  if (migrate) {
    for (const file of fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
      await db.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    }
  }
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 4 });
  await server.start();
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}

module.exports = { available, startPostgres };
