const fs = require('fs');
const path = require('path');

// Development check: `--selftest=ws://host:port/ws|123456` pairs with a host using its pairing code,
// opens a remote session, logs stream stats and saves a screenshot of the live session window.
function run({ spec, showMain, openSession, app }) {
  const [url, code] = spec.split('|');
  const out = process.env.JCONNECT_SELFTEST_OUT || path.join(app.getPath('userData'), 'selftest.png');
  const win = showMain();
  const log = (...a) => console.log('[selftest]', ...a);
  let captured = false;

  const start = async () => {
    const result = await win.webContents.executeJavaScript(`window.JConnectApp.pairWithUrl(${JSON.stringify(url)}, ${JSON.stringify(code)})`);
    log('pair', JSON.stringify(result));
    if (result && result.ok) openSession(result.computerId);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => start().catch((e) => log('error', e.message)));
  else start().catch((e) => log('error', e.message));

  return {
    report(sessionWin, state, info) {
      log(state, JSON.stringify(info || {}));
      if (state === 'stats' && !captured && info && info.framesDecoded > 30) {
        captured = true;
        setTimeout(async () => {
          const image = await sessionWin.webContents.capturePage();
          fs.writeFileSync(out, image.toPNG());
          log('screenshot', out);
          if (process.env.JCONNECT_SELFTEST_EXIT) setTimeout(() => app.exit(0), 500);
        }, 1500);
      }
    },
  };
}

module.exports = { run };
