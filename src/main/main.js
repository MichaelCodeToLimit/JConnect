const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, nativeTheme, powerMonitor, Notification, shell,
  desktopCapturer, systemPreferences, session: electronSession,
} = require('electron');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--(profile|port|connect|selftest)=(.+)$/.exec(a);
    if (m) out[m[1]] = m[2];
    if (a === '--hidden') out.hidden = true;
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.profile && /^[\w-]{1,32}$/.test(args.profile)) {
  app.setPath('userData', path.join(app.getPath('appData'), `JConnect-${args.profile}`));
}
// Share real local addresses with the peer so direct LAN / Tailscale routes work without mDNS.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.enableSandbox();

const ROOT = path.join(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(ASSETS, 'icon.png');

let store; let security; let input; let capture; let host; let discovery; let resources; let selftest;
let account; let relayLink; let vpn; let router; let jvpnClient; let ssh; let updater;
let mainWin = null;
let tray = null;
let quitting = false;
let shutdownScheduled = false;
let networks = [];
const sessionWins = new Map();
const statuses = new Map();
const forwards = new Set();
const importCache = new Map();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const a = parseArgs(argv);
    if (a.connect) openSession(a.connect);
    else showMain();
  });
  app.whenReady().then(boot).catch((err) => {
    console.error('[jconnect] could not start:', err.stack || err.message);
    dialog.showErrorBox('JConnect could not start', err.stack || err.message);
    app.exit(1);
  });
}

async function boot() {
  const { Store } = require('./store');
  const { Security } = require('./security');
  const { InputController } = require('./input');
  const { CaptureBridge } = require('./capture-bridge');
  const { HostAgent } = require('./host');
  const { Discovery, DEFAULT_AGENT_PORT } = require('./discovery');
  const { ResourceMonitor } = require('./resources');
  const { Account } = require('./account');
  const { RelayLink, JvpnClient } = require('./jvpn');
  const { VpnManager } = require('./vpn');
  const { createRouter } = require('./routes');
  const { SshManager } = require('./ssh');

  applyMenu();
  hardenSessions();

  store = new Store();
  if (store.identityLocked) {
    const message = 'JConnect couldn’t unlock this computer’s identity from the system keychain, so paired devices won’t recognize it. Unlock the keychain, then restart JConnect.';
    store.log({ kind: 'identity', level: 'high', message });
    notify('JConnect couldn’t unlock this computer', message);
  }
  security = new Security(store);
  input = new InputController();
  input.init();
  capture = new CaptureBridge();
  let screenHintAt = 0;
  capture.on('permission-needed', () => {
    if (Date.now() - screenHintAt < 10 * 60000) return;
    screenHintAt = Date.now();
    notify('Allow Screen Recording for JConnect', 'Your devices can’t see this Mac until JConnect is turned on in System Settings → Privacy & Security → Screen Recording.');
  });
  host = new HostAgent({ store, security, input, capture });
  host.askOwner = askOwner;
  await host.listen(Number(args.port) || DEFAULT_AGENT_PORT);

  account = new Account({ store });
  relayLink = new RelayLink({ store, host, cloud: () => account.cloud() });
  host.accountDevices = () => account.devices();
  host.iceServersFor = () => iceServers();

  discovery = new Discovery({
    selfId: store.id,
    getAnnouncement: () => {
      if (!store.settings.remoteAccess || store.settings.hideFromNearby) return null;
      const i = host.info();
      return { id: i.id, name: i.name, os: i.os, publicKey: i.publicKey, port: i.port, travelMode: security.travelMode };
    },
    isTravelMode: () => security.travelMode,
  });
  discovery.start();

  vpn = new VpnManager({ store, shell, account, relayLink });
  router = createRouter({ store, discovery, vpn, account });
  jvpnClient = new JvpnClient({ store, resolveRoute: (computer, options) => router.resolveJconnect(computer, options) });
  ssh = new SshManager({ store, jvpn: jvpnClient, router, rendererDir: RENDERER, preload: PRELOAD, icon: ICON });

  resources = new ResourceMonitor(() => security.travelMode);
  resources.on('change', (level) => {
    host.setResourceCap(level);
    if (!app.isPackaged) console.log(`[jconnect] streaming level ${level} ${JSON.stringify(resources.snapshot())} battery=${powerMonitor.isOnBatteryPower()}`);
  });
  resources.start();

  store.on('change', scheduleUpdate);
  host.on('change', scheduleUpdate);
  if (!app.isPackaged) host.on('code', (code) => console.log(`[jconnect] pairing code ${code}`));
  discovery.on('update', onDiscovery);
  account.on('change', () => {
    relayLink.refresh();
    vpn.invalidate('jvpn');
    scheduleUpdate();
  });
  relayLink.on('change', () => {
    vpn.invalidate('jvpn');
    refreshNetworks();
  });

  security.on('lockdown', (entry) => {
    host.lockdownNow(entry);
    jvpnClient.closeAll();
    discovery.announce();
    notify('JConnect Emergency Lockdown', 'Remote access has been temporarily disabled.');
    showLockdownDialog(entry);
  });
  security.on('notify', (entry) => {
    host.notifyOwners(entry);
    notify('JConnect', entry.message);
  });
  security.on('restored', () => {
    discovery.announce();
    notify('JConnect', 'Remote access has been restored.');
    scheduleUpdate();
  });
  security.on('shutdown-requested', emergencyShutdown);

  powerMonitor.on('suspend', () => {
    host.noticeAll('host-sleep');
    discovery.announce('sleeping');
  });
  powerMonitor.on('resume', () => {
    discovery.announce('ready');
    relayLink.refresh();
  });
  powerMonitor.on('shutdown', () => host.noticeAll('host-shutdown'));

  const { createUpdater } = require('./updater');
  updater = createUpdater({
    app,
    store,
    isIdle: updateIsIdle,
    beforeInstall: prepareForUpdate,
    quit: () => {
      quitting = true;
      app.quit();
      setTimeout(() => app.exit(0), 5000);
    },
    notify,
    openExternal: (url) => shell.openExternal(url),
  });
  updater.events.on('change', scheduleUpdate);

  registerIpc();
  createTray();
  applyLoginItem();
  // With a temporary identity, syncing and the relay would publish a device that's gone after a restart.
  if (!store.identityLocked) {
    account.start();
    relayLink.start();
  }

  if (!args.hidden && !openedAtLogin()) showMain();
  if (args.connect) openSession(args.connect);
  statusLoop();
  refreshNetworks();
  setInterval(() => refreshNetworks(), 60000);
  updater.start();

  if (!app.isPackaged) {
    console.log(`[jconnect] ${store.device().name} ready on port ${host.port} · pairing code ${host.pairingCode}`);
  }
  if (args.selftest) selftest = require('./selftest').run({ spec: args.selftest, showMain, openSession, app });
}

