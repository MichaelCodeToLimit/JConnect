// A throwaway, empty Postgres for tests: PGlite (Postgres compiled to WebAssembly) served on a local port, so
// JConnect Cloud reaches it through node-postgres, the driver it uses with a real database.
const net = require('net');

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

async function startPostgres() {
  const { PGlite } = require('@electric-sql/pglite');
  const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
  const db = await PGlite.create();
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
