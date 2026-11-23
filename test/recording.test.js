// Session recordings: the WebM header gets a Duration so players can show the length and seek, recordings are
// written as they arrive, and each window can only touch its own.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Recordings, prepareWebmHead, recordingName } = require('../src/main/recording');

// EBML: an ID's bytes, then the size in the shortest form (or a given form), then the data.
function vint(value, length) {
  const len = length || [1, 2, 3, 4, 5, 6, 7, 8].find((n) => value < 2 ** (7 * n) - 1);
  const out = Buffer.alloc(len);
  let rest = value;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}
const idBytes = (id) => Buffer.from(id.toString(16).padStart(Math.ceil(id.toString(16).length / 2) * 2, '0'), 'hex');
const el = (id, ...data) => {
  const body = Buffer.concat(data);
  return Buffer.concat([idBytes(id), vint(body.length), body]);
};
const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

// What a browser's MediaRecorder writes: a live Segment of unknown size, Info without a Duration, Tracks,
// then Clusters.
function browserWebm({ segmentSize = null, info = null, before = [] } = {}) {
  const header = el(0x1a45dfa3, el(0x4282, Buffer.from('webm')));
  const infoEl = info || el(0x1549a966, el(0x2ad7b1, Buffer.from([0x0f, 0x42, 0x40])), el(0x4d80, Buffer.from('Chrome')), el(0x5741, Buffer.from('Chrome')));
  const tracks = el(0x1654ae6b, el(0xae, el(0xd7, Buffer.from([1])), el(0x86, Buffer.from('V_VP9'))));
  const cluster = Buffer.concat([idBytes(0x1f43b675), UNKNOWN_SIZE, el(0xe7, Buffer.from([0])), el(0xa3, Buffer.alloc(40, 7))]);
  const body = Buffer.concat([...before, infoEl, tracks, cluster]);
  const size = segmentSize === 'known' ? vint(body.length, 8) : UNKNOWN_SIZE;
  return Buffer.concat([header, idBytes(0x18538067), size, body]);
}

// Reads back the Duration from a patched file, in milliseconds.
function readDuration(buf, { offset, bytes, scale = 1000000 }) {
  const value = bytes === 8 ? buf.readDoubleBE(offset) : buf.readFloatBE(offset);
  return (value * scale) / 1e6;
}

test('a Duration is added to the header, and the rest of the file is unchanged', () => {
  const file = browserWebm();
  const prepared = prepareWebmHead(file);
  assert.ok(prepared);
  assert.strictEqual(prepared.bytes, 8);
  assert.strictEqual(prepared.scale, 1000000);
  // Duration element (0x4489, 8 bytes) sits right before where the length goes.
  assert.deepStrictEqual([...prepared.head.subarray(prepared.offset - 3, prepared.offset)], [0x44, 0x89, 0x88]);
  assert.strictEqual(readDuration(prepared.head, prepared), 0);
  // Everything after Info (Tracks, Clusters) is carried over byte for byte.
  const tail = file.subarray(file.indexOf(Buffer.from([0x16, 0x54, 0xae, 0x6b])));
  assert.ok(prepared.head.subarray(prepared.head.length - tail.length).equals(tail));

  prepared.head.writeDoubleBE(83456.5, prepared.offset);
  const again = prepareWebmHead(prepared.head);
  assert.strictEqual(again.head, prepared.head, 'a header that already has a Duration is kept');
  assert.strictEqual(again.offset, prepared.offset);
  assert.strictEqual(readDuration(prepared.head, again), 83456.5);
});

test('more of the file is asked for until Info has arrived', () => {
  const file = browserWebm();
  const infoEnd = file.indexOf(Buffer.from([0x16, 0x54, 0xae, 0x6b]));
  for (const cut of [0, 1, 5, 20, infoEnd - 1]) assert.strictEqual(prepareWebmHead(file.subarray(0, cut)), undefined, `cut at ${cut}`);
  assert.ok(prepareWebmHead(file.subarray(0, infoEnd)));
});