app.on('before-quit', () => {
  quitting = true;
  if (!host) return;
  host.noticeAll('host-shutdown');
  store.saveNow();
});
app.on('will-quit', () => {
  if (discovery) discovery.stop();
  if (relayLink) relayLink.stop();
  if (account) account.stop();
  if (jvpnClient) jvpnClient.closeAll();
  for (const forward of forwards) forward.close();
  if (input) input.close();
  if (updater) updater.stop();
});
app.on('window-all-closed', () => { /* JConnect stays ready in the background */ });
app.on('activate', () => showMain());
app.on('browser-window-focus', () => applyMenu());
app.on('browser-window-blur', () => applyMenu());
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // JConnect's windows only change pages from the main process, so no page may navigate itself anywhere.
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  if (!app.isPackaged) {
    contents.on('console-message', (e, level, message, line, source) => {
      const text = e && e.message !== undefined ? e.message : message;
      const where = e && e.sourceId !== undefined ? `${e.sourceId}:${e.lineNumber}` : `${source}:${line}`;
      console.log(`[renderer] ${String(where).split('/').pop()} ${text}`);
    });
  }
});

// Windows may only use what they need: the hidden capture page may capture the screen, and nothing
// else may ask for devices, notifications, location and so on.
function hardenSessions() {
  const ses = electronSession.defaultSession;
  const isCapture = (wc) => !!wc && wc.getURL().includes('/renderer/capture/');
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media') return callback(isCapture(wc));
    return callback(['fullscreen', 'clipboard-sanitized-write'].includes(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => {
    if (permission === 'media') return isCapture(wc);
    return ['fullscreen', 'clipboard-sanitized-write'].includes(permission);
  });
}

async function iceServers() {
  if (account && account.signedIn()) {
    try {
      const fromCloud = await account.iceServers();
      if (fromCloud.length) return fromCloud;
    } catch { /* fall back to STUN */ }
  }
  const stun = (store.settings.stunServers || []).filter((u) => /^stuns?:/.test(u));
  return stun.length ? [{ urls: stun }] : [];
}

// ---------------------------------------------------------------------------------------------
// Windows

function showMain() {
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
    return mainWin;
  }
  mainWin = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 380,
    minHeight: 520,
    title: 'JConnect',
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f5f6fa',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  mainWin.loadFile(path.join(RENDERER, 'app', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('show', () => { kickStatus(); refreshNetworks(); });
  // Mac permissions may have changed in System Settings while JConnect was in the background.
  mainWin.on('focus', () => { if (process.platform === 'darwin') scheduleUpdate(); });
  mainWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWin.hide();
    if (!store.data.hintedBackground) {
      store.update((d) => { d.hintedBackground = true; });
      notify('JConnect is still ready', 'This computer stays available while the window is closed.');
    }
  });
  mainWin.on('session-end', () => host.noticeAll('host-shutdown'));
  return mainWin;
}

function openSession(computerId) {
  const computer = store.getComputer(computerId);
  if (!computer) return showMain();

  if (computer.type === 'rdp') {
    openRdp(computerId);
    return null;
  }
  if (computer.type === 'host') {
    if (computer.services && computer.services.rdp) openRdp(computerId);
    else openSshForComputer(computer);
    return null;
  }

  const existing = sessionWins.get(computerId);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    show: false,
    title: computer.name,
    icon: ICON,
    backgroundColor: '#000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.jconnectComputerId = computerId;
  sessionWins.set(computerId, win);
  win.loadFile(path.join(RENDERER, 'session', 'session.html'), { query: { id: computerId } });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.on('closed', () => {
    if (sessionWins.get(win.jconnectComputerId) === win) sessionWins.delete(win.jconnectComputerId);
  });
  return win;
}

// The address goes into a Remote Desktop file, where a line break would add settings, so it's checked first.
const rdpTarget = (id, targetHost, port) => {
  if (!/^[\w.:[\]-]{1,255}$/.test(String(targetHost)) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('unreachable');
  return {
    id,
    rdp: { host: targetHost, port, username: null, file: `full address:s:${targetHost}:${port}\r\nprompt for credentials:i:1\r\n` },
  };
};

function friendlyError(err, name = 'The computer') {
  const code = err && (err.code || err.message);
  const messages = {
    unreachable: `${name} isn't reachable right now.`,
    'not-shared': `${name} doesn't share this through JVPN. Turn it on in JConnect Settings on ${name}.`,
    'not-running': `${name} doesn't have that service running.`,
    untrusted: `This device isn't paired with ${name}.`,
    'not-installed': 'The VPN for this computer isn’t installed.',
    'elevation-cancelled': 'The VPN needs administrator permission to start.',
    'vpn-not-connected': 'The VPN didn’t connect.',
    'account-required': 'Sign in to JConnect or the VPN first.',
  };
  return messages[code] || `${name} couldn't be reached.`;
}

async function openRdp(id) {
  const computer = store.getComputer(id);
  if (!computer) return false;
  const { launchRdp } = require('./rdp');
  const dir = path.join(app.getPath('userData'), 'rdp');
  try {
    if (computer.type === 'rdp') {
      await router.resolveHost({ host: computer.rdp.host, port: computer.rdp.port, via: computer.via, name: computer.name }).catch(() => {});
      launchRdp(computer, dir);
    } else if (computer.type === 'host') {
      await router.resolveHost({ host: computer.host, port: 3389, via: computer.via, name: computer.name });
      launchRdp(rdpTarget(computer.id, computer.host, 3389), dir);
    } else {
      const forward = await jvpnClient.forward(computer, 'rdp');
      forwards.add(forward);
      forward.closed.then(() => forwards.delete(forward));
      launchRdp(rdpTarget(computer.id, '127.0.0.1', forward.port), dir);
    }
    return true;
  } catch (err) {
    dialog.showMessageBox(showMain(), { type: 'info', message: `${computer.name} couldn't be opened with Remote Desktop.`, detail: friendlyError(err, computer.name) });
    return false;
  }
}

function openSshForComputer(computer) {
  if (computer.type === 'jconnect') return ssh.openTerminal({ computerId: computer.id }, (id) => store.getComputer(id));
  const hostId = ssh.saveHost({ id: `ssh-${computer.id}`, name: computer.name, host: computer.host, port: 22, via: computer.via, source: computer.source });
  return ssh.openTerminal({ hostId }, (id) => store.getComputer(id));
}

// ---------------------------------------------------------------------------------------------
// State for the UI

let updateTimer = null;
function scheduleUpdate() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('jc:state', snapshot());
    updateTray();
  }, 80);
}

