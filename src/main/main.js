const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, nativeTheme, powerMonitor, Notification,
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

const ROOT = path.join(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(ASSETS, 'icon.png');

let store; let security; let input; let capture; let host; let discovery; let resources; let selftest;
let mainWin = null;
let tray = null;
let quitting = false;
let shutdownScheduled = false;
const sessionWins = new Map();
const statuses = new Map();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const a = parseArgs(argv);
    if (a.connect) openSession(a.connect);
    else showMain();
  });
  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox('JConnect could not start', err.stack || err.message);
    app.exit(1);
  });
}

async function boot() {
  const { Store, deviceIdFromKey, verify } = require('./store');
  const { Security } = require('./security');
  const { InputController } = require('./input');
  const { CaptureBridge } = require('./capture-bridge');
  const { HostAgent } = require('./host');
  const { Discovery, DEFAULT_AGENT_PORT } = require('./discovery');
  const { ResourceMonitor } = require('./resources');

  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  store = new Store();
  security = new Security(store);
  input = new InputController();
  input.init();
  capture = new CaptureBridge();
  host = new HostAgent({ store, security, input, capture });
  host.askOwner = askOwner;
  await host.listen(Number(args.port) || DEFAULT_AGENT_PORT);

  discovery = new Discovery({
    selfId: store.id,
    getAnnouncement: () => {
      if (!store.settings.remoteAccess) return null;
      const i = host.info();
      return { id: i.id, name: i.name, os: i.os, publicKey: i.publicKey, port: i.port, travelMode: i.travelMode, lockdown: i.lockdown, mac: i.mac };
    },
    isTravelMode: () => security.travelMode,
  });
  discovery.start();

  resources = new ResourceMonitor(() => security.travelMode);
  resources.on('change', (level) => host.setResourceCap(level));
  resources.start();

  store.on('change', scheduleUpdate);
  host.on('change', scheduleUpdate);
  if (!app.isPackaged) host.on('code', (code) => console.log(`[jconnect] pairing code ${code}`));
  discovery.on('update', onDiscovery);

  security.on('lockdown', (entry) => {
    host.lockdownNow(entry);
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
  powerMonitor.on('resume', () => discovery.announce('ready'));
  powerMonitor.on('shutdown', () => host.noticeAll('host-shutdown'));

  registerIpc({ deviceIdFromKey, verify });
  createTray();
  applyLoginItem();

  if (!args.hidden) showMain();
  if (args.connect) openSession(args.connect);
  statusLoop();

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
  if (input) input.close();
});
app.on('window-all-closed', () => { /* JConnect stays ready in the background */ });
app.on('activate', () => showMain());
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (!app.isPackaged) {
    contents.on('console-message', (e, level, message, line, source) => {
      const text = e && e.message !== undefined ? e.message : message;
      const where = e && e.sourceId !== undefined ? `${e.sourceId}:${e.lineNumber}` : `${source}:${line}`;
      console.log(`[renderer] ${String(where).split('/').pop()} ${text}`);
    });
  }
  contents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
});

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
    width: 440,
    height: 700,
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
  mainWin.on('show', () => kickStatus());
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
    try {
      require('./rdp').launchRdp(computer, path.join(app.getPath('userData'), 'rdp'));
    } catch (err) {
      dialog.showMessageBox(showMain(), { type: 'info', message: `${computer.name} couldn't be opened.`, detail: err.message });
    }
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

function computerView(c) {
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    os: c.os,
    person: c.person || null,
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
    },
    computers: store.data.computers.map(computerView),
    nearby: discovery.list().filter((p) => !known.has(p.id) && p.state === 'ready').map((p) => ({
      id: p.id, name: p.name, os: p.os, travelMode: p.travelMode, path: (p.addresses[0] || {}).kind,
    })),
    trusted: store.data.trusted.map((t) => ({
      id: t.id, name: t.name, os: t.os, owner: !!t.owner, permission: t.permission || 'control', pairedAt: t.pairedAt, lastSeen: t.lastSeen,
    })),
    sessions: host.sessionList(),
    pairingCode: host.pairingCode,
    pairingAllowed: security.pairingAllowed(),
    lockdown: store.data.lockdown,
    securityLog: store.data.securityLog.slice(0, 60),
    advanced: {
      id: store.id,
      port: host.port,
      addresses: localInterfaces().map((i) => ({ address: i.address, name: i.name, tailscale: i.tailscale })),
      tailscale: discovery.tailscale,
      input: input.available ? 'available' : input.unavailableReason,
      resources: resources.snapshot(),
      userData: app.getPath('userData'),
    },
  };
}

