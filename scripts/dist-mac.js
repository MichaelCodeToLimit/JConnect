// Builds the macOS DMGs. The app icon is the Icon Composer document build/JConnect.icon, which needs
// Xcode 26 or later to compile; with an older Xcode the build falls back to the flat assets/icon-mac.png.
const path = require('path');
const { execFileSync } = require('child_process');

if (process.platform !== 'darwin') {
  console.error('The macOS DMGs can only be built on a Mac.');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

function actoolVersion() {
  try {
    const out = execFileSync('xcrun', ['actool', '--version'], { encoding: 'utf8' });
    const match = /<key>short-bundle-version<\/key>\s*<string>([\d.]+)/.exec(out);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

run(process.execPath, ['scripts/make-icons.js']);
run(process.execPath, ['scripts/build-mac-input.js']);

const args = ['--mac'];
const actool = actoolVersion();
if (actool && Number.parseInt(actool, 10) >= 26) {
  console.log(`Using the Icon Composer icon (actool ${actool}).`);
} else {
  console.log(`actool ${actool || 'is missing'}: Icon Composer icons need Xcode 26 or later, so the flat icon is used.`);
  args.push('-c.mac.icon=assets/icon-mac.png');
}
run(path.join(root, 'node_modules', '.bin', 'electron-builder'), args);
