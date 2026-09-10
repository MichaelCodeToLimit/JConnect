const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');

// Screen capture and WebRTC run in a hidden renderer; this bridges it to the host agent.
class CaptureBridge extends EventEmitter {
  constructor() {
    super();
    this.win = null;
    this.ready = null;
    this.active = new Set();
    const fromCapture = (fn) => (event, data) => {
      if (this.win && !this.win.isDestroyed() && event.sender === this.win.webContents && data) fn(data);
    };
    ipcMain.on('capture:ready', fromCapture(() => this._resolveReady && this._resolveReady()));
    ipcMain.on('capture:offer', fromCapture((d) => this.emit('offer', d.sid, String(d.sdp))));
    ipcMain.on('capture:ice', fromCapture((d) => this.emit('ice', d.sid, d.candidate)));
    ipcMain.on('capture:input', fromCapture((d) => this.emit('input', d.sid, String(d.data))));
    ipcMain.on('capture:ended', fromCapture((d) => this.emit('ended', d.sid, d.reason)));
    ipcMain.on('capture:error', fromCapture((d) => console.warn('[jconnect] capture:', d.message)));
  }

  displays() {
    const primary = screen.getPrimaryDisplay();
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      name: d.label || `Display ${i + 1}`,
      primary: d.id === primary.id,
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor),
    }));
  }

  _ensureWindow() {
    clearTimeout(this._idleTimer);
    if (this.win && !this.win.isDestroyed()) return this.ready;
    this.ready = new Promise((resolve) => { this._resolveReady = resolve; });
    this.win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload-capture.js'),
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'capture', 'capture.html'));
    this.win.on('closed', () => {
      this.win = null;
      for (const sid of this.active) this.emit('ended', sid, 'closed');
      this.active.clear();
    });
    return this.ready;
  }

  async _source(displayId) {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    return sources.find((s) => s.display_id === String(displayId)) || sources[0];
  }

  _display(displayId) {
    const all = this.displays();
    return all.find((d) => d.id === String(displayId)) || all[0];
  }

  _send(channel, data) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, data);
  }

  async start(sid, { displayId, quality, iceServers = [] }) {
    await this._ensureWindow();
    const source = await this._source(displayId);
    if (!source) throw new Error('No screen is available to share.');
    const display = this._display(displayId);
    this.active.add(sid);
    this._send('capture:start', {
      sid,
      sourceId: source.id,
      width: display.width,
      height: display.height,
      quality,
      iceServers,
      audio: process.platform === 'win32',
    });
  }

  signal(sid, data) {
    if (this.active.has(sid)) this._send('capture:signal', { sid, ...data });
  }

  async setDisplay(sid, displayId) {
    if (!this.active.has(sid)) return;
    const source = await this._source(displayId);
    const display = this._display(displayId);
    if (source) this._send('capture:display', { sid, sourceId: source.id, width: display.width, height: display.height });
  }

  setQuality(sid, quality) {
    if (this.active.has(sid)) this._send('capture:quality', { sid, quality });
  }

  stop(sid) {
    if (!this.active.delete(sid)) return;
    this._send('capture:stop', { sid });
    if (this.active.size === 0) {
      // Nobody is watching: release the capture pipeline entirely after a short grace period.
      this._idleTimer = setTimeout(() => {
        if (this.active.size === 0 && this.win && !this.win.isDestroyed()) this.win.destroy();
      }, 30000);
    }
  }
}

module.exports = { CaptureBridge };
