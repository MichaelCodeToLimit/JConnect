const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function decodeRdpFile(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.slice(2).toString('utf16le');
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.slice(3).toString('utf8');
  return buffer.toString('utf8');
}

function parseRdp(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^:]+):([isb]):(.*)$/.exec(line.trim());
    if (m) fields[m[1].trim().toLowerCase()] = m[3].trim();
  }
  const address = fields['full address'] || fields['alternate full address'] || '';
  if (!address) throw new Error('This file does not contain a computer address.');
  let host = address;
  let port = 3389;
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(address);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2]) port = Number(bracketed[2]);
  } else if ((address.match(/:/g) || []).length === 1) {
    [host, port] = [address.split(':')[0], Number(address.split(':')[1]) || 3389];
  }
  return { host, port, username: fields.username || null };
}

function importRdpFile(filePath) {
  const text = decodeRdpFile(fs.readFileSync(filePath));
  const parsed = parseRdp(text);
  const name = path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, ' ').trim() || parsed.host;
  return { name, rdp: { ...parsed, file: text } };
}

function which(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function launchRdp(computer, tempDir) {
  const { rdp } = computer;
  const file = path.join(tempDir, `${computer.id}.rdp`);
  fs.mkdirSync(tempDir, { recursive: true });

  if (process.platform === 'win32') {
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rdp.file, 'utf16le')]));
    spawn('mstsc.exe', [file], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    fs.writeFileSync(file, rdp.file);
    spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const client = ['xfreerdp3', 'xfreerdp', 'remmina'].find(which);
  if (!client) throw new Error('Install FreeRDP or Remmina to open Remote Desktop computers on Linux.');
  const target = `${rdp.host}:${rdp.port}`;
  const args = client === 'remmina' ? ['-c', `rdp://${target}`] : [`/v:${target}`, ...(rdp.username ? [`/u:${rdp.username}`] : []), '/dynamic-resolution'];
  spawn(client, args, { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { importRdpFile, launchRdp, parseRdp };
