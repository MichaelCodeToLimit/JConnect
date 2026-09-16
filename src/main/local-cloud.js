// Accounts on this PC: JConnect Cloud (server/cloud) running inside JConnect, with its SQLite database in
// JConnect's data folder. The customer's other devices sign in with this PC's address instead of JConnect's
// hosted server, while this PC is on and they're on the same network or Tailscale.
const path = require('path');
const { EventEmitter } = require('events');
const JCSecure = require('../shared/secure-channel');
const { ACCOUNTS_PORT } = require('./account');
const { localInterfaces } = require('./discovery');

class LocalCloud extends EventEmitter {
  constructor({ dataDir, port = ACCOUNTS_PORT }) {
    super();
    this.dataDir = dataDir;
    this.port = port;
    this.cloud = null;
    this.boundPort = null;
    this.error = null;
    this._queue = Promise.resolve();
  }

  get running() { return !!this.cloud; }

  // The address JConnect on this PC signs in with.
  get url() { return `http://127.0.0.1:${this.boundPort || this.port}`; }

  // Starts or stops the server to match the setting. Changes run one at a time, so quick toggles can't overlap.
  apply(on) {
    const run = this._queue.then(() => (on ? this._start() : this._stop()));
    this._queue = run.catch(() => {});
    return run;
  }

  async _start() {
    if (this.cloud) return;
    const { createCloud } = require('../../server/cloud/cloud');
    const cloud = createCloud({ port: this.port, database: path.join(this.dataDir, 'cloud.db'), databaseUrl: null });
    try {
      this.boundPort = await cloud.listen();
    } catch (err) {
      await cloud.close().catch(() => {});
      this.error = err.code === 'EADDRINUSE' ? `Another program is using port ${this.port}, so this PC can’t keep accounts.` : 'Accounts on this PC couldn’t start.';
      this.emit('change');
      throw JCSecure.failure(err.code === 'EADDRINUSE' ? 'accounts-port' : 'accounts-start');
    }
    this.cloud = cloud;
    this.error = null;
    this.emit('change');
  }

  async _stop() {
    const { cloud } = this;
    this.cloud = null;
    this.boundPort = null;
    this.error = null;
    if (cloud) await cloud.close();
    this.emit('change');
  }

  status() {
    const port = this.boundPort || this.port;
    return {
      running: this.running,
      port,
      // What other devices type to sign in, one for each network this PC is on.
      addresses: localInterfaces().map((i) => `${i.address}${port === ACCOUNTS_PORT ? '' : `:${port}`}`),
      error: this.error,
    };
  }
}

module.exports = { LocalCloud };
