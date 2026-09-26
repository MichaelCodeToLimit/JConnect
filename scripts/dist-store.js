// Builds JConnect for the Microsoft Store as an MSIX package: dist/JConnect-<version>-Store.appx.
//   node scripts/dist-store.js <version> [--test]
// The package is built unsigned, because the Store signs it after certification. Its identity has to match the app
// reserved in Partner Center (the app's Product identity page): set build.appx.identityName and build.appx.publisher
// in package.json. --test uses a stand-in identity instead, for a package signed with a "CN=JConnect Test"
// certificate and installed on a test machine. The Store would reject that one.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pkg = require('../package.json');

const args = process.argv.slice(2);
const test = args.includes('--test');
const version = args.find((a) => !a.startsWith('--'));
const parts = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z-]+\.(\d+))?$/.exec(version || '');
if (!parts || (parts[4] !== undefined && Number(parts[4]) > 98)) {
  console.error('Usage: node scripts/dist-store.js <version, such as 0.1.0-beta.3> [--test]');
  process.exit(2);
}

// The Store wants four numbers that grow with every submission, the last one 0. A prerelease such as 0.1.0-beta.3
// becomes 0.1.3.0, and the release it leads to, 0.1.0, becomes 0.1.99.0, so it comes after its betas.
const [major, minor, patch] = parts.slice(1, 4).map(Number);
const storeVersion = `${major}.${minor}.${patch * 100 + (parts[4] === undefined ? 99 : Number(parts[4]))}.0`;

const appx = pkg.build.appx || {};
const identity = test
  ? { identityName: 'JConnect.Test', publisher: 'CN=JConnect Test' }
  : { identityName: appx.identityName, publisher: appx.publisher };
if (!identity.identityName || !identity.publisher) {
  console.error('Set build.appx.identityName and build.appx.publisher in package.json to the values on the app\'s Product identity page in Partner Center, or build with --test.');
  process.exit(2);
}

const root = path.join(__dirname, '..');
const manifest = path.join(root, 'dist', 'msix-AppxManifest.xml');
fs.mkdirSync(path.dirname(manifest), { recursive: true });
const template = fs.readFileSync(path.join(root, 'build', 'msix', 'AppxManifest.xml'), 'utf8');
if (!template.includes('Version="STORE_VERSION"')) throw new Error('build/msix/AppxManifest.xml has no Version="STORE_VERSION"');
fs.writeFileSync(manifest, template.replace('Version="STORE_VERSION"', `Version="${storeVersion}"`));

// The makeappx.exe in electron-builder's own tools won't start on current Windows 11 ("side-by-side configuration is
// incorrect"), so use the Windows SDK's.
const kits = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
const kit = fs.existsSync(kits) && fs.readdirSync(kits)
  .filter((v) => /^10\./.test(v) && fs.existsSync(path.join(kits, v, 'x64', 'makeappx.exe')))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .pop();
if (!kit) {
  console.error(`Install the Windows SDK, which has makeappx.exe. None was found in ${kits}.`);
  process.exit(1);
}

execFileSync(process.execPath, [path.join(root, 'scripts', 'make-icons.js')], { stdio: 'inherit' });
execFileSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--win', 'appx', '--x64',
  `-c.extraMetadata.version=${version}`,
  `-c.appx.customManifestPath=${manifest}`,
  `-c.appx.identityName=${identity.identityName}`,
  `-c.appx.publisher=${identity.publisher}`,
], { cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_BUILDER_WINDOWS_KITS_PATH: path.join(kits, kit, 'x64') } });
console.log(`Built JConnect ${version} for the Microsoft Store as package version ${storeVersion}${test ? ', with the test identity' : ''}.`);
