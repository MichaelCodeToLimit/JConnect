// Draws the banner Android TV and Google TV show for JConnect on the home screen (320 x 180, an xhdpi drawable).
// Run it with Electron: npx electron scripts/make-tv-banner.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const WIDTH = 320;
const HEIGHT = 180;
const root = path.join(__dirname, '..');
const out = path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'res', 'drawable-xhdpi', 'tv_banner.png');
const icon = fs.readFileSync(path.join(root, 'assets', 'icon.png')).toString('base64');

const html = `<!doctype html><html><head><style>
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body {
    display: flex; align-items: center; justify-content: center; gap: 14px;
    background: radial-gradient(130% 150% at 0% 0%, #1d2d5c 0%, #0f1115 62%);
    color: #fff; font: 600 40px "Segoe UI", Roboto, system-ui, sans-serif; letter-spacing: -0.01em;
  }
  img { width: 72px; height: 72px; }
</style></head><body><img src="data:image/png;base64,${icon}" alt=""><span>JConnect</span></body></html>`;

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: WIDTH, height: HEIGHT, useContentSize: true, frame: false });
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  let image = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  const size = image.getSize();
  if (size.width !== WIDTH || size.height !== HEIGHT) image = image.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  console.log(`banner written to ${out} (${size.width} x ${size.height} captured)`);
  app.quit();
});
