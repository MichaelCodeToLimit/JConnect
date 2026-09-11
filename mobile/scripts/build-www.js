// Builds mobile/www: the JConnect web client from src/web, plus the Android additions in mobile/src.
const fs = require('fs');
const path = require('path');

const mobile = path.join(__dirname, '..');
const root = path.join(mobile, '..');
const web = path.join(root, 'src', 'web');
const www = path.join(mobile, 'www');

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

fs.rmSync(www, { recursive: true, force: true });
const webFiles = [
  'web.css', 'identity.js', 'input.js', 'connection.js', 'app.js',
  'vendor/nacl-fast.min.js', 'vendor/scrypt.js', 'vendor/tweetnacl-LICENSE.txt', 'vendor/scrypt-js-LICENSE.txt',
];
for (const file of webFiles) copy(path.join(web, file), path.join(www, file));
copy(path.join(root, 'src', 'shared', 'secure-channel.js'), path.join(www, 'secure-channel.js'));
for (const file of ['native.js', 'native.css']) copy(path.join(mobile, 'src', file), path.join(www, file));

let html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const insert = (marker, addition) => {
  if (!html.includes(marker)) throw new Error(`src/web/index.html no longer contains ${marker}`);
  html = html.replace(marker, addition);
};
insert('<link rel="stylesheet" href="web.css">', '<link rel="stylesheet" href="web.css">\n  <link rel="stylesheet" href="native.css">');
insert('<script src="vendor/nacl-fast.min.js"></script>', '<script src="native.js"></script>\n  <script src="vendor/nacl-fast.min.js"></script>');
fs.writeFileSync(path.join(www, 'index.html'), html);

console.log(`www built from src/web in ${www}`);
