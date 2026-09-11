// Checks remote control on Linux in an X11 session. It opens a window, sends it input the way viewers send it and
// reads back what the window received. The Linux CI check runs it under Xvfb.
// Usage: npm run linux-helper, then: npx electron --no-sandbox scripts/linux-input-check.js
// Set JCONNECT_CHECK_SCREENSHOT to a .png path to keep a screenshot of the window.
const fs = require('fs');
const { app, BrowserWindow, screen } = require('electron');
const { InputController } = require('../src/main/input');
const { LINUX_KEYS } = require('../src/main/input/keymap');

const PAGE = `<!doctype html><meta charset="utf-8"><title>JConnect input check</title>
<style>
  body { margin: 0; font: 16px sans-serif; background: #fff; }
  #text { position: absolute; left: 20px; top: 20px; width: 400px; height: 110px; font-size: 18px; }
  #scroll { position: absolute; left: 20px; top: 160px; width: 400px; height: 180px; overflow: auto; background: #e8eefc; }
</style>
<textarea id="text"></textarea>
<div id="scroll"><div style="height: 6000px"></div></div>
<script>
  window.seen = { buttons: [], codes: [] };
  addEventListener('mousedown', (e) => seen.buttons.push(e.button));
  addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', (e) => {
    seen.codes.push(e.code);
    if (e.target.id !== 'text') e.preventDefault();
  });
</script>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...a) => console.log('[input-check]', ...a);
// Lock keys aren't pressed, because they would change how the keys after them type.
const SKIP = new Set(['CapsLock', 'NumLock', 'ScrollLock']);
// Desktops and input methods often keep these keys for themselves, so a missing one is only a warning.
const OPTIONAL = /^(Audio|Media|Lang|KanaMode|Convert|NonConvert|Intl|NumpadComma|NumpadEqual|PrintScreen|F1[3-9]|F2[0-4])/;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const failures = [];
  const warnings = [];
  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({ x: display.bounds.x + 60, y: display.bounds.y + 60, width: 440, height: 360, frame: false });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  win.focus();
  const page = (script) => win.webContents.executeJavaScript(script);

  const input = new InputController();
  input.init();
  await sleep(1500);
  log('helper:', input.reason || 'ready');
  if (input.reason) failures.push(`remote control isn't available: ${input.reason}`);

  const send = (msg) => input.handle('check', msg, display.id);
  // Viewers send pointer positions as fractions of the display.
  const center = async (selector) => {
    const r = await page(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const content = win.getContentBounds();
    const b = display.bounds;
    const x = Math.round(content.x + r.x);
    const y = Math.round(content.y + r.y);
    return { x, y, nx: (x - b.x) / (b.width - 1), ny: (y - b.y) / (b.height - 1) };
  };

  const text = await center('#text');
  send({ t: 'm', x: text.nx, y: text.ny });
  await sleep(300);
  const cursor = screen.getCursorScreenPoint();
  log(`pointer: sent to ${text.x},${text.y}, now at ${cursor.x},${cursor.y}`);
  if (Math.abs(cursor.x - text.x) > 1 || Math.abs(cursor.y - text.y) > 1) failures.push('the pointer went to the wrong place');

  send({ t: 'b', b: 0, d: 1, x: text.nx, y: text.ny });
  send({ t: 'b', b: 0, d: 0, x: text.nx, y: text.ny });
  await sleep(400);
  const focused = await page('document.activeElement && document.activeElement.id');
  log('focus after a left click:', focused || 'none');
  if (focused !== 'text') failures.push("a left click didn't focus the text box");

  // Characters on a US keyboard have their own keys. The rest are typed through spare keys.
  const ascii = 'Hello, Linux! 0123456789 `~!@#$%^&*()-_=+[]{}\\|;:\'",.<>/?';
  send({ t: 'x', s: ascii });
  await sleep(1500);
  let typed = await page("document.getElementById('text').value");
  log('typed:', JSON.stringify(typed));
  if (typed !== ascii) failures.push('typing ASCII text went wrong');
  const other = ' äöü é ß € ✓ 日本';
  send({ t: 'x', s: other });
  await sleep(2500);
  typed = await page("document.getElementById('text').value");
  log('typed:', JSON.stringify(typed.slice(ascii.length)));
  if (typed !== ascii + other) failures.push('typing other characters went wrong');

  await page('seen.codes = []');
  const codes = Object.keys(LINUX_KEYS).filter((code) => !SKIP.has(code));
  for (const code of codes) {
    send({ t: 'k', c: code, d: 1 });
    send({ t: 'k', c: code, d: 0 });
    await sleep(10);
  }
  await sleep(1000);
  const seenCodes = new Set(await page('seen.codes'));
  const missing = codes.filter((code) => !seenCodes.has(code));
  const missingRequired = missing.filter((code) => !OPTIONAL.test(code));
  log(`keys: ${codes.length - missing.length} of ${codes.length} arrived${missing.length ? `, missing ${missing.join(' ')}` : ''}`);
  if (missingRequired.length) failures.push(`these keys didn't arrive: ${missingRequired.join(' ')}`);
  else if (missing.length) warnings.push(`these keys didn't arrive: ${missing.join(' ')}`);

  const box = await center('#scroll');
  send({ t: 'm', x: box.nx, y: box.ny });
  await sleep(200);
  send({ t: 'w', dx: 0, dy: 300 });
  await sleep(800);
  const down = await page("document.getElementById('scroll').scrollTop");
  send({ t: 'w', dx: 0, dy: -200 });
  await sleep(800);
  const up = await page("document.getElementById('scroll').scrollTop");
  log(`scrolling: down to ${down}, then back up to ${up}`);
  if (!(down > 0)) failures.push("scrolling down didn't scroll");
  if (!(up < down)) failures.push("scrolling up didn't scroll");

  await page('seen.buttons = []');
  for (const b of [0, 1, 2, 3, 4]) {
    send({ t: 'b', b, d: 1, x: box.nx, y: box.ny });
    send({ t: 'b', b, d: 0, x: box.nx, y: box.ny });
    await sleep(200);
  }
  await sleep(500);
  const buttons = await page('seen.buttons');
  log('mouse buttons that arrived:', buttons.join(' '));
  for (const b of [0, 1, 2]) if (!buttons.includes(b)) failures.push(`mouse button ${b} didn't arrive`);
  for (const b of [3, 4]) if (!buttons.includes(b)) warnings.push(`mouse button ${b} didn't arrive`);

  if (process.env.JCONNECT_CHECK_SCREENSHOT) {
    fs.writeFileSync(process.env.JCONNECT_CHECK_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  }
  input.release('check');
  input.close();
  for (const w of warnings) log('warning:', w);
  for (const f of failures) log('FAILED:', f);
  log(failures.length ? 'failed' : 'passed');
  app.exit(failures.length ? 1 : 0);
}).catch((err) => {
  console.error('[input-check]', err);
  app.exit(1);
});

setTimeout(() => {
  log('timed out');
  app.exit(1);
}, 120000);
