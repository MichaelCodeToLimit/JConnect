// Builds the macOS DMGs. The app icon is the Icon Composer document build/JConnect.icon. Compiling it needs
// Xcode 26 or later on macOS 26 or later; anywhere else the build falls back to the flat assets/icon-mac.png.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.platform !== 'darwin') {
  console.error('The macOS DMGs can only be built on a Mac.');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

// Compile the icon the way electron-builder does. On success, keep a PNG of Apple's rendering in dist/.
function compileIconComposerIcon() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jconnect-icon-'));
  try {
    const icon = path.join(tmp, 'Icon.icon');
    const out = path.join(tmp, 'out');
    fs.cpSync(path.join(root, 'build', 'JConnect.icon'), icon, { recursive: true });
    fs.mkdirSync(out);
    execFileSync('xcrun', [
      'actool', icon, '--compile', out, '--output-format', 'human-readable-text', '--notices', '--warnings',
      '--output-partial-info-plist', path.join(out, 'assetcatalog_generated_info.plist'),
      '--app-icon', 'Icon', '--include-all-app-icons', '--accent-color', 'AccentColor',
      '--enable-on-demand-resources', 'NO', '--development-region', 'en',
      '--target-device', 'mac', '--minimum-deployment-target', '26.0', '--platform', 'macosx',
    ], { stdio: 'inherit' });
    const icns = path.join(out, 'Icon.icns');
    if (!fs.existsSync(icns) || !fs.existsSync(path.join(out, 'Assets.car'))) return false;
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    execFileSync('sips', ['-s', 'format', 'png', icns, '--out', path.join(root, 'dist', 'icon-preview.png')], { stdio: 'ignore' });
    return true;
  } catch (err) {
    console.log(`actool couldn't compile the Icon Composer icon: ${String(err.message).split('\n')[0]}`);
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run(process.execPath, ['scripts/make-icons.js']);
run(process.execPath, ['scripts/build-mac-input.js']);

const args = ['--mac'];
if (compileIconComposerIcon()) {
  console.log('Using the Icon Composer icon.');
} else {
  console.log('Using the flat icon, because the Icon Composer icon needs Xcode 26 or later on macOS 26 or later.');
  args.push('-c.mac.icon=assets/icon-mac.png');
}
run(path.join(root, 'node_modules', '.bin', 'electron-builder'), args);
