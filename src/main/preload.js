const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'jc:state', 'jc:identity', 'jc:sign', 'jc:verify', 'jc:derive', 'jc:computer-seen',
  'jc:set-setting', 'jc:set-password', 'jc:rotate-code', 'jc:pairing-qr', 'jc:lockdown-restore',
  'jc:computer-update', 'jc:computer-remove', 'jc:connect', 'jc:shortcut', 'jc:wake', 'jc:import-rdp',
  'jc:save-computer', 'jc:peer-route', 'jc:probe-address', 'jc:computer-route',
  'jc:trusted-update', 'jc:trusted-remove', 'jc:session-disconnect',
  'jc:session-target', 'jc:resolve', 'jc:computers', 'jc:switch', 'jc:window', 'jc:report',
  'jc:open-rdp', 'jc:open-ssh', 'jc:open-external',
  'jc:networks', 'jc:network-action', 'jc:network-importable', 'jc:network-import',
  'jc:account',
  'jc:ssh-hosts', 'jc:ssh-save', 'jc:ssh-remove', 'jc:ssh-import-config', 'jc:ssh-public-key',
  'jc:mac-permission',
]);
const EVENTS = new Set(['jc:state', 'jc:navigate', 'jc:progress', 'ssh:event']);
const SEND = new Set(['ssh:input', 'ssh:resize', 'ssh:answer', 'ssh:start', 'ssh:disconnect']);

contextBridge.exposeInMainWorld('jconnect', {
  platform: process.platform,
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, data) {
    if (SEND.has(channel)) ipcRenderer.send(channel, data);
  },
  on(channel, fn) {
    if (!EVENTS.has(channel)) return () => {};
    const listener = (_event, ...args) => fn(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