async function refreshNetworks(force = false) {
  try {
    networks = await vpn.status(force);
  } catch { /* keep the last known state */ }
  scheduleUpdate();
  return networks;
}

function computerView(c) {
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    os: c.os,
    person: c.person || null,
    via: c.via || 'auto',
    paired: c.paired !== false,
    source: c.source || null,
    host: c.host || null,
    services: c.services || null,
    canWake: !!(c.mac && c.mac.length),
    lastState: c.lastState || null,
    lastSeen: c.lastSeen || null,
    rdpHost: c.rdp ? `${c.rdp.host}:${c.rdp.port}` : null,
    status: statuses.get(c.id) || { state: 'checking' },
  };
}

function snapshot() {
  const { localInterfaces } = require('./discovery');
  const s = store.settings;
  const known = new Set(store.data.computers.map((c) => c.id));
  return {
    device: store.device(),
    settings: {
      remoteAccess: s.remoteAccess,
      requirePassword: s.requirePassword && !!s.passwordHash,
      startAtLogin: s.startAtLogin,
      travelMode: s.travelMode,
      travelOwnerOnly: s.travelOwnerOnly,
      emergencyShutdown: s.emergencyShutdown,
      quality: s.quality,
      hideFromNearby: s.hideFromNearby,
      allowBrowserClients: s.allowBrowserClients,
      accountTrust: s.accountTrust,
      jvpnEnabled: s.jvpnEnabled,
      defaultVia: s.defaultVia,
      shareSsh: s.shareSsh,
      sshPort: s.sshPort,
      shareRdp: s.shareRdp,
      autoUpdate: s.autoUpdate,
    },
    computers: store.data.computers.map(computerView),
    sshHosts: ssh.hosts().filter((h) => !h.id.startsWith('ssh-host-')),
    nearby: discovery.list().filter((p) => !known.has(p.id) && p.state === 'ready').map((p) => ({
      id: p.id, name: p.name, os: p.os, travelMode: p.travelMode, path: (p.addresses[0] || {}).kind,
    })),
    trusted: store.data.trusted.map((t) => ({
      id: t.id, name: t.name, os: t.os, owner: !!t.owner, via: t.via || null, permission: t.permission || 'control', pairedAt: t.pairedAt, lastSeen: t.lastSeen,
    })),
    sessions: host.sessionList(),
    streams: host.streamList(),
    pairingCode: host.pairingCode,
    pairingAllowed: security.pairingAllowed(),
    lockdown: store.data.lockdown,
    securityLog: store.data.securityLog.slice(0, 60),
    account: account.snapshot(),
    cloudServer: store.data.cloudServer || '',
    jvpn: relayLink.status(),
    networks,
    update: updater ? updater.snapshot() : null,
    permissions: process.platform === 'darwin' ? macPermissions() : null,
    advanced: {
      id: store.id,
      port: host.port,
      protocol: 'JConnect v2 · X25519 + XSalsa20-Poly1305 · Ed25519 identities',
      addresses: localInterfaces().map((i) => ({ address: i.address, name: i.name, tailscale: i.tailscale })),
      tailscale: discovery.tailscale,
      input: input.reason || 'available',
      resources: resources.snapshot(),
      userData: app.getPath('userData'),
    },
  };
}

function onDiscovery(peer) {
  if (peer) {
    const computer = store.getComputer(peer.id);
    if (computer && computer.publicKey === peer.publicKey && computer.lastState !== peer.state) {
      store.updateComputer(computer.id, { lastState: peer.state }, { quiet: true });
      if (peer.state === 'ready') kickStatus();
    }
  }
  scheduleUpdate();
}

let statusTimer = null;
let statusRunning = false;
async function statusLoop() {
  clearTimeout(statusTimer);
  if (!statusRunning) {
    statusRunning = true;
    try { await refreshStatuses(); } catch (err) { console.warn('[jconnect] status:', err.message); }
    statusRunning = false;
  }
  const visible = mainWin && !mainWin.isDestroyed() && mainWin.isVisible();
  statusTimer = setTimeout(statusLoop, visible ? 5000 : 30000);
}
function kickStatus() { statusLoop(); }

