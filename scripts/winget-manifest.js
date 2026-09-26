// Writes JConnect's winget manifests for a Windows installer, laid out as in microsoft/winget-pkgs, so they can be
// checked with `winget validate` and copied into a pull request there. The installer link is the file's release in
// MichaelCodeToLimit/JConnect-releases, whose name includes the version, so the link keeps matching the manifest
// after the website's download moves on.
//   node scripts/winget-manifest.js <installer> <version> [--display-version <v>] [--release-date <YYYY-MM-DD>]
// --display-version is the version the installer reports to Windows, when that differs from <version>.
// Builds made before releases carried their own version (such as 0.1.0-beta.1) all report 0.1.0.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../package.json');

const ID = 'MichaelDavies.JConnect';
const SITE = 'https://jconnect-1dsx.onrender.com';
const SCHEMA = '1.12.0';
// electron-builder names the uninstall registry key with a v5 UUID of the app ID in this namespace.
const ELECTRON_BUILDER_NS = '50e065bc-3134-11e6-9bab-38c9862bdaf3';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : null;
};
const displayOption = option('--display-version');
const releaseDate = option('--release-date') || new Date().toISOString().slice(0, 10);
const [file, version] = args;
const displayVersion = displayOption || version;
const isVersion = (v) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v || '');

if (!file || !isVersion(version) || !isVersion(displayVersion) || !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
  console.error('Usage: node scripts/winget-manifest.js <installer> <version> [--display-version <v>] [--release-date <YYYY-MM-DD>]');
  process.exit(2);
}

function uuidV5(name, namespace) {
  const hash = crypto.createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const productCode = uuidV5(pkg.build.appId, ELECTRON_BUILDER_NS);
const displayName = ((pkg.build.nsis && pkg.build.nsis.uninstallDisplayName) || '${productName} ${version}')
  .replace('${productName}', pkg.build.productName)
  .replace('${version}', displayVersion);
const publisher = pkg.author;

const header = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${SCHEMA}.schema.json\n\n`;
const common = `PackageIdentifier: ${ID}\nPackageVersion: ${version}\n`;
const footer = (type) => `ManifestType: ${type}\nManifestVersion: ${SCHEMA}\n`;

const hash = crypto.createHash('sha256');
fs.createReadStream(file)
  .on('data', (chunk) => hash.update(chunk))
  .on('error', (err) => {
    console.error(err.message);
    process.exit(1);
  })
  .on('end', () => {
    const sha256 = hash.digest('hex').toUpperCase();
    const dir = path.join(__dirname, '..', 'dist', 'winget', 'manifests', ID[0].toLowerCase(), ...ID.split('.'), version);
    fs.mkdirSync(dir, { recursive: true });

    const files = {
      [`${ID}.yaml`]: header('version') + common + 'DefaultLocale: en-US\n' + footer('version'),

      [`${ID}.installer.yaml`]: header('installer') + common + `MinimumOSVersion: 10.0.0.0
InstallerType: nullsoft
Scope: user
InstallerSwitches:
  Upgrade: --updated
UpgradeBehavior: install
ProductCode: ${productCode}
ReleaseDate: ${releaseDate}
AppsAndFeaturesEntries:
- DisplayName: ${displayName}
  Publisher: ${publisher}
  DisplayVersion: ${displayVersion}
  ProductCode: ${productCode}
Installers:
- Architecture: x64
  InstallerUrl: https://github.com/MichaelCodeToLimit/JConnect-releases/releases/download/windows-v${version}/JConnect-Setup-${version}.exe
  InstallerSha256: ${sha256}
` + footer('installer'),

      [`${ID}.locale.en-US.yaml`]: header('defaultLocale') + common + `PackageLocale: en-US
Publisher: ${publisher}
PublisherUrl: ${SITE}/
PublisherSupportUrl: ${SITE}/docs/#troubleshooting
Author: ${publisher}
PackageName: ${pkg.build.productName}
PackageUrl: ${SITE}/
License: Proprietary
LicenseUrl: ${SITE}/about/#licence
Copyright: Copyright © ${releaseDate.slice(0, 4)} ${publisher}
ShortDescription: Remote desktop with no IP addresses, no port forwarding and no account needed.
Description: |-
  JConnect is remote-desktop and remote-access software for Windows, macOS, Linux and Android.
  Computers on the same network find each other automatically. Pair them once with a six-digit code, then press Connect: there are no IP addresses to look up, no ports to forward and no account to create.
  Every session is end-to-end encrypted with an X25519 key exchange, XSalsa20-Poly1305 and Ed25519 device keys. Screen and sound travel over WebRTC.
  Away from home, JVPN carries sessions through a relay that only passes encrypted bytes. It installs no network adapter and needs no administrator rights. JConnect can also use Tailscale, Twingate, ZeroTier, WireGuard or a Windows VPN you already have.
  Also included: an SSH client, Remote Desktop (RDP) routing, Wake-on-LAN, optional encrypted sync of your devices, Travel Mode and Emergency Lockdown.
  JConnect is an early beta and free to use during the beta. The Windows build isn't code-signed yet, so SmartScreen may warn the first time it runs.
Moniker: jconnect
Tags:
- remote-desktop
- remote-access
- remote-control
- screen-sharing
- unattended-access
- ssh
- rdp
- vpn
- wake-on-lan
- end-to-end-encryption
- self-hosted
Documentations:
- DocumentLabel: Docs
  DocumentUrl: ${SITE}/docs/
` + footer('defaultLocale'),
    };

    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    console.log(`${dir}: ${version} (reports ${displayVersion}), ${sha256}`);
  });
