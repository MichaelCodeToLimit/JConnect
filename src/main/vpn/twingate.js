const https = require('https');
const { spawn } = require('child_process');
const { run, firstExisting, windowsService, startWindowsService, elevate, waitFor, fail } = require('./util');

const APP = {
  win32: ['C:\\Program Files\\Twingate\\Twingate.exe'],
  darwin: ['/Applications/Twingate.app'],
  linux: ['/usr/bin/twingate'],
};

function graphql(network, apiKey, query, variables) {
  return new Promise((resolve, reject) => {
    if (!/^[a-z0-9-]{1,63}$/i.test(network)) {
      reject(fail('network'));
      return;
    }
    const body = JSON.stringify({ query, variables });
    const req = https.request({
      host: `${network}.twingate.com`,
      path: '/api/graphql/',
      method: 'POST',
      timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-API-KEY': apiKey },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) { reject(fail('credentials')); return; }
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.errors && data.errors.length) reject(fail('api', { detail: data.errors[0].message }));
          else resolve(data.data);
        } catch {
          reject(fail('api'));
        }
      });
    });
    req.on('timeout', () => req.destroy(fail('unreachable')));
    req.on('error', (err) => reject(err.code ? fail('unreachable') : err));
    req.end(body);
  });
}

const RESOURCES = `query Resources($after: String) {
  resources(after: $after, first: 100) {
    pageInfo { hasNextPage endCursor }
    edges { node { id name address { value } remoteNetwork { name } } }
  }
}`;

function create({ store }) {
  const settings = () => store.data.vpn.twingate || {};
  const app = () => firstExisting(APP[process.platform] || []);

  return {
    id: 'twingate',
    name: 'Twingate',
    kind: 'zero-trust',
    website: 'https://www.twingate.com/download',

    async detect() {
      if (!app()) return { installed: false, account: settings().network || null };
      let running = false;
      if (process.platform === 'win32') running = (await windowsService('Twingate.Service')) === 'running';
      else if (process.platform === 'linux') running = /online|connected/i.test((await run('twingate', ['status'], { timeout: 5000 })).stdout);
      else running = /Twingate/.test((await run('pgrep', ['-lf', 'Twingate'], { timeout: 5000 })).stdout);
      return {
        installed: true,
        running,
        connected: running,
        account: settings().network || null,
        canImport: !!(settings().network && settings().apiKey),
        detail: running ? 'Running' : 'Stopped',
      };
    },

    async connect({ onProgress = () => {} } = {}) {
      const exe = app();
      if (!exe) throw fail('not-installed');
      onProgress('Starting Twingate…');
      if (process.platform === 'win32') {
        await startWindowsService('Twingate.Service');
        spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Twingate'], { detached: true, stdio: 'ignore' }).unref();
      } else {
        await run('twingate', ['start'], { timeout: 30000 });
      }
      const ok = await waitFor(async () => (await this.detect()).running, { timeoutMs: 45000 });
      if (!ok) throw fail('vpn-not-connected');
    },

    async disconnect() {
      if (process.platform === 'win32') await elevate('powershell.exe', ['-NoProfile', '-Command', 'Stop-Service -Name Twingate.Service']);
      else if (process.platform === 'linux') await run('twingate', ['stop'], { timeout: 15000 });
    },

    // Connect a Twingate account so its Resources can be imported: network name + read-only API key.
    async signIn({ network, apiKey }) {
      const name = String(network || '').trim().replace(/\.twingate\.com.*$/i, '');
      const key = String(apiKey || '').trim();
      if (!name || !key) throw fail('credentials');
      await graphql(name, key, 'query { resources(first: 1) { edges { node { id } } } }');
      store.update((d) => { d.vpn.twingate = { ...(d.vpn.twingate || {}), network: name, apiKey: store.seal(key) }; });
    },

    async signOut() {
      store.update((d) => { delete d.vpn.twingate; });
    },

    async machines() {
      const { network, apiKey } = settings();
      const key = store.unseal(apiKey);
      if (!network || !key) throw fail('account-required');
      const out = [];
      let after = null;
      for (let page = 0; page < 20; page++) {
        const data = await graphql(network, key, RESOURCES, { after });
        const { edges, pageInfo } = data.resources;
        for (const { node } of edges) {
          const address = node.address && node.address.value;
          if (!address || /[*/]/.test(address)) continue; // wildcards and ranges aren't single machines
          out.push({ key: `twingate:${node.id}`, name: node.name, host: address, group: node.remoteNetwork && node.remoteNetwork.name, online: null });
        }
        if (!pageInfo.hasNextPage) break;
        after = pageInfo.endCursor;
      }
      return out;
    },

    async addressesFor() { return []; },
  };
}

module.exports = { create };