async function refreshStatuses() {
  const { resolveComputer, tcpProbe, pathKind } = require('./discovery');
  const unreachable = [];
  await Promise.all(store.data.computers.map(async (c) => {
    if (c.type === 'rdp') {
      const ok = await tcpProbe(c.rdp.host, c.rdp.port);
      statuses.set(c.id, { state: ok ? 'online' : 'offline' });
      return;
    }
    if (c.type === 'host') {
      const ports = [c.services && c.services.ssh ? 22 : 0, c.services && c.services.rdp ? 3389 : 0].filter(Boolean);
      const ok = (await Promise.all((ports.length ? ports : [22]).map((p) => tcpProbe(c.host, p, 1500)))).some(Boolean);
      statuses.set(c.id, { state: ok ? 'online' : 'offline', path: pathKind(c.host) });
      return;
    }
    const route = await resolveComputer(c, discovery);
    const previous = statuses.get(c.id);
    if (route) {
      statuses.set(c.id, { state: 'online', path: route.kind });
      rememberRoute(c, route);
    } else if (previous && previous.state === 'waking' && Date.now() - previous.since < 120000) {
      // keep showing "Waking…"
    } else {
      unreachable.push(c);
      const sleeping = c.lastState === 'sleeping' && c.mac && c.mac.length;
      statuses.set(c.id, { state: sleeping ? 'sleeping' : 'offline' });
    }
  }));
  if (unreachable.length && account.signedIn() && store.settings.jvpnEnabled) {
    const online = await account.presence(unreachable.map((c) => c.id)).catch(() => []);
    for (const id of online) statuses.set(id, { state: 'online', path: 'jvpn' });
  }
  scheduleUpdate();
}

function rememberRoute(computer, route) {
  const info = route.info || {};
  const known = (computer.addresses || []).find((a) => a.host === route.host && a.port === route.port);
  const patch = {};
  if (route.host && (!known || Date.now() - (known.lastOk || 0) > 60000)) patch.addresses = [{ host: route.host, port: route.port, lastOk: Date.now() }];
  // The name and OS come from the computer's own answer on the network, so they're cleaned like any outside text.
  const os = String(info.os || '').replace(/\p{Cc}/gu, '').trim().slice(0, 32);
  const name = String(info.name || '').replace(/\p{Cc}/gu, '').trim().slice(0, 64);
  if (os && os !== computer.os) patch.os = os;
  if (!computer.renamed && name && name !== computer.name) patch.name = name;
  if (computer.lastState && computer.lastState !== 'ready') patch.lastState = 'ready';
  if (Object.keys(patch).length) store.updateComputer(computer.id, { ...patch, lastSeen: Date.now() }, { quiet: true });
}

const wsUrl = (h, port) => `ws://${h.includes(':') ? `[${h}]` : h}:${port}/ws`;
const VIA_PATTERN = /^(auto|jvpn|tailscale|twingate|zerotier|wireguard|forticlient|windows)(:[\w .()-]{1,64})?$/;

// ---------------------------------------------------------------------------------------------
// IPC