function onDiscovery(peer) {
  if (peer) {
    const computer = store.getComputer(peer.id);
    if (computer && computer.publicKey === peer.publicKey && computer.lastState !== peer.state) {
      store.updateComputer(computer.id, { lastState: peer.state });
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
  const { resolveComputer, tcpProbe } = require('./discovery');
  await Promise.all(store.data.computers.map(async (c) => {
    if (c.type === 'rdp') {
      const ok = await tcpProbe(c.rdp.host, c.rdp.port);
      statuses.set(c.id, { state: ok ? 'online' : 'offline' });
      return;
    }
    const route = await resolveComputer(c, discovery);
    const previous = statuses.get(c.id);
    if (route) {
      statuses.set(c.id, { state: route.info.lockdown ? 'lockdown' : 'online', path: route.kind, travelMode: route.info.travelMode });
      rememberRoute(c, route);
    } else if (previous && previous.state === 'waking' && Date.now() - previous.since < 120000) {
      // keep showing "Waking…"
    } else {
      const sleeping = c.lastState === 'sleeping' && c.mac && c.mac.length;
      statuses.set(c.id, { state: sleeping ? 'sleeping' : 'offline' });
    }
  }));
  scheduleUpdate();
}

function rememberRoute(computer, route) {
  const known = (computer.addresses || []).find((a) => a.host === route.host && a.port === route.port);
  const patch = {};
  if (!known || Date.now() - (known.lastOk || 0) > 60000) patch.addresses = [{ host: route.host, port: route.port, lastOk: Date.now() }];
  if (route.info.os && route.info.os !== computer.os) patch.os = route.info.os;
  if (!computer.renamed && route.info.name && route.info.name !== computer.name) patch.name = route.info.name;
  if (route.info.mac && route.info.mac.length && JSON.stringify(route.info.mac) !== JSON.stringify(computer.mac)) patch.mac = route.info.mac;
  if (computer.lastState && computer.lastState !== 'ready') patch.lastState = 'ready';
  if (Object.keys(patch).length) store.updateComputer(computer.id, { ...patch, lastSeen: Date.now() });
}

const wsUrl = (host, port) => `ws://${host.includes(':') ? `[${host}]` : host}:${port}/ws`;

// ---------------------------------------------------------------------------------------------
// IPC

function registerIpc({ deviceIdFromKey, verify }) {
  const { resolveComputer, wakeOnLan, probe, localInterfaces } = require('./discovery');

  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...a) => {
    if (capture.win && event.sender === capture.win.webContents) throw new Error('Not allowed');
    return fn(event, ...a);
  });
  const text = (v, max) => String(v ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, max);

  handle('jc:state', () => snapshot());
  handle('jc:identity', () => store.device());
  handle('jc:sign', (_e, value) => {
    const s = String(value);
    if (!s.startsWith('jconnect-auth:') && !s.startsWith('jconnect-sdp:')) throw new Error('Refusing to sign');
    return store.sign(s);
  });
  handle('jc:verify', (_e, value, sig, publicKey) => verify(value, sig, publicKey));

  handle('jc:set-setting', (_e, key, value) => setSetting(key, value));
  handle('jc:set-password', (_e, password) => {
    store.setPassword(password ? String(password).slice(0, 256) : null);
    store.log({ kind: 'password', level: 'info', message: password ? 'A password is now required to connect.' : 'The connection password was removed.' });
  });
  handle('jc:rotate-code', () => host.rotateCode());
  handle('jc:pairing-qr', async () => {
    const QRCode = require('qrcode');
    const ifaces = localInterfaces();
    const best = ifaces.find((i) => !i.tailscale) || ifaces[0];
    const address = best ? best.address : '127.0.0.1';
    const key = store.publicKey.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `http://${address}:${host.port}/?code=${host.pairingCode}&id=${store.id}&k=${key}`;
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
    return { code: host.pairingCode, url, dataUrl };
  });
  handle('jc:lockdown-restore', () => security.restore('this computer'));

  handle('jc:computer-update', (_e, id, patch) => {
    const update = {};
    if (patch && typeof patch.name === 'string' && text(patch.name, 64)) { update.name = text(patch.name, 64); update.renamed = true; }
    if (patch && 'person' in patch) update.person = text(patch.person, 48) || null;
    store.updateComputer(id, update);
  });
  handle('jc:computer-remove', (_e, id) => {
    store.removeComputer(id);
    statuses.delete(id);
  });
  handle('jc:connect', (_e, id) => { openSession(id); });
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
      .filter((a) => a && typeof a.host === 'string' && Number.isInteger(a.port))
      .map((a) => ({ host: a.host.slice(0, 255), port: a.port, lastOk: Date.now() }));
    const computer = store.upsertComputer({
      id: info.id,
      type: 'jconnect',
      name: text(info.name, 64) || 'Computer',
      os: text(info.os, 32),
      publicKey: info.publicKey,
      addresses,
      mac: Array.isArray(info.mac) ? info.mac.filter((m) => typeof m === 'string').slice(0, 8) : [],
      lastState: 'ready',
    });
    statuses.set(computer.id, { state: 'online' });
    kickStatus();
    return computerView(computer);
  });
  handle('jc:peer-route', async (_e, peerId) => {
    const peer = discovery.peers.get(peerId);
    if (!peer) return null;
    const route = await resolveComputer({ id: peer.id, publicKey: peer.publicKey, addresses: [] }, discovery);
    return route && { url: wsUrl(route.host, route.port), host: route.host, port: route.port, publicKey: peer.publicKey, name: route.info.name, os: route.info.os };
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

  // Session windows
  handle('jc:session-target', (_e, id) => {
    const c = store.getComputer(id);
    return c ? { id: c.id, name: c.name, os: c.os, publicKey: c.publicKey, canWake: !!(c.mac && c.mac.length) } : null;
  });
  handle('jc:resolve', async (_e, id) => {
    const c = store.getComputer(id);
    if (!c) return { unreachable: true, gone: true };
    const route = await resolveComputer(c, discovery);
    if (route) {
      statuses.set(id, { state: route.info.lockdown ? 'lockdown' : 'online', path: route.kind, travelMode: route.info.travelMode });
      rememberRoute(c, route);
      return { url: wsUrl(route.host, route.port), kind: route.kind };
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
  const booleans = ['remoteAccess', 'startAtLogin', 'travelMode', 'travelOwnerOnly', 'emergencyShutdown'];
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
  if (!booleans.includes(key)) throw new Error(`Unknown setting ${key}`);
  store.setSetting(key, !!value);

  if (key === 'remoteAccess') {
    host.applyRemoteAccess();
    discovery.announce();
  }
  if (key === 'travelMode') {
    store.log({ kind: 'travel', level: 'info', message: value ? 'Travel Mode turned on.' : 'Travel Mode turned off.' });
    host.applyTravelMode();
    resources.update();
    discovery.announce();
  }
  if (key === 'travelOwnerOnly') host.applyTravelMode();
  if (key === 'startAtLogin') applyLoginItem();
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
      detail: `${key.os ? `${key.os}. ` : ''}Only allow devices you recognize. You can remove access at any time.`,
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
    const command = process.platform === 'win32'
      ? 'shutdown /s /t 0'
      : process.platform === 'darwin'
        ? 'osascript -e \'tell app "System Events" to shut down\''
        : 'systemctl poweroff';
    exec(command, (err) => {
      if (err) {
        console.warn('[jconnect] shutdown failed:', err.message);
        shutdownScheduled = false;
      }
    });
  }, 60000);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

function applyLoginItem() {
  // Named profiles are for trying things out side by side; never register those at login.
  if (!app.isPackaged || process.platform === 'linux' || args.profile) return;
  app.setLoginItemSettings({ openAtLogin: !!store.settings.startAtLogin, args: ['--hidden'] });
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
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
  tray.setToolTip(`JConnect — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${store.device().name} · ${status}`, enabled: false },
    { type: 'separator' },
    { label: 'Open JConnect', click: () => showMain() },
    { label: 'Remote access', type: 'checkbox', checked: !!s.remoteAccess, click: (item) => setSetting('remoteAccess', item.checked) },
    { label: 'Travel Mode', type: 'checkbox', checked: !!s.travelMode, click: (item) => setSetting('travelMode', item.checked) },
    { type: 'separator' },
    { label: 'Quit JConnect', click: () => { quitting = true; app.quit(); } },
  ]));
}
