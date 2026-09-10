const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'jc:state', 'jc:identity', 'jc:sign', 'jc:verify',
  'jc:set-setting', 'jc:set-password', 'jc:rotate-code', 'jc:pairing-qr', 'jc:lockdown-restore',
  'jc:computer-update', 'jc:computer-remove', 'jc:connect', 'jc:shortcut', 'jc:wake', 'jc:import-rdp',
  'jc:save-computer', 'jc:peer-route', 'jc:probe-address',
  'jc:trusted-update', 'jc:trusted-remove', 'jc:session-disconnect',
  'jc:session-target', 'jc:resolve', 'jc:computers', 'jc:switch', 'jc:window', 'jc:report',
]);
const EVENTS = new Set(['jc:state', 'jc:navigate']);

contextBridge.exposeInMainWorld('jconnect', {
  platform: process.platform,
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, fn) {
    if (!EVENTS.has(channel)) return () => {};
    const listener = (_event, ...args) => fn(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