function registerIpc() {
  const { deviceIdFromKey, verify } = require('./store');
  const { wakeOnLan, probe, localInterfaces } = require('./discovery');

  const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...a) => {
    if (capture.win && event.sender === capture.win.webContents) throw new Error('Not allowed');
    try {
      return await fn(event, ...a);
    } catch (err) {
      throw new Error(err.code || err.message);
    }
  });
  const text = (v, max) => String(v ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, max);
  const progressTo = (event) => (message) => { if (!event.sender.isDestroyed()) event.sender.send('jc:progress', message); };

  handle('jc:state', () => snapshot());
  handle('jc:identity', () => store.device());
  handle('jc:sign', (_e, value) => {
    const s = String(value);
    if (!s.startsWith('jconnect-v2-client:') && !s.startsWith('jconnect-sdp:')) throw new Error('Refusing to sign');
    return store.sign(s);
  });
  handle('jc:verify', (_e, value, sig, publicKey) => verify(value, sig, publicKey));
  handle('jc:derive', async (_e, secretB64, saltB64) => {
    const secret = Buffer.from(String(secretB64), 'base64');
    const salt = Buffer.from(String(saltB64), 'base64');
    if (secret.length > 1024 || salt.length !== 16) throw new Error('Invalid input');
    return Buffer.from(await require('./kdf').scrypt(secret, salt)).toString('base64');
  });
  handle('jc:computer-seen', (_e, id, { mac, services } = {}) => {
    const c = store.getComputer(id);
    if (!c) return;
    const patch = { lastSeen: Date.now(), paired: true };
    if (Array.isArray(mac) && mac.length) patch.mac = mac.filter((m) => typeof m === 'string').slice(0, 8);
    if (services && typeof services === 'object') patch.services = { ssh: !!services.ssh, rdp: !!services.rdp };
    store.updateComputer(id, patch, { quiet: true });
  });

  handle('jc:set-setting', (_e, key, value) => setSetting(key, value));
  handle('jc:update', (_e, action) => {
    if (action === 'check') return updater.check();
    if (action === 'install') return updater.install();
    if (action === 'website') return shell.openExternal(updater.downloadPage);
    throw new Error('Not allowed');
  });
  handle('jc:set-password', (_e, password) => {
    store.setPassword(password ? String(password).slice(0, 256) : null);
    store.log({ kind: 'password', level: 'info', message: password ? 'A password is now required to connect.' : 'The connection password was removed.' });
  });
  handle('jc:rotate-code', () => host.rotateCode());
  handle('jc:pairing-qr', async () => {
    const QRCode = require('qrcode');
    const ifaces = localInterfaces();
    // A phone can't reach virtual adapters (WSL, Hyper-V, Docker, virtual machines), so the real network comes first.
    const virtual = (i) => /vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware|vboxnet|virbr|^br-|^veth/i.test(i.name);
    const best = ifaces.find((i) => !i.tailscale && !virtual(i)) || ifaces.find((i) => !i.tailscale) || ifaces[0];
    const address = best ? best.address : '127.0.0.1';
    const key = store.publicKey.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `http://${address}:${host.port}/?code=${host.pairingCode}&id=${store.id}&k=${key}`;
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
    return { code: host.pairingCode, url, dataUrl };
  });
  handle('jc:lockdown-restore', () => security.restore('this computer'));
  // Terminate and Shut Down work only from the main window, not from session or terminal windows.
  const fromMainWindow = (event) => {
    if (!mainWin || mainWin.isDestroyed() || event.sender !== mainWin.webContents) throw new Error('Not allowed');
  };
  handle('jc:terminate', (event) => {
    fromMainWindow(event);
    terminateJConnect();
  });
  handle('jc:shutdown', async (event) => {
    fromMainWindow(event);
    await shutDownComputer();
  });

  handle('jc:computer-update', (_e, id, patch) => {
    const update = {};
    if (patch && typeof patch.name === 'string' && text(patch.name, 64)) { update.name = text(patch.name, 64); update.renamed = true; }
    if (patch && 'person' in patch) update.person = text(patch.person, 48) || null;
    if (patch && typeof patch.via === 'string' && VIA_PATTERN.test(patch.via)) update.via = patch.via;
    store.updateComputer(id, update);
    kickStatus();
  });
  handle('jc:computer-remove', (_e, id) => {
    store.removeComputer(id);
    statuses.delete(id);
  });
  handle('jc:connect', (_e, id) => {
    const c = store.getComputer(id);
    if (!c) return { ok: false };
    if (c.type === 'jconnect' && c.paired === false) return { needsPairing: true };
    openSession(id);
    return { ok: true };
  });
  handle('jc:open-rdp', (_e, id) => openRdp(id));
  handle('jc:open-ssh', (_e, target) => {
    if (target && target.computerId) {
      const c = store.getComputer(target.computerId);
      if (!c) throw new Error('gone');
      openSshForComputer(c);
    } else if (target && target.hostId) {
      ssh.openTerminal({ hostId: target.hostId }, (id) => store.getComputer(id));
    }
  });
  handle('jc:open-external', (_e, url) => {
    const allowed = new Set([...networks.map((n) => n.website).filter(Boolean)]);
    if (!allowed.has(url)) throw new Error('Not allowed');
    return shell.openExternal(url);
  });
  handle('jc:mac-permission', async (_e, kind) => {
    if (process.platform !== 'darwin' || !['screen', 'accessibility'].includes(kind)) throw new Error('Not allowed');
    const asked = store.data.macPermissionAsked || {};
    if (!asked[kind]) {
      // The first time, macOS shows its own prompt. After that, open the matching page in System Settings.
      store.update((d) => { d.macPermissionAsked = { ...asked, [kind]: true }; });
      if (kind === 'screen') await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
      else systemPreferences.isTrustedAccessibilityClient(true);
    } else {
      await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${kind === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility'}`);
    }
    scheduleUpdate();
    return macPermissions();
  });
  handle('jc:shortcut', async (_e, id) => {
    const computer = store.getComputer(id);
    if (!computer) throw new Error('Unknown computer');
    return require('./shortcuts').createShortcut(computer);
  });
  handle('jc:wake', async (_e, id) => {
    const c = store.getComputer(id);
    if (!c || !c.mac || !c.mac.length) return false;
    const hosts = (c.addresses || []).map((a) => a.host).filter((h) => /^\d+\.\d+\.\d+\.\d+$/.test(h));
    await wakeOnLan(c.mac, hosts);
    statuses.set(id, { state: 'waking', since: Date.now() });
    scheduleUpdate();
    return true;
  });
  handle('jc:import-rdp', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
      title: 'Import Remote Desktop file',
      filters: [{ name: 'Remote Desktop', extensions: ['rdp'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return null;
    const imported = require('./rdp').importRdpFile(filePaths[0]);
    const id = `rdp-${crypto.createHash('sha1').update(`${imported.rdp.host}:${imported.rdp.port}:${imported.rdp.username || ''}`).digest('hex').slice(0, 16)}`;
    const computer = store.upsertComputer({ id, type: 'rdp', name: imported.name, os: 'Remote Desktop', rdp: imported.rdp });
    kickStatus();
    return computerView(computer);
  });

  handle('jc:save-computer', (_e, info) => {
    if (!info || typeof info.publicKey !== 'string' || deviceIdFromKey(info.publicKey) !== info.id || info.id === store.id) {
      throw new Error('Invalid computer');
    }
    const addresses = (Array.isArray(info.addresses) ? info.addresses : [])
      .filter((a) => a && typeof a.host === 'string' && /^[\w.:[\]-]{1,255}$/.test(a.host) && Number.isInteger(a.port) && a.port > 0 && a.port < 65536)
      .map((a) => ({ host: a.host, port: a.port, lastOk: Date.now() }));
    const computer = store.upsertComputer({
      id: info.id,
      type: 'jconnect',
      name: text(info.name, 64) || 'Computer',
      os: text(info.os, 32),
      publicKey: info.publicKey,
      addresses,
      mac: Array.isArray(info.mac) ? info.mac.filter((m) => typeof m === 'string').slice(0, 8) : [],
      lastState: 'ready',
      paired: true,
    });
    statuses.set(computer.id, { state: 'online' });
    kickStatus();
    return computerView(computer);
  });
  handle('jc:peer-route', async (_e, peerId) => {
    const { resolveComputer } = require('./discovery');
    const peer = discovery.peers.get(peerId);
    if (!peer) return null;
    const route = await resolveComputer({ id: peer.id, publicKey: peer.publicKey, addresses: [] }, discovery);
    return route && { url: wsUrl(route.host, route.port), host: route.host, port: route.port, publicKey: peer.publicKey, name: route.info.name, os: route.info.os };
  });
  handle('jc:computer-route', async (event, id) => {
    const c = store.getComputer(id);
    if (!c) return null;
    const route = await router.resolveJconnect(c, { onProgress: progressTo(event) });
    return route && { url: route.url, host: route.host, port: route.port, publicKey: c.publicKey, name: c.name, os: c.os };
  });
  handle('jc:probe-address', async (_e, raw) => {
    const { DEFAULT_AGENT_PORT } = require('./discovery');
    let value = text(raw, 255).replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
    if (!value) return null;
    let hostName = value;
    let port = DEFAULT_AGENT_PORT;
    const bracket = /^\[(.+)\](?::(\d+))?$/.exec(value);
    if (bracket) { hostName = bracket[1]; port = Number(bracket[2]) || port; } else if ((value.match(/:/g) || []).length === 1) {
      [hostName, value] = value.split(':');
      port = Number(value) || port;
    }
    const hit = await probe(hostName, port, 3000);
    if (!hit || hit.info.id === store.id) return null;
    return { url: wsUrl(hostName, port), host: hostName, port, publicKey: hit.info.publicKey, name: hit.info.name, os: hit.info.os };
  });

  handle('jc:trusted-update', (_e, id, patch) => {
    const update = {};
    if (patch && typeof patch.owner === 'boolean') update.owner = patch.owner;
    if (patch && ['control', 'view'].includes(patch.permission)) update.permission = patch.permission;
    store.updateTrusted(id, update);
    host.updatePermissions(id);
  });
  handle('jc:trusted-remove', (_e, id) => host.revokeDevice(id));
  handle('jc:session-disconnect', (_e, sid) => host.disconnectSession(sid));

  // Networks (JVPN and other VPNs)
  handle('jc:networks', (_e, force) => refreshNetworks(!!force));
  handle('jc:network-action', async (event, id, action, options = {}) => {
    if (!['connect', 'disconnect', 'signIn', 'signOut'].includes(action)) throw new Error('Not allowed');
    let opts = {};
    if (id === 'wireguard' && action === 'signIn') {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
        title: 'Add a WireGuard tunnel',
        filters: [{ name: 'WireGuard tunnel', extensions: ['conf'] }],
        properties: ['openFile'],
      });
      if (canceled || !filePaths.length) return refreshNetworks(true);
      opts = { filePath: filePaths[0] };
    } else if (id === 'twingate') {
      opts = { network: text(options.network, 63), apiKey: text(options.apiKey, 512) };
    } else if (id === 'zerotier') {
      opts = { token: text(options.token, 256), networks: text(options.networks, 512) };
    }
    if (options.arg) opts.arg = text(options.arg, 64);
    await vpn.act(id, action, { ...opts, onProgress: progressTo(event) });
    if (id === 'jvpn') relayLink.refresh();
    return refreshNetworks(true);
  });
  handle('jc:network-importable', async (_e, id) => {
    const list = await vpn.importable(id);
    importCache.set(id, list);
    return list.map(({ key, name, host: h, os, online, group, services, exists }) => ({ key, name, host: h, os, online, group, services, exists }));
  });
  handle('jc:network-import', (_e, id, keys) => {
    const wanted = new Set(Array.isArray(keys) ? keys : []);
    const items = (importCache.get(id) || []).filter((item) => wanted.has(item.key));
    const added = vpn.import(id, items);
    kickStatus();
    return added.length;
  });

  // Account and sync
  handle('jc:account', async (_e, action, payload = {}) => {
    const server = text(payload.server, 255);
    const email = text(payload.email, 254);
    switch (action) {
      case 'sign-up':
        store.update((d) => { d.cloudServer = server; });
        await account.signUp({ server, email, password: String(payload.password || '') });
        break;
      case 'sign-in':
        store.update((d) => { d.cloudServer = server; });
        await account.signIn({ server, email, password: String(payload.password || ''), totp: text(payload.totp, 8) });
        break;
      case 'sign-out':
        await account.signOut();
        break;
      case 'sync':
        await account.sync();
        break;
      case 'totp-setup': {
        const setup = await account.totpSetup();
        const QRCode = require('qrcode');
        return { secret: setup.secret, qr: await QRCode.toDataURL(setup.uri, { margin: 1, width: 220 }) };
      }
      case 'totp-enable':
        await account.totpSet(true, text(payload.code, 8));
        break;
      case 'totp-disable':
        await account.totpSet(false, text(payload.code, 8));
        break;
      case 'remove-device':
        await account.removeDevice(text(payload.id, 20));
        break;
      default:
        throw new Error('Not allowed');
    }
    relayLink.refresh();
    return account.snapshot();
  });

  // SSH
  handle('jc:ssh-hosts', () => ssh.hosts());
  handle('jc:ssh-save', (_e, entry = {}) => ssh.saveHost({
    id: entry.id ? text(entry.id, 64) : undefined,
    name: text(entry.name, 64),
    host: text(entry.host, 255),
    port: Number(entry.port) || 22,
    username: text(entry.username, 64),
    via: VIA_PATTERN.test(String(entry.via || '')) ? entry.via : 'auto',
  }));
  handle('jc:ssh-remove', (_e, id) => ssh.removeHost(text(id, 64)));
  handle('jc:ssh-import-config', () => ssh.importSshConfig().length);
  handle('jc:ssh-public-key', async () => {
    await ssh.copyPublicKey();
    return ssh.publicKey();
  });

  // Session windows
  handle('jc:session-target', (_e, id) => {
    const c = store.getComputer(id);
    return c ? { id: c.id, name: c.name, os: c.os, publicKey: c.publicKey, canWake: !!(c.mac && c.mac.length) } : null;
  });
  handle('jc:resolve', async (event, id) => {
    const c = store.getComputer(id);
    if (!c) return { unreachable: true, gone: true };
    try {
      const route = await router.resolveJconnect(c, { onProgress: progressTo(event) });
      if (route) {
        statuses.set(id, { state: 'online', path: route.kind });
        if (route.host) rememberRoute(c, { host: route.host, port: route.port, kind: route.kind });
        return { url: route.url, kind: route.kind };
      }
    } catch (err) {
      return { unreachable: true, reason: err.code || 'unreachable' };
    }
    return { unreachable: true, wakeable: !!(c.mac && c.mac.length), lastState: c.lastState || null };
  });
  handle('jc:computers', () => store.data.computers.map(computerView));
  handle('jc:switch', (event, id) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !store.getComputer(id)) return;
    const other = sessionWins.get(id);
    if (other && !other.isDestroyed() && other !== win) {
      other.show();
      other.focus();
      return;
    }
    sessionWins.delete(win.jconnectComputerId);
    win.jconnectComputerId = id;
    sessionWins.set(id, win);
    win.loadFile(path.join(RENDERER, 'session', 'session.html'), { query: { id } });
  });
  handle('jc:window', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
    else if (action === 'close') win.close();
    else if (action === 'home') { win.close(); showMain(); }
  });
  handle('jc:report', (event, _id, state, info) => {
    if (selftest) selftest.report(BrowserWindow.fromWebContents(event.sender), state, info);
  });
}

