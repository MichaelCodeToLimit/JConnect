const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Session recordings. The session window records the remote screen with MediaRecorder and hands the WebM
// to this module a second at a time, so a long recording never has to fit in memory.
//
// A browser writes WebM as a live stream, without the recording's length, so players can't show how long
// it is or seek in it. When the header arrives an empty Duration is added to it, and it's filled in at the end.

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  CLUSTER: 0x1f43b675,
};
// The header is a few hundred bytes. If this much arrives without one, the file is kept as it is.
const HEAD_LIMIT = 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;

function readVint(buf, pos, isId) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (!first) throw new Error('bad length');
  const length = Math.clz32(first) - 23;
  if (pos + length > buf.length) return null;
  const mask = 0xff >> length;
  let value = isId ? first : first & mask;
  let unknown = (first & mask) === mask;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) unknown = false;
  }
  return { value, length, unknown: !isId && unknown };
}

function readElement(buf, pos) {
  const id = readVint(buf, pos, true);
  if (!id) return null;
  if (id.length > 4) throw new Error('bad id');
  const size = readVint(buf, pos + id.length, false);
  if (!size) return null;
  const dataStart = pos + id.length + size.length;
  return {
    id: id.value,
    start: pos,
    sizeOffset: pos + id.length,
    sizeLength: size.length,
    dataStart,
    size: size.unknown ? null : size.value,
    end: size.unknown ? null : dataStart + size.value,
  };
}

