const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { VK } = require('./keymap');

// A long-lived helper process that turns simple text commands into SendInput calls.
// The script is passed inline so it also works when the app is packaged inside an asar archive.
function create() {
  const script = fs.readFileSync(path.join(__dirname, 'win-input.ps1'), 'utf8');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  let proc = null;
  let restartAt = 0;

  const ensure = () => {
    if (proc || Date.now() < restartAt) return proc;
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (d) => console.warn('[jconnect] input helper:', d.toString().trim()));
    proc.on('exit', () => { proc = null; restartAt = Date.now() + 2000; });
    proc.stdin.on('error', () => {});
    return proc;
  };

  const send = (line) => {
    const p = ensure();
    if (p && p.stdin.writable) p.stdin.write(`${line}\n`);
  };

  ensure();

  return {
    name: 'windows',
    move: (pt) => send(`M ${Math.round(pt.x)} ${Math.round(pt.y)}`),
    button: (b, down) => send(`B ${b | 0} ${down ? 1 : 0}`),
    wheel: (dx, dy) => send(`W ${Math.round(dx)} ${Math.round(dy)}`),
    key: (code, down) => {
      const k = VK[code];
      if (k) send(`K ${k[0]} ${k[1] ? 1 : 0} ${down ? 1 : 0}`);
    },
    text: (s) => { for (const ch of s) send(`T ${ch.codePointAt(0)}`); },
    close: () => { if (proc) proc.kill(); },
  };
}

module.exports = { create };
