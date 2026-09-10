const { contextBridge, ipcRenderer } = require('electron');

const IN = new Set(['start', 'signal', 'display', 'quality', 'stop']);
const OUT = new Set(['ready', 'offer', 'ice', 'input', 'ended', 'error']);

contextBridge.exposeInMainWorld('capture', {
  on(name, fn) {
    if (IN.has(name)) ipcRenderer.on(`capture:${name}`, (_event, data) => fn(data));
  },
  send(name, data) {
    if (OUT.has(name)) ipcRenderer.send(`capture:${name}`, data);
  },
});
