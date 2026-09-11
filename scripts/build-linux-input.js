// Builds the Linux input helper (native/linux-input.c), which sends mouse and keyboard events through X11's XTEST extension.
// Needs a C compiler and the X11 and XTest headers (Debian and Ubuntu: libx11-dev and libxtst-dev).
// On other systems there is nothing to build.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.platform !== 'linux') {
  console.log('linux input helper: skipped, it can only be built on Linux');
  process.exit(0);
}

const root = path.join(__dirname, '..');
const out = path.join(root, 'build', 'native');
fs.mkdirSync(out, { recursive: true });

// CC, CFLAGS and LDFLAGS work as usual, for example to use headers that aren't installed system-wide.
const flags = (name) => (process.env[name] || '').split(/\s+/).filter(Boolean);
const binary = path.join(out, 'jconnect-input');
execFileSync(process.env.CC || 'cc', [
  '-O2', '-Wall', '-Wextra', '-s', ...flags('CFLAGS'),
  path.join(root, 'native', 'linux-input.c'), '-o', binary,
  ...flags('LDFLAGS'), '-lXtst', '-lX11', '-lm',
], { stdio: 'inherit' });
console.log('linux input helper written to', binary);