function setSetting(key, value) {
  const booleans = ['remoteAccess', 'startAtLogin', 'travelMode', 'travelOwnerOnly', 'emergencyShutdown', 'hideFromNearby', 'allowBrowserClients', 'accountTrust', 'jvpnEnabled', 'shareSsh', 'shareRdp', 'autoUpdate'];
  if (key === 'deviceName') {
    const name = String(value ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, 64);
    store.setSetting('deviceName', name || null);
    discovery.announce();
    return;
  }
  if (key === 'quality') {
    if (!['auto', 'sharp', 'balanced', 'saver'].includes(value)) throw new Error('Invalid quality');
    store.setSetting('quality', value);
    return;
  }
  if (key === 'defaultVia') {
    if (!VIA_PATTERN.test(String(value)) || value === 'auto') throw new Error('Invalid network');
    store.setSetting('defaultVia', value);
    return;
  }
  if (key === 'sshPort') {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    store.setSetting('sshPort', port);
    host.applyServices();
    return;
  }
  if (!booleans.includes(key)) throw new Error(`Unknown setting ${key}`);
  store.setSetting(key, !!value);

  if (key === 'remoteAccess') {
    host.applyRemoteAccess();
    discovery.announce();
    relayLink.refresh();
  }
  if (key === 'travelMode') {
    store.log({ kind: 'travel', level: 'info', message: value ? 'Travel Mode turned on.' : 'Travel Mode turned off.' });
    host.applyTravelMode();
    resources.update();
    discovery.announce();
  }
  if (key === 'travelOwnerOnly') host.applyTravelMode();
  if (key === 'startAtLogin') applyLoginItem();
  if (key === 'autoUpdate' && updater) updater.settingsChanged();
  if (key === 'hideFromNearby') discovery.announce();
  if (key === 'jvpnEnabled') {
    relayLink.refresh();
    vpn.invalidate('jvpn');
  }
  if (key === 'shareSsh' || key === 'shareRdp') {
    host.applyServices();
    store.log({ kind: 'services', level: 'info', message: `${key === 'shareSsh' ? 'SSH' : 'Remote Desktop'} sharing through JVPN turned ${value ? 'on' : 'off'}.` });
  }
}

