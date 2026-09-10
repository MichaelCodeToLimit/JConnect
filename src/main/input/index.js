const { screen } = require('electron');

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const clampWheel = (v) => Math.max(-2400, Math.min(2400, Number(v) || 0));

class InputController {
  constructor() {
    this.backend = null;
    this.pressed = new Map();
    this.unavailableReason = null;
  }

  init() {
    try {
      this.backend = process.platform === 'win32' ? require('./windows').create() : require('./nut').create();
    } catch (err) {
      this.backend = null;
      this.unavailableReason = process.platform === 'win32'
        ? err.message
        : 'Remote control needs the optional @nut-tree-fork/nut-js package on this computer.';
      console.warn('[jconnect] input unavailable:', err.message);
    }
  }

  get available() { return !!this.backend; }

  _state(sid) {
    if (!this.pressed.has(sid)) this.pressed.set(sid, { keys: new Set(), buttons: new Set() });
    return this.pressed.get(sid);
  }

  _point(displayId, nx, ny) {
    const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
    const b = display.bounds;
    const dip = { x: Math.round(b.x + clamp01(nx) * (b.width - 1)), y: Math.round(b.y + clamp01(ny) * (b.height - 1)) };
    return process.platform === 'win32' ? screen.dipToScreenPoint(dip) : dip;
  }

  handle(sid, msg, displayId) {
    if (!this.backend || !msg || typeof msg !== 'object') return;
    const st = this._state(sid);
    switch (msg.t) {
      case 'm':
        this.backend.move(this._point(displayId, msg.x, msg.y));
        break;
      case 'b': {
        const b = Number(msg.b);
        if (!(b >= 0 && b <= 4)) return;
        if (msg.x != null) this.backend.move(this._point(displayId, msg.x, msg.y));
        if (msg.d) st.buttons.add(b); else st.buttons.delete(b);
        this.backend.button(b, !!msg.d);
        break;
      }
      case 'w':
        this.backend.wheel(clampWheel(msg.dx), clampWheel(msg.dy));
        break;
      case 'k':
        if (typeof msg.c !== 'string') return;
        if (msg.d) st.keys.add(msg.c); else st.keys.delete(msg.c);
        this.backend.key(msg.c, !!msg.d);
        break;
      case 'x':
        if (typeof msg.s === 'string') this.backend.text(msg.s.slice(0, 2000));
        break;
      default:
    }
  }

  // Never leave keys or buttons stuck down when a session ends.
  release(sid) {
    const st = this.pressed.get(sid);
    if (!st || !this.backend) return;
    for (const code of st.keys) this.backend.key(code, false);
    for (const b of st.buttons) this.backend.button(b, false);
    this.pressed.delete(sid);
  }

  close() { if (this.backend) this.backend.close(); }
}

module.exports = { InputController };
