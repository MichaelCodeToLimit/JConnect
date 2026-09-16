// A JConnect computer for testing the mobile apps: the real host agent (src/main/host.js) with an in-memory store and
// no screen. Pairing, trust and the encrypted channel are real.
//   node mobile/scripts/test-host.js [port]   prints "code <6 digits>" when ready, then "paired <device id>" per pairing
const crypto = require('crypto');
const { EventEmitter } = require('events');
const nacl = require('tweetnacl');
const { HostAgent } = require('../../src/main/host');
const { Security } = require('../../src/main/security');
const { deviceIdFromKey } = require('../../src/main/store');
const JCSecure = require('../../src/shared/secure-channel');

const b64 = (u8) => Buffer.from(u8).toString('base64');

class MemoryStore extends EventEmitter {
  constructor() {
    super();
    this.keyPair = nacl.sign.keyPair();
    this.publicKey = b64(this.keyPair.publicKey);
    this.id = deviceIdFromKey(this.publicKey);
    this.data = {
      settings: {
        remoteAccess: true, requirePassword: false, passwordHash: null, travelMode: false, travelOwnerOnly: true,
        emergencyShutdown: false, allowBrowserClients: true, accountTrust: false, shareSsh: false, shareRdp: false,
      },
      trusted: [],
      computers: [],
      securityLog: [],
      lockdown: null,
    };
  }
  get settings() { return this.data.settings; }
  device() { return { id: this.id, name: 'Test PC', os: 'Test', publicKey: this.publicKey }; }
  sign(text) { return b64(nacl.sign.detached(Buffer.from(String(text), 'utf8'), this.keyPair.secretKey)); }
  update(mutator) { mutator(this.data); this.emit('change'); }
  log(entry) { this.data.securityLog.unshift({ at: Date.now(), ...entry }); }
  findTrusted(publicKey) { return this.data.trusted.find((t) => t.publicKey === publicKey) || null; }
  addTrusted(device) {
    this.data.trusted = this.data.trusted.filter((t) => t.publicKey !== device.publicKey);
    this.data.trusted.push({ permission: 'control', owner: false, pairedAt: Date.now(), ...device });
    this.emit('paired', device);
  }
  updateTrusted(id, patch) { const t = this.data.trusted.find((x) => x.id === id); if (t) Object.assign(t, patch); }
  removeTrusted(id) { this.data.trusted = this.data.trusted.filter((t) => t.id !== id); }
  passwordSalt() { return String(this.settings.passwordHash || '').split(':')[1] || null; }
  checkPasswordProof(proof, th) {
    const parts = String(this.settings.passwordHash || '').split(':');
    if (parts.length < 3) return false;
    const expected = Buffer.from(JCSecure.passwordProof(new Uint8Array(Buffer.from(parts[2], 'base64')), th));
    const given = Buffer.from(String(proof), 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }
}

// No screen to share: sessions can be negotiated but carry no picture.
class NoCapture extends EventEmitter {
  displays() { return [{ id: '1', name: 'Display 1', primary: true, width: 1280, height: 720 }]; }
  async start() {}
  signal() {}
  stop() {}
  setQuality() {}
  setDisplay() {}
}

async function startTestHost(port = 0) {
  const store = new MemoryStore();
  const security = new Security(store);
  const input = { available: false, handle() {}, release() {} };
  const agent = new HostAgent({ store, security, input, capture: new NoCapture() });
  agent.askOwner = async () => ({ allow: false });
  await agent.listen(port);
  return { store, security, agent, port: agent.port, close: () => agent.close() };
}

module.exports = { startTestHost };

if (require.main === module) {
  startTestHost(Number(process.argv[2]) || 47811).then((host) => {
    console.log(`listening ${host.port}`);
    console.log(`code ${host.agent.pairingCode}`);
    host.store.on('paired', (device) => console.log(`paired ${device.id} ${device.name}`));
  });
}
