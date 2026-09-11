const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, systemPreferences } = require('electron');
const { MAC_KEYS } = require('./keymap');

// The helper is built from native/mac-input.swift. Packaged builds carry it next to the JConnect executable.
function helperPath() {
  const file = app.isPackaged
    ? path.join(path.dirname(process.execPath), 'jconnect-input')
    : path.join(app.getAppPath(), 'build', 'native', 'jconnect-input');
  return fs.existsSync(file) ? file : null;
}

// A long-lived helper process that turns simple text commands into CoreGraphics events.
function create() {
  const bin = helperPath();
  if (!bin) throw new Error('The macOS input helper is missing. Run `npm run mac-helper`, then start JConnect again.');
  let proc = null;
  let restartAt = 0;
  let permitted = systemPreferences.isTrustedAccessibilityClient(false);

  const stopped = (child) => {
    if (proc !== child) return;
    proc = null;
    restartAt = Date.now() + 2000;
  };

  const ensure = () => {
    if (proc || Date.now() < restartAt) return proc;
    const child = spawn(bin, [], { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => console.warn('[jconnect] input helper:', d.toString().trim()));
    child.on('error', (err) => {
      console.warn('[jconnect] input helper:', err.message);
      stopped(child);
    });
    child.on('exit', () => stopped(child));
    child.stdin.on('error', () => {});
    proc = child;
    return proc;
  };

  const send = (line) => {
    const p = ensure();
    if (p && p.stdin.writable) p.stdin.write(`${line}\n`);
  };

  ensure();

  return {
    name: 'mac',
    // macOS only delivers the helper's events once JConnect is allowed under Accessibility.
    permitted() {
      const now = systemPreferences.isTrustedAccessibilityClient(false);
      if (now && !permitted && proc) {
        // Start the helper again so it runs with the permission that was just granted.
        const old = proc;
        proc = null;
        restartAt = 0;
        old.kill();
        ensure();
      }
      permitted = now;
      return now;
    },
    move: (pt) => send(`M ${Math.round(pt.x)} ${Math.round(pt.y)}`),
    button: (b, down) => send(`B ${b | 0} ${down ? 1 : 0}`),
    wheel: (dx, dy) => send(`W ${Math.round(dx)} ${Math.round(dy)}`),
    key: (code, down) => {
      const k = MAC_KEYS[code];
      if (k !== undefined) send(`K ${k} ${down ? 1 : 0}`);
    },
    text: (s) => { for (const ch of s) send(`T ${ch.codePointAt(0)}`); },
    close: () => { if (proc) proc.kill(); },
  };
}

module.exports = { create };
