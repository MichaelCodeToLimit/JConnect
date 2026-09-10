// Renders the JConnect mark (two linked rings on a blue tile) to PNG without any image libraries.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(size, { tile = true } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 512;
  const coverage = (fn, x, y) => {
    let hits = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (fn(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++;
    return hits / 16;
  };
  const roundedSquare = (x, y) => {
    const r = 112 * s;
    const m = 16 * s;
    const qx = Math.max(Math.abs(x - size / 2) - (size / 2 - m - r), 0);
    const qy = Math.max(Math.abs(y - size / 2) - (size / 2 - m - r), 0);
    return Math.hypot(qx, qy) <= r;
  };
  const ring = (cx, cy) => (x, y) => {
    const d = Math.hypot(x - cx * s, y - cy * s);
    return d >= 62 * s && d <= 104 * s;
  };
  const left = ring(196, 256);
  const right = ring(316, 256);
  const mark = (x, y) => left(x, y) || right(x, y);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = (x + y) / (2 * size);
      const bg = tile ? coverage(roundedSquare, x, y) : 0;
      const fg = coverage(mark, x, y);
      const [br, bgc, bb] = [47 + (22 - 47) * t, 107 + (80 - 107) * t, 255 + (224 - 255) * t];
      const [fr, fgc, fb] = tile ? [255, 255, 255] : [47, 107, 255];
      const a = fg + bg * (1 - fg);
      if (a === 0) continue;
      px[i] = Math.round((fr * fg + br * bg * (1 - fg)) / a);
      px[i + 1] = Math.round((fgc * fg + bgc * bg * (1 - fg)) / a);
      px[i + 2] = Math.round((fb * fg + bb * bg * (1 - fg)) / a);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, px);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), render(512));
fs.writeFileSync(path.join(out, 'tray.png'), render(32));
fs.writeFileSync(path.join(out, 'tray@2x.png'), render(64));
console.log('icons written to', out);