test('a Segment with a known size grows with its Info', () => {
  const file = browserWebm({ segmentSize: 'known' });
  const prepared = prepareWebmHead(file);
  const segmentStart = file.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  const sizeBefore = Number(file.readBigUInt64BE(segmentStart + 4) & 0x00ffffffffffffffn);
  const sizeAfter = Number(prepared.head.readBigUInt64BE(segmentStart + 4) & 0x00ffffffffffffffn);
  assert.strictEqual(sizeAfter - sizeBefore, prepared.head.length - file.length);
  assert.strictEqual(prepared.head.length - segmentStart - 12, sizeAfter);
});

test('the length is written in the file’s own time scale', () => {
  const info = el(0x1549a966, el(0x2ad7b1, Buffer.from([0x03, 0xe8])), el(0x4d80, Buffer.from('x')));
  const prepared = prepareWebmHead(browserWebm({ info }));
  assert.strictEqual(prepared.scale, 1000);
});

test('files that aren’t laid out the way browsers write them are left alone', () => {
  assert.strictEqual(prepareWebmHead(Buffer.from('not a webm file at all, just some text')), null);
  // A SeekHead points at elements by position, and adding a Duration would move them.
  assert.strictEqual(prepareWebmHead(browserWebm({ before: [el(0x114d9b74, el(0x4dbb, Buffer.alloc(4)))] })), null);
  const noInfo = Buffer.concat([el(0x1a45dfa3, el(0x4282, Buffer.from('webm'))), idBytes(0x18538067), UNKNOWN_SIZE,
    idBytes(0x1f43b675), UNKNOWN_SIZE, el(0xe7, Buffer.from([0]))]);
  assert.strictEqual(prepareWebmHead(noInfo), null);
});

test('recording names are valid file names that say which computer and when', () => {
  const when = new Date(2026, 8, 16, 9, 5, 7);
  assert.strictEqual(recordingName('Home PC', when), 'Home PC 2026-09-16 09.05.07');
  assert.strictEqual(recordingName('Anna\'s <Mac>: "work"/?', when), 'Anna\'s Mac work 2026-09-16 09.05.07');
  assert.strictEqual(recordingName('Trailing dots...', when), 'Trailing dots 2026-09-16 09.05.07');
  assert.strictEqual(recordingName('  ', when), 'Session 2026-09-16 09.05.07');
  assert.strictEqual(recordingName('x'.repeat(200), when).length, 60 + 20);
});

test('a recording is saved as it arrives and gets its length when it stops', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jconnect-rec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recordings = new Recordings({ dir: path.join(dir, 'JConnect') });
  const source = browserWebm();

  const { id, name } = await recordings.start(7, 'Home PC');
  assert.match(name, /^Home PC \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.webm$/);
  // In uneven pieces, the first too small to hold the header.
  for (const [from, to] of [[0, 3], [3, 40], [40, 41], [41, source.length]]) {
    await recordings.write(7, id, new Uint8Array(source.subarray(from, to)));
  }
  assert.throws(() => recordings.write(8, id, new Uint8Array(4)), /No such recording/);
  assert.throws(() => recordings.write(7, id, 'text'), /Invalid recording data/);

  const saved = await recordings.stop(7, id, 12345);
  assert.strictEqual(saved.name, name);
  const written = fs.readFileSync(saved.file);
  const prepared = prepareWebmHead(written);
  assert.strictEqual(readDuration(written, prepared), 12345);
  assert.strictEqual(written.length, source.length + 11 + 7);
  await assert.rejects(recordings.stop(7, id, 1), /No such recording/);

  // Starting again in the same second doesn't overwrite it.
  const second = await recordings.start(7, 'Home PC');
  assert.notStrictEqual(second.name, name);
  assert.strictEqual(await recordings.stop(7, second.id, 1000), null, 'an empty recording leaves no file');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'JConnect')), [name]);
});

test('closing a window keeps what it recorded, and only its own recordings', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jconnect-rec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recordings = new Recordings({ dir });
  const mine = await recordings.start(1, 'Office');
  const other = await recordings.start(2, 'Laptop');
  await recordings.write(1, mine.id, new Uint8Array(browserWebm()));
  await recordings.write(2, other.id, new Uint8Array(browserWebm()));

  const saved = await recordings.stopAll(1);
  assert.strictEqual(saved.length, 1);
  const written = fs.readFileSync(saved[0].file);
  assert.ok(readDuration(written, prepareWebmHead(written)) >= 0);
  assert.strictEqual(recordings.active.size, 1);
  assert.ok(await recordings.stop(2, other.id, 500));
});
