// Writes <download>.json next to a download on the website. JConnect's updater reads it to find a new version.
//   node scripts/update-info.js <download> <version> [--version-code <n>]
// Android downloads also need --version-code, the versionCode in mobile/android/app/build.gradle.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const codeAt = args.indexOf('--version-code');
const versionCode = codeAt >= 0 ? Number(args.splice(codeAt, 2)[1]) : null;
const [file, version] = args;

if (!file || !version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) || (codeAt >= 0 && !Number.isInteger(versionCode))) {
  console.error('Usage: node scripts/update-info.js <download> <version> [--version-code <n>]');
  process.exit(2);
}

const hash = crypto.createHash('sha256');
fs.createReadStream(file)
  .on('data', (chunk) => hash.update(chunk))
  .on('error', (err) => {
    console.error(err.message);
    process.exit(1);
  })
  .on('end', () => {
    const info = {
      app: 'jconnect',
      file: path.basename(file),
      version,
      ...(versionCode !== null ? { versionCode } : {}),
      size: fs.statSync(file).size,
      sha256: hash.digest('hex'),
      released: new Date().toISOString().slice(0, 10),
    };
    fs.writeFileSync(`${file}.json`, `${JSON.stringify(info, null, 2)}\n`);
    console.log(`${file}.json: ${info.version}, ${info.size} bytes, ${info.sha256}`);
  });