function writeVint(buf, offset, value, length) {
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    buf[offset + i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  buf[offset] |= 0x80 >> (length - 1);
}

// Returns the header with room for the length, and where to write it; undefined while more of the file is
// needed; or null when the file isn't laid out the way a browser writes it, in which case it's kept as is.
function prepareWebmHead(buf) {
  try {
    const ebml = readElement(buf, 0);
    if (!ebml) return undefined;
    if (ebml.id !== ID.EBML || ebml.end === null) return null;
    const segment = readElement(buf, ebml.end);
    if (!segment) return undefined;
    if (segment.id !== ID.SEGMENT) return null;
    for (let pos = segment.dataStart; ;) {
      const el = readElement(buf, pos);
      if (!el) return undefined;
      // Elements after Info move, so a file that points at them by position isn't changed.
      if (el.id === ID.CLUSTER || el.id === ID.SEEK_HEAD || el.end === null) return null;
      if (el.id !== ID.INFO) {
        pos = el.end;
        continue;
      }
      return el.end > buf.length ? undefined : addDuration(buf, segment, el);
    }
  } catch {
    return null;
  }
}

function addDuration(buf, segment, info) {
  let scale = 1000000;
  for (let pos = info.dataStart; pos < info.end;) {
    const child = readElement(buf, pos);
    if (!child || child.end === null || child.end > info.end) return null;
    if (child.id === ID.TIMECODE_SCALE && child.size >= 1 && child.size <= 6) scale = buf.readUIntBE(child.dataStart, child.size) || scale;
    if (child.id === ID.DURATION) {
      return child.size === 4 || child.size === 8 ? { head: buf, offset: child.dataStart, bytes: child.size, scale } : null;
    }
    pos = child.end;
  }
  // Info's size is written in the longest form, so the Duration always fits.
  const duration = Buffer.from([0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0]);
  const infoHeader = Buffer.alloc(info.sizeOffset - info.start + 8);
  buf.copy(infoHeader, 0, info.start, info.sizeOffset);
  writeVint(infoHeader, info.sizeOffset - info.start, info.size + duration.length, 8);
  const head = Buffer.concat([
    buf.subarray(0, info.start), infoHeader, buf.subarray(info.dataStart, info.end), duration, buf.subarray(info.end),
  ]);
  if (segment.size !== null) {
    const grown = segment.size + infoHeader.length - (info.dataStart - info.start) + duration.length;
    if (grown > 2 ** (7 * segment.sizeLength) - 2) return null;
    head.fill(0, segment.sizeOffset, segment.sizeOffset + segment.sizeLength);
    writeVint(head, segment.sizeOffset, grown, segment.sizeLength);
  }
  return { head, offset: info.start + infoHeader.length + info.size + 3, bytes: 8, scale };
}

function durationBytes(ms, { bytes, scale }) {
  const value = (Math.max(0, ms) * 1e6) / scale;
  const out = Buffer.alloc(bytes);
  if (bytes === 8) out.writeDoubleBE(value);
  else out.writeFloatBE(value);
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

// "Home PC 2026-09-16 14.30.05.webm": sorts by time and is a valid file name on every system.
function recordingName(computerName, date = new Date()) {
  const name = String(computerName ?? '')
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '') || 'Session';
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `${name} ${stamp}`;
}

class Recordings {
  constructor({ dir }) {
    this.dir = dir;
    this.active = new Map();
  }

  async start(owner, computerName) {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const base = recordingName(computerName);
    let file;
    let handle;
    for (let n = 1; !handle; n++) {
      file = path.join(this.dir, n === 1 ? `${base}.webm` : `${base} (${n}).webm`);
      try {
        handle = await fs.promises.open(file, 'wx');
      } catch (err) {
        if (err.code !== 'EEXIST' || n >= 50) throw err;
      }
    }
    const rec = { id: crypto.randomUUID(), owner, file, handle, head: Buffer.alloc(0), duration: null, startedAt: Date.now(), chain: Promise.resolve() };
    this.active.set(rec.id, rec);
    return { id: rec.id, name: path.basename(file) };
  }

  write(owner, id, bytes) {
    const rec = this._get(owner, id);
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_CHUNK) throw new Error('Invalid recording data');
    const chunk = Buffer.from(bytes);
    rec.chain = rec.chain.then(() => this._write(rec, chunk));
    return rec.chain;
  }

  async _write(rec, chunk) {
    if (!rec.head) {
      await rec.handle.write(chunk);
      return;
    }
    rec.head = Buffer.concat([rec.head, chunk]);
    const prepared = prepareWebmHead(rec.head);
    if (prepared === undefined && rec.head.length < HEAD_LIMIT) return;
    const out = prepared ? prepared.head : rec.head;
    if (prepared) rec.duration = { offset: prepared.offset, bytes: prepared.bytes, scale: prepared.scale };
    rec.head = null;
    await rec.handle.write(out);
  }

  // Finishes a recording. Returns where it was saved, or null when nothing was recorded.
  async stop(owner, id, durationMs) {
    const rec = this._get(owner, id);
    this.active.delete(id);
    return this._finish(rec, durationMs);
  }

  // The window that was recording closed: keep what it recorded.
  stopAll(owner) {
    const recs = [...this.active.values()].filter((r) => r.owner === owner);
    for (const rec of recs) this.active.delete(rec.id);
    return Promise.all(recs.map((rec) => this._finish(rec).catch(() => null)));
  }

  async _finish(rec, durationMs) {
    try {
      await rec.chain.catch(() => {});
      if (rec.head && rec.head.length) await rec.handle.write(rec.head);
      if (rec.duration) {
        const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : Date.now() - rec.startedAt;
        const bytes = durationBytes(ms, rec.duration);
        await rec.handle.write(bytes, 0, bytes.length, rec.duration.offset);
      }
    } finally {
      await rec.handle.close().catch(() => {});
    }
    const { size } = await fs.promises.stat(rec.file);
    if (!size) {
      await fs.promises.rm(rec.file, { force: true });
      return null;
    }
    return { file: rec.file, name: path.basename(rec.file), size };
  }

  _get(owner, id) {
    const rec = this.active.get(id);
    if (!rec || rec.owner !== owner) throw new Error('No such recording');
    return rec;
  }
}

module.exports = { Recordings, prepareWebmHead, recordingName };
