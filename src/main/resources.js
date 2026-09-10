const os = require('os');
const { EventEmitter } = require('events');
const { powerMonitor } = require('electron');

const LEVELS = ['saver', 'balanced', 'sharp'];

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, value] of Object.entries(cpu.times)) {
      total += value;
      if (kind === 'idle') idle += value;
    }
  }
  return { idle, total };
}

// Decides how much work streaming is allowed to do. JConnect lowers its own workload first;
// it never closes other applications.
class ResourceMonitor extends EventEmitter {
  constructor(isTravelMode) {
    super();
    this.isTravelMode = isTravelMode;
    this.thermal = 'nominal';
    this.speedLimit = 100;
    this.cpuStep = 2;
    this.cpu = 0;
    this.hot = 0;
    this.cool = 0;
    this.level = 'sharp';
  }

  start() {
    this.prev = cpuTimes();
    this.timer = setInterval(() => this._sample(), 5000);
    powerMonitor.on('thermal-state-change', (a, b) => {
      this.thermal = typeof a === 'string' ? a : (a && a.state) || b || 'nominal';
      this.update();
    });
    powerMonitor.on('speed-limit-change', (a, b) => {
      const limit = typeof a === 'number' ? a : (a && a.limit) ?? b;
      if (typeof limit === 'number') this.speedLimit = limit;
      this.update();
    });
    powerMonitor.on('on-battery', () => this.update());
    powerMonitor.on('on-ac', () => this.update());
  }

  _sample() {
    const now = cpuTimes();
    const total = now.total - this.prev.total;
    this.cpu = total > 0 ? 1 - (now.idle - this.prev.idle) / total : 0;
    this.prev = now;
    if (this.cpu > 0.9) { this.hot++; this.cool = 0; } else if (this.cpu < 0.6) { this.cool++; this.hot = 0; } else { this.hot = 0; this.cool = 0; }
    if (this.hot >= 3 && this.cpuStep > 0) { this.cpuStep--; this.hot = 0; }
    if (this.cool >= 12 && this.cpuStep < 2) { this.cpuStep++; this.cool = 0; }
    this.update();
  }

  update() {
    let cap = this.cpuStep;
    if (this.thermal === 'serious' || this.thermal === 'critical') cap = 0;
    else if (this.thermal === 'fair') cap = Math.min(cap, 1);
    // Windows reports a low "speed limit" whenever cores are idle or parked, so there it only counts
    // alongside real CPU pressure. On macOS it reflects actual thermal throttling.
    const throttled = process.platform === 'darwin' || this.cpu > 0.7;
    if (throttled && this.speedLimit < 70) cap = 0;
    else if (throttled && this.speedLimit < 90) cap = Math.min(cap, 1);
    if (this.isTravelMode()) {
      cap = Math.min(cap, 1);
      if (powerMonitor.isOnBatteryPower()) cap = 0;
    }
    const level = LEVELS[cap];
    if (level !== this.level) {
      this.level = level;
      this.emit('change', level);
    }
  }

  snapshot() {
    return { level: this.level, cpu: Math.round(this.cpu * 100), thermal: this.thermal, speedLimit: this.speedLimit };
  }
}

module.exports = { ResourceMonitor };