// ---------------------------------------------------------------------------------------------
// System integration

async function askOwner(key) {
  const parent = showMain();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const { response, checkboxChecked } = await dialog.showMessageBox(parent, {
      type: 'question',
      title: 'JConnect',
      message: `Allow ${key.name} to use this computer?`,
      detail: [
        key.account ? `${key.name} is signed in to your JConnect account.` : (key.os ? `${key.os}.` : ''),
        key.sas ? `Make sure ${key.name} shows the code ${key.sas.slice(0, 3)} ${key.sas.slice(3)}. If it doesn't, press Cancel.` : '',
        'Only allow devices you recognize. You can remove access at any time.',
      ].filter(Boolean).join('\n\n'),
      buttons: ['Cancel', 'Allow'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      checkboxLabel: 'This is one of my own devices',
      signal: controller.signal,
    });
    return { allow: response === 1, owner: checkboxChecked };
  } catch {
    return { allow: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function showLockdownDialog(entry) {
  const win = showMain();
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'JConnect Emergency Lockdown',
    message: 'JConnect Emergency Lockdown',
    detail: `Suspicious activity was detected on ${store.device().name}.\n${entry.message}\n\nRemote access has been temporarily disabled.`,
    buttons: ['Keep Locked', 'Review'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response === 1) win.webContents.send('jc:navigate', 'security');
}

function emergencyShutdown() {
  if (shutdownScheduled) return;
  shutdownScheduled = true;
  store.log({ kind: 'emergency-shutdown', level: 'high', message: 'JConnect shut down the computer according to your Travel Mode security policy.' });
  store.saveNow();
  host.noticeAll('host-shutdown', { reason: 'security' });
  discovery.announce('security-shutdown');
  notify('JConnect Emergency Lockdown', 'This computer will shut down in 60 seconds according to your Travel Mode security policy.');
  setTimeout(() => {
    powerOff().catch((err) => {
      console.warn('[jconnect] shutdown failed:', err.message);
      shutdownScheduled = false;
    });
  }, 60000);
}

// Turns the computer off the system's normal way, as if Shut Down had been chosen from its own menu.
function powerOff() {
  const command = process.platform === 'win32'
    ? 'shutdown /s /t 0'
    : process.platform === 'darwin'
      ? 'osascript -e \'tell app "System Events" to shut down\''
      : 'systemctl poweroff';
  return new Promise((resolve, reject) => exec(command, (err) => (err ? reject(err) : resolve())));
}

const TERMINATE_DETAIL = 'Every connection and task ends, and remote access, JVPN, syncing and JConnect’s other background services stop. JConnect starts again when you open it, or when you sign in if “Start with this computer” is on.';
const SHUT_DOWN_DETAIL = 'Devices connected to this computer are disconnected, and the computer turns off. Save your work in other apps first.';
let stopping = false;

// The manual stop switch. Connected devices are told their session ended, then JConnect quits, which stops its
// background services (remote access, discovery, JVPN, sync, input and screen capture) and closes all its windows.
function terminateJConnect() {
  if (stopping) return;
  stopping = true;
  store.log({ kind: 'terminated', level: 'info', message: 'JConnect was terminated on this computer.' });
  host.endAll('ended-by-owner');
  // Give the notices a moment to reach the devices. If something holds up quitting, exit anyway.
  setTimeout(() => {
    quitting = true;
    app.quit();
    setTimeout(() => app.exit(0), 5000);
  }, 300);
}

// ---------------------------------------------------------------------------------------------
// Updates (src/main/updater.js)

// Nobody would notice JConnect restarting: no device is connected to this computer, no JConnect window is open on
// another computer or SSH host, and the JConnect window isn't being used.
function updateIsIdle() {
  const inUse = mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && mainWin.isFocused();
  return host.sessions.size === 0 && host.streamList().length === 0 && sessionWins.size === 0 && ssh.sessions.size === 0 && !inUse;
}

// Just before the installer takes over: connected devices hear that JConnect is updating, and everything is saved.
async function prepareForUpdate(version) {
  const hidden = !(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
  store.log({ kind: 'update', level: 'info', message: `JConnect is updating to ${version}.` });
  host.noticeAll('host-updating');
  store.saveNow();
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { hidden };
}

function openUpdates() {
  const win = showMain();
  const open = () => win.webContents.send('jc:navigate', 'updates');
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(open, 300));
  else open();
}

function checkForUpdatesNow() {
  openUpdates();
  if (updater) updater.check().catch(() => {});
}

function updateMenuItem() {
  const u = updater ? updater.snapshot() : null;
  if (u && u.state === 'ready') return { label: `Restart to Update to ${u.available.version}`, click: openUpdates };
  return { label: 'Check for Updates…', click: checkForUpdatesNow };
}

// The Shut Down button: connected devices hear that the computer is turning off, then it shuts down right away.
async function shutDownComputer() {
  store.log({ kind: 'power-off', level: 'info', message: 'This computer was shut down from JConnect.' });
  store.saveNow();
  host.noticeAll('host-shutdown');
  try {
    await powerOff();
  } catch (err) {
    console.warn('[jconnect] shutdown failed:', err.message);
    throw Object.assign(new Error('shutdown-failed'), { code: 'shutdown-failed' });
  }
}

// Terminate and Shut Down from the tray menu, with the same questions the window asks.
async function confirmStop(action) {
  const shutDown = action === 'shutdown';
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'JConnect',
    message: shutDown ? 'Shut down this computer?' : 'Terminate JConnect?',
    detail: shutDown ? SHUT_DOWN_DETAIL : TERMINATE_DETAIL,
    buttons: ['Cancel', shutDown ? 'Shut Down' : 'Terminate'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response !== 1) return;
  if (!shutDown) terminateJConnect();
  else shutDownComputer().catch(() => dialog.showErrorBox('JConnect', 'This computer couldn’t be shut down. Use the system’s own Shut Down instead.'));
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

function applyLoginItem() {
  // Named profiles are for trying things out side by side; never register those at login.
  if (!app.isPackaged || args.profile) return;
  if (process.platform === 'linux') setLinuxAutostart(!!store.settings.startAtLogin);
  else app.setLoginItemSettings({ openAtLogin: !!store.settings.startAtLogin, args: ['--hidden'] });
}

// Linux desktops start the apps listed in ~/.config/autostart when someone signs in.
function setLinuxAutostart(enabled) {
  const fs = require('fs');
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config'), 'autostart');
  const file = path.join(dir, 'jconnect.desktop');
  try {
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return;
    }
    // An AppImage runs from a temporary folder, so start the AppImage file itself.
    const exe = (process.env.APPIMAGE || process.execPath).replace(/(["`$\\])/g, '\\$1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=JConnect\nExec="${exe}" --hidden\nIcon=jconnect\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
  } catch (err) {
    console.warn('[jconnect] start at login:', err.message);
  }
}

// macOS ignores login item arguments, so ask it whether this launch came from logging in.
function openedAtLogin() {
  return process.platform === 'darwin' && app.isPackaged && !!app.getLoginItemSettings().wasOpenedAtLogin;
}

function macPermissions() {
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

// macOS keeps a menu bar. While a remote session has focus its menus have no keyboard shortcuts,
// so ⌘Q, ⌘W, ⌘C and the rest go to the remote computer instead.
let menuMode = null;
function applyMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const focused = BrowserWindow.getFocusedWindow();
  const mode = focused && focused.jconnectComputerId !== undefined ? 'session' : 'app';
  if (mode === menuMode) return;
  menuMode = mode;
  const key = (accelerator) => (mode === 'app' ? accelerator : undefined);
  const withFocused = (fn) => () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) fn(win);
  };
  const openSettingsWindow = () => {
    const win = showMain();
    const open = () => win.webContents.send('jc:navigate', 'this');
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(open, 300));
    else open();
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: () => app.showAboutPanel() },
        { label: 'Check for Updates…', click: checkForUpdatesNow },
        { type: 'separator' },
        { label: 'Settings…', accelerator: key('Command+,'), click: openSettingsWindow },
        { type: 'separator' },
        { label: `Hide ${app.name}`, accelerator: key('Command+H'), click: () => app.hide() },
        { type: 'separator' },
        { label: `Quit ${app.name}`, accelerator: key('Command+Q'), click: () => { quitting = true; app.quit(); } },
      ],
    },
    mode === 'app' && { role: 'editMenu' },
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', accelerator: key('Command+M'), click: withFocused((win) => win.minimize()) },
        { label: 'Close', accelerator: key('Command+W'), click: withFocused((win) => win.close()) },
        { type: 'separator' },
        { label: 'Open JConnect', click: () => showMain() },
      ],
    },
  ].filter(Boolean)));
}

