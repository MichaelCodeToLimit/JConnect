const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { app } = require('electron');
const { LINUX_KEYS } = require('./keymap');

// The helper is built from native/linux-input.c. Packaged builds carry it next to the JConnect executable.
function helperPath() {
  const file = app.isPackaged
    ? path.join(path.dirname(process.execPath), 'jconnect-input')
    : path.join(__dirname, '..', '..', '..', 'build', 'native', 'jconnect-input');
  return fs.existsSync(file) ? file : null;
}

// A long-lived helper process that turns simple text commands into X11 XTEST events.
function create() {
  // Wayland doesn't let one app move the pointer or type into other apps, so XTEST events never reach them.
  if (process.env.XDG_SESSION_TYPE === 'wayland') {
    throw new Error('Remote control needs an X11 session. Sign out, then choose an X11 or "on Xorg" session when you sign in.');
  }
  const bin = helperPath();
  if (!bin) throw new Error('The Linux input helper is missing. Run `npm run linux-helper`, then start JConnect again.');
  let proc = null;
  let restartAt = 0;
  // null until the helper answers, then "ready" or the reason it can't send events.
  let status = null;

  const stopped = (child) => {
    if (proc !== child) return;
    proc = null;
    restartAt = Date.now() + 2000;
  };

  const ensure = () => {
    if (proc || Date.now() < restartAt) return proc;
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      status = line === 'ready' ? 'ready' : line.replace(/^error\s*/, '') || 'The input helper stopped.';
      if (status !== 'ready') console.warn('[jconnect] input helper:', status);
    });
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
    name: 'linux',
    permitted: () => status === null || status === 'ready',
    reason: () => status,
    move: (pt) => send(`M ${Math.round(pt.x)} ${Math.round(pt.y)}`),
    button: (b, down) => send(`B ${b | 0} ${down ? 1 : 0}`),
    wheel: (dx, dy) => send(`W ${Math.round(dx)} ${Math.round(dy)}`),
    key: (code, down) => {
      const k = LINUX_KEYS[code];
      if (k !== undefined) send(`K ${k} ${down ? 1 : 0}`);
    },
    text: (s) => { for (const ch of s) send(`T ${ch.codePointAt(0)}`); },
    close: () => { if (proc) proc.kill(); },
  };
}

module.exports = { create };
