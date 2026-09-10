const { EventEmitter } = require('events');

const WINDOW_MS = 10 * 60 * 1000;
const PAIRING_PAUSE_MS = 15 * 60 * 1000;

const DESCRIPTIONS = {
  'unknown-device': 'An unknown device tried to connect.',
  'bad-code': 'Someone entered a wrong pairing code.',
  'bad-password': 'Someone entered a wrong password.',
  'bad-signature': 'A connection failed a security check.',
  impersonation: 'A device tried to pretend to be one of your trusted devices.',
  'pairing-denied': 'A pairing request was declined.',
};

function describe(entry) {
  const who = entry.deviceName ? ` (${entry.deviceName})` : '';
  return `${DESCRIPTIONS[entry.kind] || 'Suspicious activity was detected.'}${who}`;
}

// Security confidence levels:
//   low    -> log and block the attempt
//   medium -> increase protection (pause pairing) and notify
//   high   -> terminate sessions, lock down remote access, notify
//             (and, if the user explicitly enabled it in Travel Mode, shut down safely)
class Security extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.failures = new Map();
    this.pairingPausedUntil = 0;
  }

  get travelMode() { return !!this.store.settings.travelMode; }
  get lockdown() { return this.store.data.lockdown; }

  _count(key) {
    const now = Date.now();
    const list = (this.failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
    list.push(now);
    this.failures.set(key, list);
    return list.length;
  }

  report(kind, details = {}) {
    const fromSource = this._count(`${kind}|${details.ip || '?'}`);
    const overall = this._count(`${kind}|*`);
    const strict = this.travelMode ? 0.5 : 1;

    let level = 'low';
    switch (kind) {
      case 'impersonation':
        level = 'high';
        break;
      case 'bad-signature':
        level = fromSource >= 3 ? 'high' : 'medium';
        break;
      case 'bad-code':
      case 'bad-password':
        if (overall >= 10 * strict) level = 'high';
        else if (fromSource >= (kind === 'bad-code' ? 3 : 5) * strict) level = 'medium';
        break;
      case 'unknown-device':
        level = this.travelMode && fromSource >= 3 ? 'medium' : 'low';
        break;
      default:
        level = 'low';
    }

    const entry = { kind, level, ip: details.ip, deviceName: details.deviceName, deviceId: details.deviceId, travelMode: this.travelMode };
    entry.message = describe(entry);
    this.store.log(entry);
    this.emit('event', entry);

    if (level === 'medium') {
      this.pairingPausedUntil = Date.now() + PAIRING_PAUSE_MS;
      this.emit('notify', entry);
    } else if (level === 'high') {
      this._lockdown(entry);
    }
    return level;
  }

  _lockdown(entry) {
    if (!this.lockdown) {
      this.store.update((d) => { d.lockdown = { at: Date.now(), kind: entry.kind, reason: entry.message }; });
      this.store.log({ kind: 'lockdown', level: 'high', message: 'Remote access was temporarily disabled.' });
      this.emit('lockdown', entry);
    }
    if (this.travelMode && this.store.settings.emergencyShutdown) this.emit('shutdown-requested', entry);
  }

  restore(by) {
    if (!this.lockdown) return;
    this.store.update((d) => { d.lockdown = null; });
    this.store.log({ kind: 'restored', level: 'info', message: `Remote access was restored${by ? ` by ${by}` : ''}.` });
    this.failures.clear();
    this.pairingPausedUntil = 0;
    this.emit('restored');
  }

  pairingAllowed() {
    return !this.travelMode && !this.lockdown && Date.now() >= this.pairingPausedUntil;
  }
}

module.exports = { Security };