function createTray() {
  // macOS tints the black "Template" image to suit light and dark menu bars.
  const image = nativeImage.createFromPath(path.join(ASSETS, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.on('click', () => showMain());
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const s = store.settings;
  const count = host.sessions.size;
  let status = 'Ready';
  if (security.lockdown) status = 'Emergency Lockdown';
  else if (!s.remoteAccess) status = 'Remote access is off';
  else if (count) status = `${count} connected`;
  else if (s.travelMode) status = 'Travel Mode';
  const jvpnState = relayLink ? relayLink.status().state : 'off';
  tray.setToolTip(`JConnect — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${store.device().name} · ${status}`, enabled: false },
    { label: `JVPN · ${jvpnState === 'online' ? 'Connected' : s.jvpnEnabled ? 'On' : 'Off'}`, enabled: false },
    { type: 'separator' },
    { label: 'Open JConnect', click: () => showMain() },
    { label: 'Remote access', type: 'checkbox', checked: !!s.remoteAccess, click: (item) => setSetting('remoteAccess', item.checked) },
    { label: 'JVPN', type: 'checkbox', checked: !!s.jvpnEnabled, click: (item) => setSetting('jvpnEnabled', item.checked) },
    { label: 'Travel Mode', type: 'checkbox', checked: !!s.travelMode, click: (item) => setSetting('travelMode', item.checked) },
    { type: 'separator' },
    updateMenuItem(),
    { type: 'separator' },
    { label: 'Terminate JConnect…', click: () => confirmStop('terminate') },
    { label: 'Shut Down Computer…', click: () => confirmStop('shutdown') },
  ]));
}
