// JConnect from the Microsoft Store runs as an MSIX package, which changes two things:
// - The Store installs its updates, so the updater leaves it alone (see updater.js).
// - It can't add itself to the Run registry key, because Windows keeps a packaged app's registry writes to itself.
//   Instead the package declares a startup task, and Windows starts JConnect with it at every sign-in. A startup
//   task can't pass --hidden, so startedAtSignIn() tells that start from someone opening JConnect.
const { execFile } = require('child_process');

const isStorePackage = () => process.platform === 'win32' && !!process.windowsStore;

// Windows starts explorer.exe as someone signs in and runs the startup tasks shortly after, so JConnect started at
// sign-in if it started within a couple of minutes of this session's explorer.exe.
function startedAtSignIn({ within = 120000, run = execFile } = {}) {
  const script = [
    '$session = (Get-Process -Id $PID).SessionId',
    '$explorer = Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session | Sort-Object StartTime | Select-Object -First 1',
    'if ($explorer) { [DateTimeOffset]::new($explorer.StartTime).ToUnixTimeMilliseconds() }',
  ].join('; ');
  const startedAt = Date.now() - process.uptime() * 1000;
  return new Promise((resolve) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const explorerAt = Number(String(stdout || '').trim());
      resolve(!err && explorerAt > 0 && startedAt >= explorerAt && startedAt - explorerAt < within);
    });
  });
}

module.exports = { isStorePackage, startedAtSignIn };
