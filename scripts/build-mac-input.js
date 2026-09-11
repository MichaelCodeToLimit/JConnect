// Builds the macOS input helper (native/mac-input.swift) as one binary for Apple silicon and Intel Macs.
// Needs the Xcode Command Line Tools. On other systems there is nothing to build.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.platform !== 'darwin') {
  console.log('mac input helper: skipped, it can only be built on macOS');
  process.exit(0);
}

const root = path.join(__dirname, '..');
const source = path.join(root, 'native', 'mac-input.swift');
const out = path.join(root, 'build', 'native');
fs.mkdirSync(out, { recursive: true });

// Electron 38 runs on macOS 12 and later.
const slices = ['arm64', 'x86_64'].map((arch) => {
  const file = path.join(out, `jconnect-input-${arch}`);
  execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos12`, source, '-o', file], { stdio: 'inherit' });
  return file;
});

const binary = path.join(out, 'jconnect-input');
execFileSync('xcrun', ['lipo', '-create', '-output', binary, ...slices], { stdio: 'inherit' });
for (const file of slices) fs.rmSync(file);
// codesign refuses to sign JConnect while unsigned code sits next to it, so sign the helper right away.
execFileSync('codesign', ['--sign', '-', '--force', '--options', 'runtime', binary], { stdio: 'inherit' });
console.log('mac input helper written to', binary);
