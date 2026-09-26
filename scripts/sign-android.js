// Signs an unsigned release APK with JConnect's Android release key, then checks the signature.
//   node scripts/sign-android.js <unsigned.apk> <signed.apk>
// The key lives outside the repository, in %USERPROFILE%\.jconnect-signing (android-release.p12 and
// android-release.properties), or wherever JCONNECT_ANDROID_SIGNING points at the .properties file.
// The signature has to match mobile/android/release-certificate.pem, which Google has for the app.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node scripts/sign-android.js <unsigned.apk> <signed.apk>');
  process.exit(2);
}

const propsFile = process.env.JCONNECT_ANDROID_SIGNING || path.join(os.homedir(), '.jconnect-signing', 'android-release.properties');
const props = Object.fromEntries(fs.readFileSync(propsFile, 'utf8').split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const keystore = path.resolve(path.dirname(propsFile), props.storeFile);

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
const versions = fs.readdirSync(path.join(sdk, 'build-tools')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const tools = path.join(sdk, 'build-tools', versions[versions.length - 1]);
const exe = (name) => path.join(tools, process.platform === 'win32' ? `${name}.exe` : name);
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
const apksigner = (...args) => execFileSync(java, ['-jar', path.join(tools, 'lib', 'apksigner.jar'), ...args], {
  env: { ...process.env, JC_STORE_PASS: props.storePassword, JC_KEY_PASS: props.keyPassword },
  // Newer Javas warn about apksigner's native library on stderr. A real failure still throws with its output.
  stdio: ['ignore', 'pipe', 'pipe'],
}).toString();

// apksigner has to sign an APK that's already aligned. Native libraries also need 16 KB pages for Android 15.
const aligned = `${output}.aligned`;
execFileSync(exe('zipalign'), ['-f', '-P', '16', '4', input, aligned]);
apksigner('sign', '--ks', keystore, '--ks-key-alias', props.keyAlias, '--ks-pass', 'env:JC_STORE_PASS',
  '--key-pass', 'env:JC_KEY_PASS', '--out', output, aligned);
fs.rmSync(aligned);
fs.rmSync(`${output}.idsig`, { force: true });

const certs = apksigner('verify', '--verbose', '--print-certs', output);
const signed = (certs.match(/certificate SHA-256 digest: ([0-9a-f]{64})/) || [])[1];
const pem = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'release-certificate.pem'), 'utf8');
const expected = crypto.createHash('sha256').update(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64')).digest('hex');
if (signed !== expected) {
  console.error(`${output} is signed by ${signed || 'nothing'}, not the release key ${expected}`);
  process.exit(1);
}
const schemes = certs.split('\n').filter((line) => /^Verified using v\d.*true/.test(line)).map((line) => line.match(/v[\d.]+/)[0]);
console.log(`${output}: signed with the release key (${schemes.join(', ')}), SHA-256 of the certificate ${signed}`);
