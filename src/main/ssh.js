// SSH: a terminal to any SSH host, to JConnect computers through JVPN, and to machines on a VPN.
//
// Host keys are pinned on first use and a changed key stops the connection. Authentication tries the
// SSH agent, then this device's own JConnect key, then asks for a password.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BrowserWindow, ipcMain, clipboard } = require('electron');
const { Client, utils } = require('ssh2');
const JCSecure = require('../shared/secure-channel');

const AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

function parseSshConfig(text) {
  const hosts = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^(\S+)\s*=?\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = null;
      const alias = value.split(/\s+/).find((pattern) => !/[*?!]/.test(pattern));
      if (alias) {
        current = { name: alias, host: alias, port: 22 };
        hosts.push(current);
      }
    } else if (key === 'match') {
      current = null;
    } else if (current) {
      if (key === 'hostname') current.host = value;
      else if (key === 'user') current.username = value;
      else if (key === 'port') current.port = Number(value) || 22;
      else if (key === 'identityfile') current.identityFile = value.replace(/^~(?=$|[\\/])/, os.homedir());
    }
  }
  return hosts;
}

const fingerprint = (key) => `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

class SshManager {
  constructor({ store, jvpn, router, rendererDir, preload, icon }) {
    this.store = store;
    this.jvpn = jvpn;
    this.router = router;
    this.rendererDir = rendererDir;
    this.preload = preload;
    this.icon = icon;
    this.sessions = new Map(); // webContents id -> session

    const forWindow = (fn) => (event, payload) => {
      const session = this.sessions.get(event.sender.id);
      if (session) fn(session, payload || {});
    };
    ipcMain.on('ssh:input', forWindow((s, { data }) => { if (s.stream && typeof data === 'string') s.stream.write(data); }));
    ipcMain.on('ssh:resize', forWindow((s, { cols, rows }) => {
      s.cols = Math.max(20, Math.min(500, Number(cols) || 80));
      s.rows = Math.max(5, Math.min(300, Number(rows) || 24));
      if (s.stream) s.stream.setWindow(s.rows, s.cols, 0, 0);
    }));
    ipcMain.on('ssh:answer', forWindow((s, { id, value }) => {
      const waiter = s.prompts.get(id);
      if (waiter) {
        s.prompts.delete(id);
        waiter(value);
      }
    }));
    ipcMain.on('ssh:start', forWindow((s) => this._start(s)));
    ipcMain.on('ssh:disconnect', forWindow((s) => this._stop(s)));
  }

  get data() {
    if (!this.store.data.ssh) this.store.data.ssh = { hosts: [], keys: [], knownHosts: {} };
    return this.store.data.ssh;
  }

  hosts() { return this.data.hosts.map(({ password, ...rest }) => rest); }

  saveHost(entry) {
    const host = String(entry.host || '').trim();
    if (!host || /\s/.test(host)) throw JCSecure.failure('host');
    const port = Number(entry.port) || 22;
    const id = entry.id || `ssh-${crypto.createHash('sha1').update(`${host}:${port}:${entry.username || ''}`).digest('hex').slice(0, 16)}`;
    this.store.update((d) => {
      const list = d.ssh.hosts;
      const existing = list.find((h) => h.id === id);
      const next = {
        id,
        name: String(entry.name || host).slice(0, 64),
        host,
        port,
        username: entry.username ? String(entry.username).slice(0, 64) : '',
        identityFile: entry.identityFile || (existing && existing.identityFile) || null,
        via: entry.via || 'auto',
        source: entry.source || (existing && existing.source) || 'manual',
        addedAt: (existing && existing.addedAt) || Date.now(),
        updatedAt: Date.now(),
      };
      if (existing) Object.assign(existing, next);
      else list.push(next);
      delete d.tombstones.sshHosts[id];
    });
    return id;
  }

  removeHost(id) {
    this.store.update((d) => {
      d.ssh.hosts = d.ssh.hosts.filter((h) => h.id !== id);
      d.tombstones.sshHosts[id] = Date.now();
    });
  }

  importSshConfig() {
    const file = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(file)) return [];
    const added = [];
    for (const entry of parseSshConfig(fs.readFileSync(file, 'utf8'))) {
      added.push(this.saveHost({ ...entry, source: 'ssh-config' }));
    }
    return added;
  }

  // This device's SSH key. Add the public half to ~/.ssh/authorized_keys on hosts you use.
  key() {
    let key = this.data.keys.find((k) => k.id === 'default');
    if (!key) {
      const pair = utils.generateKeyPairSync('ed25519', { comment: `jconnect@${os.hostname()}` });
      key = { id: 'default', type: 'ssh-ed25519', publicKey: pair.public.trim(), privateKey: this.store.seal(pair.private), createdAt: Date.now() };
      this.store.update((d) => { d.ssh.keys.push(key); });
    }
    return key;
  }

  publicKey() { return this.key().publicKey; }

  async copyPublicKey() {
    // Electron 44's clipboard methods return promises.
    await clipboard.writeText(this.publicKey());
    return true;
  }

  // target: { hostId } for an SSH host, or { computerId } for SSH to a JConnect computer through JVPN.
  openTerminal(target, getComputer) {
    const label = target.computerId ? (getComputer(target.computerId) || {}).name : (this.data.hosts.find((h) => h.id === target.hostId) || {}).name;
    const win = new BrowserWindow({
      width: 960,
      height: 620,
      minWidth: 480,
      minHeight: 300,
      title: `${label || 'SSH'} — JConnect`,
      icon: this.icon,
      backgroundColor: '#0f1115',
      autoHideMenuBar: true,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true },
    });
    const session = { win, target, getComputer, prompts: new Map(), cols: 80, rows: 24, client: null, stream: null, forward: null };
    this.sessions.set(win.webContents.id, session);
    win.on('closed', () => {
      this._stop(session);
      this.sessions.delete(session.webContentsId);
    });
    session.webContentsId = win.webContents.id;
    win.loadFile(path.join(this.rendererDir, 'terminal', 'terminal.html'), { query: { name: label || 'SSH' } });
    return win;
  }

  _send(session, type, data = {}) {
    if (!session.win.isDestroyed()) session.win.webContents.send('ssh:event', { type, ...data });
  }

  _ask(session, kind, message, extra = {}) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      session.prompts.set(id, resolve);
      this._send(session, 'prompt', { id, kind, message, ...extra });
    });
  }

  _stop(session) {
    for (const waiter of session.prompts.values()) waiter(null);
    session.prompts.clear();
    if (session.stream) { try { session.stream.close(); } catch { /* closed */ } }
    if (session.client) { try { session.client.end(); } catch { /* closed */ } }
    session.stream = null;
    session.client = null;
  }

  async _start(session) {
    this._stop(session);
    const { target } = session;
    const status = (text) => this._send(session, 'status', { text });
    let name;
    let host;
    let port = 22;
    let username;
    let sock;
    let identityFile = null;
    let knownKey;

    try {
      if (target.computerId) {
        const computer = session.getComputer(target.computerId);
        if (!computer) throw JCSecure.failure('gone');
        name = computer.name;
        host = computer.name;
        knownKey = `computer:${computer.id}`;
        username = (this.data.computerUsers || {})[computer.id] || '';
        status(`Connecting to ${name}…`);
        sock = await this.jvpn.openStream(computer, 'ssh', { onProgress: status });
      } else {
        const entry = this.data.hosts.find((h) => h.id === target.hostId);
        if (!entry) throw JCSecure.failure('gone');
        ({ name, host, port, username, identityFile } = entry);
        knownKey = `${host}:${port}`;
        status(`Connecting to ${name}…`);
        await this.router.resolveHost({ host, port, via: entry.via, name }, { onProgress: status });
      }

      if (!username) {
        username = await this._ask(session, 'text', `User name for ${name}`, { value: os.userInfo().username });
        if (!username) throw JCSecure.failure('cancelled');
        if (target.computerId) this.store.update((d) => { d.ssh.computerUsers = { ...(d.ssh.computerUsers || {}), [target.computerId]: username }; });
        else this.store.update((d) => { const h = d.ssh.hosts.find((x) => x.id === target.hostId); if (h) h.username = username; });
      }

      let identity = null;
      if (identityFile && fs.existsSync(identityFile)) {
        const raw = fs.readFileSync(identityFile);
        let parsed = utils.parseKey(raw);
        if (parsed instanceof Error && /passphrase/i.test(parsed.message)) {
          const passphrase = await this._ask(session, 'password', `Passphrase for ${path.basename(identityFile)}`);
          if (passphrase) parsed = utils.parseKey(raw, passphrase);
        }
        if (!(parsed instanceof Error)) identity = raw;
      }
      const ownKey = this.store.unseal(this.key().privateKey);
      const agent = process.platform === 'win32' ? (fs.existsSync(AGENT_PIPE) ? AGENT_PIPE : null) : process.env.SSH_AUTH_SOCK || null;

      const client = new Client();
      session.client = client;
      const tried = new Set();

      client.on('ready', () => {
        status(`Connected to ${name}`);
        client.shell({ term: 'xterm-256color', cols: session.cols, rows: session.rows }, (err, stream) => {
          if (err) {
            this._send(session, 'error', { message: `${name} didn't open a shell.` });
            return;
          }
          session.stream = stream;
          this._send(session, 'connected', { name });
          stream.on('data', (chunk) => this._send(session, 'data', { data: chunk.toString('base64') }));
          stream.stderr.on('data', (chunk) => this._send(session, 'data', { data: chunk.toString('base64') }));
          stream.on('close', () => {
            session.stream = null;
            this._send(session, 'closed', { message: `The session with ${name} ended.` });
            client.end();
          });
        });
      });
      client.on('error', (err) => {
        const message = /authentication/i.test(err.message) ? `${name} didn't accept the sign-in.`
          : err.level === 'client-timeout' ? `${name} didn't answer in time.`
            : /host key/i.test(err.message) ? err.message
              : `Couldn't connect to ${name}.`;
        this._send(session, 'error', { message, detail: err.message });
      });
      client.on('close', () => {
        if (session.client === client && !session.stream) session.client = null;
      });

      client.connect({
        sock,
        host: sock ? undefined : host,
        port: sock ? undefined : port,
        username,
        readyTimeout: 25000,
        keepaliveInterval: 15000,
        tryKeyboard: true,
        hostVerifier: (key, verify) => {
          const print = fingerprint(key);
          const known = this.data.knownHosts[knownKey];
          if (known === print) { verify(true); return; }
          if (known && known !== print) {
            this._send(session, 'error', {
              message: `${name}'s identity changed. JConnect stopped to keep you safe.`,
              detail: `Expected ${known}\nReceived ${print}\nIf the computer was reinstalled, remove it and add it again.`,
            });
            verify(false);
            return;
          }
          this._ask(session, 'confirm', `First connection to ${name}. Make sure this fingerprint matches the one on ${name}, then choose Trust.`, { detail: print, confirm: 'Trust' })
            .then((ok) => {
              if (ok) this.store.update((d) => { d.ssh.knownHosts[knownKey] = print; });
              verify(!!ok);
            });
        },
        authHandler: (methodsLeft, _partial, next) => {
          const allowed = methodsLeft || ['publickey', 'password', 'keyboard-interactive'];
          if (agent && allowed.includes('publickey') && !tried.has('agent')) { tried.add('agent'); next({ type: 'agent', username, agent }); return; }
          if (identity && allowed.includes('publickey') && !tried.has('identity')) { tried.add('identity'); next({ type: 'publickey', username, key: identity }); return; }
          if (ownKey && allowed.includes('publickey') && !tried.has('own')) { tried.add('own'); next({ type: 'publickey', username, key: ownKey }); return; }
          if (allowed.includes('password') && !tried.has('password')) {
            tried.add('password');
            this._ask(session, 'password', `Password for ${username}@${name}`).then((password) => next(password ? { type: 'password', username, password } : false));
            return;
          }
          if (allowed.includes('keyboard-interactive') && !tried.has('keyboard')) {
            tried.add('keyboard');
            next({
              type: 'keyboard-interactive',
              username,
              prompt: (_name, _instructions, _lang, prompts, finish) => {
                (async () => {
                  const answers = [];
                  for (const p of prompts) answers.push((await this._ask(session, p.echo ? 'text' : 'password', p.prompt.trim())) || '');
                  finish(answers);
                })();
              },
            });
            return;
          }
          next(false);
        },
      });
    } catch (err) {
      const messages = {
        'not-shared': `SSH isn't shared on ${name}. On ${name}, open JConnect Settings and turn on “Share SSH through JVPN”.`,
        'not-running': `${name} doesn't have an SSH server running.`,
        unreachable: `${name} isn't reachable right now.`,
        untrusted: `This device isn't paired with ${name}.`,
        cancelled: 'Connection cancelled.',
        'elevation-cancelled': 'The VPN needs administrator permission to start.',
        'vpn-not-connected': 'The VPN didn’t connect.',
        gone: 'This host was removed.',
      };
      this._send(session, 'error', { message: messages[err.code] || `Couldn't connect to ${name || 'the host'}.`, detail: err.message });
    }
  }
}

module.exports = { SshManager, parseSshConfig, fingerprint };
