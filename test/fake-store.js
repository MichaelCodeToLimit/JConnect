// A stand-in for JConnect's store (src/main/store.js) with just what the account module uses.
const { EventEmitter } = require('events');
const nacl = require('tweetnacl');
const JCSecure = require('../src/shared/secure-channel');

const b64 = (u8) => Buffer.from(u8).toString('base64');

class FakeStore extends EventEmitter {
  constructor(name) {
    super();
    this.keyPair = nacl.sign.keyPair();
    this.publicKey = b64(this.keyPair.publicKey);
    this.id = JCSecure.deviceIdFromKey(this.publicKey);
    this.name = name;
    this.data = { settings: {}, computers: [], ssh: { hosts: [], keys: [], knownHosts: {} }, tombstones: { computers: {}, sshHosts: {} }, account: null, securityLog: [] };
  }
  device() { return { id: this.id, name: this.name, os: 'Windows 11', publicKey: this.publicKey }; }
  sign(text) { return b64(nacl.sign.detached(Buffer.from(String(text), 'utf8'), this.keyPair.secretKey)); }
  update(fn) { fn(this.data); this.emit('change'); }
  seal(text) { return text == null ? null : `test:${text}`; }
  unseal(value) { return typeof value === 'string' && value.startsWith('test:') ? value.slice(5) : null; }
  log(entry) { this.data.securityLog.unshift(entry); }
  addComputer(computer) { this.update((d) => { d.computers.push({ addedAt: Date.now(), updatedAt: Date.now(), ...computer }); }); }
}

module.exports = { FakeStore };
