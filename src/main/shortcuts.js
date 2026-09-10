const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app } = require('electron');

function launchArgs(extra) {
  const passthrough = process.argv.filter((a) => /^--(profile|port)=/.test(a));
  return app.isPackaged ? [...passthrough, ...extra] : [app.getAppPath(), ...passthrough, ...extra];
}

function quote(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

// Double-click -> Connect -> Work.
function createShortcut(computer) {
  const desktop = app.getPath('desktop');
  const safeName = computer.name.replace(/[\\/:*?"<>|]/g, '').trim() || 'JConnect computer';
  const args = launchArgs([`--connect=${computer.id}`]);

  if (process.platform === 'win32') {
    const lnk = path.join(desktop, `${safeName}.lnk`);
    const script = [
      '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:JC_LNK)',
      '$s.TargetPath = $env:JC_TARGET',
      '$s.Arguments = $env:JC_ARGS',
      '$s.WorkingDirectory = $env:JC_WD',
      '$s.IconLocation = $env:JC_TARGET + ",0"',
      '$s.Description = $env:JC_DESC',
      '$s.Save()',
    ].join('; ');
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        env: {
          ...process.env,
          JC_LNK: lnk,
          JC_TARGET: process.execPath,
          JC_ARGS: args.map(quote).join(' '),
          JC_WD: path.dirname(process.execPath),
          JC_DESC: `Connect to ${computer.name}`,
        },
      }, (err) => (err ? reject(err) : resolve(lnk)));
    });
  }

  if (process.platform === 'linux') {
    const file = path.join(desktop, `${safeName}.desktop`);
    const exec = [process.execPath, ...args].map((a) => `"${a.replace(/(["`$\\])/g, '\\$1')}"`).join(' ');
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${safeName}\nComment=Connect to ${safeName}\nExec=${exec}\nTerminal=false\nCategories=Network;\n`);
    fs.chmodSync(file, 0o755);
    return Promise.resolve(file);
  }

  const file = path.join(desktop, `${safeName}.command`);
  const exec = [process.execPath, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  fs.writeFileSync(file, `#!/bin/sh\nexec ${exec} >/dev/null 2>&1 &\n`);
  fs.chmodSync(file, 0o755);
  return Promise.resolve(file);
}

module.exports = { createShortcut };
