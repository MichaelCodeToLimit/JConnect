// The remote desktop view. The remote computer becomes the screen; JConnect gets out of the way.
(function (global) {
  'use strict';

  const { HostConnection, failure } = global.JConnectProtocol;

  const FATAL = new Set(['untrusted', 'revoked', 'identity', 'travel', 'disabled', 'locked', 'cancelled', 'ended-by-owner', 'gone', 'security', 'capture']);
  const RETRYABLE = new Set(['cancelled', 'ended-by-owner', 'disabled', 'locked', 'travel', 'capture']);
  const QUALITY_LABELS = [['auto', 'Automatic'], ['sharp', 'Sharp'], ['balanced', 'Balanced'], ['saver', 'Data saver']];

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* unavailable */ } },
  };

  const TEMPLATE = `
    <div class="jv">
      <video class="jv-video" autoplay playsinline tabindex="-1"></video>
      <div class="jv-bar" data-hidden="true">
        <button class="jv-btn jv-back" data-act="back" type="button"><span aria-hidden="true">←</span><span class="jv-name"></span></button>
        <button class="jv-btn" data-act="display" type="button">Display</button>
        <button class="jv-btn" data-act="devices" type="button">Devices</button>
        <button class="jv-btn" data-act="more" type="button" aria-label="More">⋯</button>
        <div class="jv-drag"></div>
        <button class="jv-btn jv-win" data-act="minimize" type="button" aria-label="Minimize">–</button>
        <button class="jv-btn jv-win" data-act="fullscreen" type="button" aria-label="Full screen">⛶</button>
        <button class="jv-btn jv-win" data-act="close" type="button" aria-label="Disconnect">✕</button>
      </div>
      <div class="jv-menu" hidden></div>
      <div class="jv-overlay" hidden>
        <div class="jv-card" role="dialog" aria-live="polite">
          <div class="jv-spinner" hidden></div>
          <h2 class="jv-title"></h2>
          <p class="jv-text"></p>
          <form class="jv-form" hidden><input class="jv-input" type="password" autocomplete="current-password" placeholder="Password"></form>
          <div class="jv-actions"></div>
        </div>
      </div>
      <div class="jv-toast" hidden></div>
      <button class="jv-pill" type="button" aria-label="Show controls" hidden></button>
      <textarea class="jv-kbd" aria-hidden="true" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
    </div>`;

  function statusWord(status) {
    switch (status && status.state) {
      case 'online': return 'Available';
      case 'sleeping': return 'Sleeping';
      case 'waking': return 'Waking';
      case 'lockdown': return 'Locked';
      case 'checking': return '';
      default: return 'Offline';
    }
  }

  class JConnectViewer {
    constructor(root, adapter) {
      this.root = root;
      this.adapter = adapter;
      this.quality = storage.get('jc.quality') || 'auto';
      this.displayId = null;
      this.displays = [];
      this.password = null;
      this.stopped = false;
      this.live = false;
      this.looping = false;
      this.wasLive = false;
      this.hostDown = null;
      this.permission = 'control';
      this.pressedKeys = new Set();
      this.wheel = { dx: 0, dy: 0 };
      this.touches = new Map();
      this.zoom = { scale: 1, x: 0, y: 0 };
      this.touchMode = !!(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);
      this.cleanups = [];
      this._menuItems = [];
      this._actions = [];
      this.build();
    }

    build() {
      this.root.innerHTML = TEMPLATE;
      const q = (s) => this.root.querySelector(s);
      this.dom = {
        app: q('.jv'), video: q('.jv-video'), bar: q('.jv-bar'), name: q('.jv-name'), menu: q('.jv-menu'),
        overlay: q('.jv-overlay'), spinner: q('.jv-spinner'), title: q('.jv-title'), text: q('.jv-text'),
        form: q('.jv-form'), input: q('.jv-input'), actions: q('.jv-actions'), toast: q('.jv-toast'),
        pill: q('.jv-pill'), kbd: q('.jv-kbd'),
      };
      this.dom.video.muted = !this.adapter.electron;
      if (!this.adapter.electron) {
        q('[data-act="devices"]').hidden = true;
        q('[data-act="minimize"]').hidden = true;
      }
      if (this.touchMode) this.dom.pill.hidden = false;
      this.dom.form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (this._onSubmit) this._onSubmit();
      });
      this.dom.actions.addEventListener('click', (e) => {
        const button = e.target.closest('button');
        const action = button && this._actions[Number(button.dataset.index)];
        if (action) action[1]();
      });
    }

    listen(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      this.cleanups.push(() => target.removeEventListener(type, fn, options));
    }

    async start() {
      this.bindPointer();
      this.bindKeyboard();
      this.bindBar();
      this.bindTouchKeyboard();
      try { this.target = await this.adapter.target(); } catch { this.target = null; }
      if (!this.target) {
        this.fatal('gone');
        return;
      }
      this.dom.name.textContent = this.target.name;
      document.title = this.target.name;
      this.overlay({ title: `Connecting to ${this.target.name}…`, spinner: true });
      this.loop();
    }

    // ---- connection lifecycle ----

    async loop() {
      if (this.looping || this.stopped) return;
      this.looping = true;
      const startedAt = Date.now();
      const { name } = this.target;
      let attempt = 0;
      let wakeAt = 0;
      const wake = () => {
        wakeAt = Date.now();
        if (this.adapter.wake) this.adapter.wake();
      };

      while (!this.stopped) {
        let code;
        try {
          await this.connectOnce();
          break;
        } catch (err) {
          code = err.code || 'unreachable';
          if (code === 'lockdown-owner') {
            this.looping = false;
            this.lockdownCard(err.conn, err.lockdown);
            return;
          }
          this.teardown();
          if (this.stopped) break;
          if (FATAL.has(code)) {
            this.looping = false;
            this.fatal(code);
            return;
          }
        }

        attempt += 1;
        if (code === 'wakeable' && !wakeAt && this.hostDown !== 'security-shutdown' && this.adapter.wake) wake();
        const elapsed = Date.now() - startedAt;

        if (this.hostDown === 'security-shutdown') {
          const actions = [['Keep Offline', () => this.exit()]];
          if (this.adapter.wake && this.target.canWake) actions.push(['Turn Back On', () => { this.hostDown = null; wake(); this.retryNow(); }, true]);
          this.overlay({ title: `🔒 ${name} is offline`, text: 'JConnect shut down the computer according to your Travel Mode security policy.', actions });
        } else if (wakeAt && Date.now() - wakeAt < 120000) {
          this.overlay({ title: `Waking ${name}…`, spinner: true, actions: [['Cancel', () => this.exit()]] });
        } else if (this.hostDown === 'shutdown') {
          this.overlay({ title: `${name} was turned off.`, text: 'JConnect will reconnect when it is back.', spinner: true, actions: [['Close', () => this.exit()]] });
        } else if (this.hostDown === 'sleep') {
          this.overlay({ title: `${name} went to sleep.`, text: 'JConnect will reconnect when it wakes up.', spinner: true, actions: [['Close', () => this.exit()]] });
        } else if (elapsed < (this.wasLive ? 15000 : 7000)) {
          this.overlay(this.wasLive
            ? { title: 'Connection interrupted', text: 'Reconnecting…', spinner: true }
            : { title: `Connecting to ${name}…`, spinner: true });
        } else {
          this.overlay({
            title: `${name} isn't reachable right now.`,
            text: 'JConnect will keep trying automatically.',
            actions: [['Close', () => this.exit()], ['Try Again', () => this.retryNow(), true]],
          });
        }
        await this.pause(Math.min(5000, 600 * attempt));
      }
      this.looping = false;
    }

    pause(ms) {
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          if (this._resume === done) this._resume = null;
          resolve();
        };
        const timer = setTimeout(done, ms);
        this._resume = done;
      });
    }

    retryNow() {
      if (this.stopped) return;
      this.overlay({ title: `Connecting to ${this.target.name}…`, spinner: true });
      if (this.looping && this._resume) this._resume();
      else if (!this.looping) this.loop();
    }

    async connectOnce() {
      const route = await this.adapter.resolve();
      if (!route || route.unreachable) {
        if (route && route.lastState === 'security-shutdown') this.hostDown = 'security-shutdown';
        throw failure(route && route.gone ? 'gone' : route && route.wakeable ? 'wakeable' : 'unreachable');
      }

      const conn = new HostConnection(route.url, this.adapter);
      this.conn = conn;
      const hello = await conn.open();
      if (this.target.publicKey && hello.publicKey !== this.target.publicKey) throw failure('identity');

      let auth = await conn.authenticate({ password: this.password || undefined });
      while (!auth.ok && (auth.reason === 'password-required' || auth.reason === 'password')) {
        const password = await this.askPassword(auth.reason === 'password');
        if (password == null) throw failure('cancelled');
        this.password = password;
        this.overlay({ title: `Connecting to ${this.target.name}…`, spinner: true });
        auth = await conn.authenticate({ password });
      }
      if (!auth.ok) throw failure(auth.reason || 'unreachable');
      if (auth.locked) throw failure(auth.owner ? 'lockdown-owner' : 'locked', { conn, lockdown: auth.lockdown });

      this.permission = auth.permission || 'control';
      conn.on('notice', (m) => this.onNotice(m));
      conn.on('closed', () => { if (this.conn === conn) this.drop(); });

      const sessionReply = conn.next(['session', 'session-denied'], 10000);
      conn.send('session-start', { displayId: this.displayId, quality: this.quality });
      const session = await sessionReply;
      if (session.type === 'session-denied') throw failure(session.reason === 'locked' ? 'locked' : 'capture');
      this.displays = session.displays || [];
      this.displayId = session.displayId;
      this.permission = session.permission || this.permission;
      if (session.inputAvailable === false && this.permission === 'control') {
        setTimeout(() => this.toast(`${this.target.name} can be viewed, but remote control isn't available on it.`), 1500);
      }

      const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
      this.pc = pc;
      const pendingIce = [];
      let remoteSet = false;
      conn.on('ice', (m) => {
        if (!m.candidate) return;
        if (remoteSet) pc.addIceCandidate(m.candidate).catch(() => {});
        else pendingIce.push(m.candidate);
      });
      pc.onicecandidate = (e) => { if (e.candidate) conn.send('ice', { candidate: e.candidate.toJSON() }); };
      pc.ontrack = (e) => {
        const stream = e.streams[0] || new MediaStream([e.track]);
        if (this.dom.video.srcObject !== stream) this.dom.video.srcObject = stream;
        this.dom.video.play().catch(() => {});
      };
      pc.ondatachannel = (e) => { this.dc = e.channel; };

      const offer = await conn.next(['offer'], 15000);
      if (!(await conn.verifySdp(offer.sdp, offer.sig))) throw failure('security');
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      remoteSet = true;
      for (const candidate of pendingIce.splice(0)) pc.addIceCandidate(candidate).catch(() => {});
      await pc.setLocalDescription(await pc.createAnswer());
      conn.send('answer', { sdp: pc.localDescription.sdp, sig: await conn.signSdp(pc.localDescription.sdp) });

      await Promise.race([
        this.waitConnected(pc, 15000),
        conn.whenClosed.then(() => { throw failure('closed'); }),
      ]);
      for (const receiver of pc.getReceivers()) {
        try { receiver.playoutDelayHint = 0; } catch { /* unsupported */ }
        try { receiver.jitterBufferTarget = 0; } catch { /* unsupported */ }
      }
      pc.onconnectionstatechange = () => this.onPeerState();
      this.goLive(conn);
    }

    waitConnected(pc, ms) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(failure('unreachable')), ms);
        const check = () => {
          if (pc.connectionState === 'connected') {
            clearTimeout(timer);
            resolve();
          } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            clearTimeout(timer);
            reject(failure('unreachable'));
          }
        };
        pc.addEventListener('connectionstatechange', check);
        check();
      });
    }

    goLive(conn) {
      this.live = true;
      this.wasLive = true;
      this.hostDown = null;
      this.hideOverlay();
      this.showBar(2500);
      this.statsTimer = setInterval(() => this.collectStats(), 2000);
      this.watchdog = setInterval(() => {
        if (Date.now() - conn.lastMessageAt > 16000) this.drop();
      }, 4000);
      if (this.adapter.report) this.adapter.report('live', { quality: this.quality });
    }

    onPeerState() {
      const { pc } = this;
      if (!pc || !this.live) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.drop();
      } else if (pc.connectionState === 'disconnected') {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => {
          if (this.pc === pc && pc.connectionState !== 'connected') this.drop();
        }, 4000);
      }
    }

    drop() {
      if (!this.live) return;
      this.teardown();
      if (this.stopped) return;
      this.overlay({ title: 'Connection interrupted', text: 'Reconnecting…', spinner: true });
      this.loop();
    }

    teardown() {
      clearInterval(this.statsTimer);
      clearInterval(this.watchdog);
      clearTimeout(this.disconnectTimer);
      this.releaseKeys();
      this.live = false;
      if (this.dc) {
        try { this.dc.close(); } catch { /* closed */ }
        this.dc = null;
      }
      if (this.pc) {
        try { this.pc.close(); } catch { /* closed */ }
        this.pc = null;
      }
      if (this.conn) {
        const { conn } = this;
        this.conn = null;
        conn.close();
      }
    }

    onNotice(m) {
      switch (m.kind) {
        case 'revoked': this.end('revoked'); break;
        case 'ended-by-owner': this.end('ended-by-owner'); break;
        case 'lockdown': this.end('locked'); break;
        case 'travel-mode': this.end('travel'); break;
        case 'disabled': this.end('disabled'); break;
        case 'host-shutdown': this.hostDown = m.reason === 'security' ? 'security-shutdown' : 'shutdown'; break;
        case 'host-sleep': this.hostDown = 'sleep'; break;
        case 'permission':
          this.permission = m.permission;
          if (m.permission === 'view') this.releaseKeys();
          this.toast(m.permission === 'view' ? 'You can view this computer, but not control it.' : 'You can control this computer again.');
          break;
        case 'display-changed': this.displayId = m.displayId; break;
        case 'security-alert':
          if (m.lockdown) {
            const { conn } = this;
            this.conn = null;
            this.teardownMedia();
            this.lockdownCard(conn, m.lockdown);
          } else {
            this.toast(m.message || 'JConnect noticed unusual activity.');
          }
          break;
        default:
      }
    }

    teardownMedia() {
      const { conn } = this;
      this.conn = null;
      this.teardown();
      this.conn = conn;
    }

    end(code) {
      this.teardown();
      this.fatal(code);
    }

    fatal(code) {
      const name = this.target ? this.target.name : 'This computer';
      const messages = {
        untrusted: [`This device isn't paired with ${name}.`, 'Pair it again from the JConnect home screen.'],
        revoked: [`Access to ${name} was removed.`, 'Ask the owner to pair this device again.'],
        identity: ["This doesn't look like the same computer.", 'JConnect stopped to keep you safe. If JConnect was reinstalled there, remove it and pair again.'],
        travel: [`${name} is in Travel Mode.`, "Only its owner's devices can connect right now."],
        disabled: [`Remote access is turned off on ${name}.`, ''],
        locked: [`🔒 ${name} is in Emergency Lockdown.`, 'Remote access has been temporarily disabled.'],
        cancelled: ['Connection cancelled.', ''],
        'ended-by-owner': [`The owner of ${name} ended this session.`, ''],
        gone: ['This computer is no longer in your list.', ''],
        security: [`JConnect couldn't verify ${name}.`, 'The connection was stopped to keep you safe.'],
        capture: [`${name} couldn't share its screen.`, 'Try again in a moment.'],
      };
      const [title, text] = messages[code] || [`Couldn't connect to ${name}.`, ''];
      const actions = [['Close', () => this.exit()]];
      if (RETRYABLE.has(code)) actions.push(['Try Again', () => this.retryNow(), true]);
      this.overlay({ title, text, actions });
    }

    lockdownCard(conn, lockdown) {
      const { name } = this.target;
      this.conn = conn;
      this.overlay({
        title: `🔒 ${name} — Emergency Lockdown`,
        text: `${(lockdown && lockdown.reason) || 'Suspicious activity was detected.'} Remote access has been temporarily disabled.`,
        actions: [
          ['Keep Locked', () => this.exit()],
          ['Restore Remote Access', async () => {
            this.overlay({ title: 'Restoring remote access…', spinner: true });
            const reply = conn.next(['restored'], 8000);
            conn.send('owner-restore');
            try { await reply; } catch { /* reconnect decides */ }
            conn.close();
            this.conn = null;
            this.loop();
          }, true],
        ],
      });
    }

    askPassword(wrong) {
      return new Promise((resolve) => {
        const submit = () => {
          const value = this.dom.input.value;
          this.dom.input.value = '';
          resolve(value || null);
        };
        this.overlay({
          title: `${this.target.name} is protected with a password`,
          text: wrong ? "That password didn't work. Try again." : 'Enter the password to connect.',
          password: true,
          onSubmit: submit,
          actions: [['Cancel', () => resolve(null)], ['Connect', submit, true]],
        });
      });
    }

    exit() {
      if (this.stopped) return;
      this.stopped = true;
      if (this.conn && this.live) this.conn.send('session-end');
      this.teardown();
      if (this._resume) this._resume();
      for (const off of this.cleanups.splice(0)) off();
      this.adapter.exit();
    }

    // ---- overlay, toast ----

    overlay({ title, text = '', spinner = false, actions = [], password = false, onSubmit = null }) {
      this._actions = actions;
      this._onSubmit = onSubmit;
      const key = JSON.stringify([title, text, spinner, password, actions.map((a) => a[0])]);
      if (key === this._overlayKey && !this.dom.overlay.hidden) return;
      this._overlayKey = key;
      if (this.adapter.report) this.adapter.report('overlay', { title, text });
      this.closeMenu();
      this.dom.overlay.hidden = false;
      this.dom.title.textContent = title;
      this.dom.text.textContent = text;
      this.dom.text.hidden = !text;
      this.dom.spinner.hidden = !spinner;
      this.dom.form.hidden = !password;
      this.dom.actions.replaceChildren(...actions.map(([label, , primary], index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = primary ? 'jv-action primary' : 'jv-action';
        button.textContent = label;
        button.dataset.index = String(index);
        return button;
      }));
      if (password) setTimeout(() => this.dom.input.focus(), 50);
    }

    hideOverlay() {
      this.dom.overlay.hidden = true;
      this._overlayKey = null;
    }

    toast(message) {
      this.dom.toast.textContent = message;
      this.dom.toast.hidden = false;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { this.dom.toast.hidden = true; }, 4000);
    }

    // ---- input ----

    sendInput(msg) {
      if (!this.live || !this.dc || this.dc.readyState !== 'open' || this.permission !== 'control') return;
      try { this.dc.send(JSON.stringify(msg)); } catch { /* channel closing */ }
    }

    point(e) {
      const video = this.dom.video;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      const r = video.getBoundingClientRect();
      const scale = Math.min(r.width / vw, r.height / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      const x = (e.clientX - (r.left + (r.width - dw) / 2)) / dw;
      const y = (e.clientY - (r.top + (r.height - dh) / 2)) / dh;
      const clamp = (v) => Math.round(Math.min(1, Math.max(0, v)) * 100000) / 100000;
      return { x: clamp(x), y: clamp(y) };
    }

    queueMove(p) {
      this.pendingMove = p;
      if (this.moveFrame) return;
      this.moveFrame = requestAnimationFrame(() => {
        this.moveFrame = 0;
        if (this.pendingMove) this.sendInput({ t: 'm', x: this.pendingMove.x, y: this.pendingMove.y });
        this.pendingMove = null;
      });
    }

    flushWheel() {
      if (this.wheelFrame) return;
      this.wheelFrame = requestAnimationFrame(() => {
        this.wheelFrame = 0;
        const dx = Math.trunc(this.wheel.dx);
        const dy = Math.trunc(this.wheel.dy);
        if (dx || dy) this.sendInput({ t: 'w', dx, dy });
        this.wheel.dx -= dx;
        this.wheel.dy -= dy;
      });
    }

    click(p, button) {
      this.sendInput({ t: 'm', x: p.x, y: p.y });
      this.sendInput({ t: 'b', b: button, d: 1, x: p.x, y: p.y });
      this.sendInput({ t: 'b', b: button, d: 0, x: p.x, y: p.y });
    }

    unmute() {
      const { video } = this.dom;
      if (video.muted && !this.adapter.electron) {
        video.muted = false;
        video.play().catch(() => {});
      }
    }

    bindPointer() {
      const video = this.dom.video;
      video.addEventListener('contextmenu', (e) => e.preventDefault());
      video.addEventListener('auxclick', (e) => e.preventDefault());
      video.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') {
          this.touchMove(e);
          return;
        }
        if (e.clientY <= 2) this.showBar();
        const p = this.point(e);
        if (p) this.queueMove(p);
      });
      video.addEventListener('pointerdown', (e) => {
        this.unmute();
        if (e.pointerType === 'touch') {
          this.touchStart(e);
          return;
        }
        e.preventDefault();
        this.closeMenu();
        try { video.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        const p = this.point(e);
        if (p) this.sendInput({ t: 'b', b: e.button, d: 1, x: p.x, y: p.y });
      });
      const up = (e) => {
        if (e.pointerType === 'touch') {
          this.touchEnd(e);
          return;
        }
        const p = this.point(e);
        this.sendInput(p ? { t: 'b', b: e.button, d: 0, x: p.x, y: p.y } : { t: 'b', b: e.button, d: 0 });
      };
      video.addEventListener('pointerup', up);
      video.addEventListener('pointercancel', up);
      video.addEventListener('wheel', (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
        this.wheel.dx += e.deltaX * unit * 1.2;
        this.wheel.dy += e.deltaY * unit * 1.2;
        this.flushWheel();
      }, { passive: false });
    }

    touchStart(e) {
      e.preventDefault();
      try { this.dom.video.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 1) {
        this.tap = { id: e.pointerId, sx: e.clientX, sy: e.clientY, p: this.point(e), moved: false, down: false, done: false };
        clearTimeout(this.longPress);
        this.longPress = setTimeout(() => {
          const t = this.tap;
          if (t && !t.moved && t.p) {
            t.done = true;
            this.click(t.p, 2);
            if (navigator.vibrate) navigator.vibrate(15);
          }
        }, 550);
      } else if (this.touches.size === 2) {
        clearTimeout(this.longPress);
        if (this.tap && this.tap.down) this.sendInput({ t: 'b', b: 0, d: 0 });
        this.tap = null;
        const [a, b] = [...this.touches.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.gesture = { mode: null, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid, lastMid: mid, zoom: { ...this.zoom } };
      }
    }

    touchMove(e) {
      if (!this.touches.has(e.pointerId)) return;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const t = this.tap;
      if (this.touches.size === 1 && t && t.id === e.pointerId && !t.done) {
        if (!t.moved && Math.hypot(e.clientX - t.sx, e.clientY - t.sy) > 10) {
          t.moved = true;
          clearTimeout(this.longPress);
          if (t.p) {
            this.sendInput({ t: 'm', x: t.p.x, y: t.p.y });
            this.sendInput({ t: 'b', b: 0, d: 1, x: t.p.x, y: t.p.y });
            t.down = true;
          }
        }
        if (t.down) {
          const p = this.point(e);
          if (p) this.queueMove(p);
        }
        return;
      }
      const g = this.gesture;
      if (this.touches.size !== 2 || !g) return;
      const [a, b] = [...this.touches.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (!g.mode) {
        if (Math.abs(dist / g.dist - 1) > 0.12) g.mode = 'zoom';
        else if (Math.hypot(mid.x - g.mid.x, mid.y - g.mid.y) > 12) g.mode = 'scroll';
      }
      if (g.mode === 'zoom') {
        const scale = Math.min(4, Math.max(1, (g.zoom.scale * dist) / g.dist));
        const k = scale / g.zoom.scale;
        this.setZoom(scale, mid.x - (g.mid.x - g.zoom.x) * k, mid.y - (g.mid.y - g.zoom.y) * k);
      } else if (g.mode === 'scroll') {
        this.wheel.dx -= (mid.x - g.lastMid.x) * 3;
        this.wheel.dy -= (mid.y - g.lastMid.y) * 3;
        this.flushWheel();
      }
      g.lastMid = mid;
    }

    touchEnd(e) {
      if (!this.touches.has(e.pointerId)) return;
      this.touches.delete(e.pointerId);
      clearTimeout(this.longPress);
      const t = this.tap;
      if (t && t.id === e.pointerId) {
        if (t.down) {
          const p = this.point(e);
          this.sendInput(p ? { t: 'b', b: 0, d: 0, x: p.x, y: p.y } : { t: 'b', b: 0, d: 0 });
        } else if (!t.done && !t.moved && t.p) {
          this.click(t.p, 0);
        }
        this.tap = null;
      }
      if (this.touches.size < 2) this.gesture = null;
    }

    setZoom(scale, x, y) {
      const w = this.dom.app.clientWidth;
      const h = this.dom.app.clientHeight;
      const cx = Math.min(0, Math.max(w - w * scale, x));
      const cy = Math.min(0, Math.max(h - h * scale, y));
      this.zoom = { scale, x: cx, y: cy };
      this.dom.video.style.transform = scale === 1 ? '' : `translate(${cx}px, ${cy}px) scale(${scale})`;
    }

    bindKeyboard() {
      this.listen(window, 'keydown', (e) => this.onKey(e, true), true);
      this.listen(window, 'keyup', (e) => this.onKey(e, false), true);
      this.listen(window, 'blur', () => this.releaseKeys());
    }

    onKey(e, down) {
      if (down && e.ctrlKey && e.altKey && e.code === 'Home') {
        e.preventDefault();
        this.toggleBar();
        return;
      }
      if (!this.live || !this.dom.overlay.hidden || e.target === this.dom.kbd) return;
      if (!this.dom.menu.hidden) {
        if (down && e.code === 'Escape') {
          e.preventDefault();
          this.closeMenu();
        }
        return;
      }
      if (!e.code || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (down) this.pressedKeys.add(e.code);
      else this.pressedKeys.delete(e.code);
      this.sendInput({ t: 'k', c: e.code, d: down ? 1 : 0 });
    }

    tapKey(code) {
      this.sendInput({ t: 'k', c: code, d: 1 });
      this.sendInput({ t: 'k', c: code, d: 0 });
    }

    releaseKeys() {
      for (const code of this.pressedKeys) this.sendInput({ t: 'k', c: code, d: 0 });
      this.pressedKeys.clear();
    }

    // On-screen keyboards: keep two spaces in a hidden field so deletions can always be detected.
    bindTouchKeyboard() {
      const field = this.dom.kbd;
      const SENTINEL = '  ';
      const reset = () => {
        field.value = SENTINEL;
        field.setSelectionRange(SENTINEL.length, SENTINEL.length);
      };
      field.addEventListener('input', () => {
        const value = field.value;
        if (value.length < SENTINEL.length) {
          for (let i = value.length; i < SENTINEL.length; i++) this.tapKey('Backspace');
        } else {
          const typed = value.slice(SENTINEL.length);
          const parts = typed.split('\n');
          parts.forEach((part, i) => {
            if (part) this.sendInput({ t: 'x', s: part });
            if (i < parts.length - 1) this.tapKey('Enter');
          });
        }
        reset();
      });
      field.addEventListener('keydown', (e) => {
        const special = ['Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
        if (special.includes(e.key)) {
          e.preventDefault();
          this.tapKey(e.code || e.key);
        }
      });
      this.openKeyboard = () => {
        reset();
        field.focus();
      };
    }

    // ---- controls bar ----

    bindBar() {
      const { bar, menu, pill } = this.dom;
      bar.addEventListener('click', (e) => {
        const button = e.target.closest('[data-act]');
        if (button) this.action(button.dataset.act, button);
      });
      bar.addEventListener('pointerenter', () => clearTimeout(this.barTimer));
      bar.addEventListener('pointerleave', () => { if (menu.hidden) this.hideBarSoon(900); });
      pill.addEventListener('click', () => this.toggleBar());
      menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-index]');
        const entry = item && this._menuItems[Number(item.dataset.index)];
        this.closeMenu();
        if (entry && entry.run) entry.run();
      });
      this.listen(document, 'pointerdown', (e) => {
        if (!menu.hidden && !menu.contains(e.target) && !bar.contains(e.target)) this.closeMenu();
      }, true);
    }

    showBar(autoHideMs) {
      this.dom.bar.dataset.hidden = 'false';
      this.dom.pill.hidden = true;
      clearTimeout(this.barTimer);
      if (autoHideMs) this.hideBarSoon(autoHideMs);
    }

    hideBarSoon(ms) {
      clearTimeout(this.barTimer);
      this.barTimer = setTimeout(() => this.hideBar(), ms);
    }

    hideBar() {
      if (!this.dom.menu.hidden) return;
      this.dom.bar.dataset.hidden = 'true';
      if (this.touchMode) this.dom.pill.hidden = false;
    }

    toggleBar() {
      if (this.dom.bar.dataset.hidden === 'true') {
        this.showBar(this.touchMode ? 5000 : 0);
      } else {
        this.closeMenu();
        this.hideBar();
      }
    }

    action(act, button) {
      switch (act) {
        case 'back':
        case 'close':
          this.exit();
          break;
        case 'display':
          this.openMenu(button, this.displays.length > 1
            ? this.displays.map((d, i) => ({
              label: d.name || `Display ${i + 1}`,
              sub: `${d.width}×${d.height}`,
              checked: d.id === this.displayId,
              run: () => this.setDisplay(d.id),
            }))
            : [{ label: 'This computer has one display', disabled: true }]);
          break;
        case 'devices':
          this.openDevices(button);
          break;
        case 'more':
          this.openMore(button);
          break;
        case 'minimize':
          if (this.adapter.windowAction) this.adapter.windowAction('minimize');
          break;
        case 'fullscreen':
          this.toggleFullscreen();
          break;
        default:
      }
    }

    async openDevices(button) {
      const list = this.adapter.computers ? await this.adapter.computers() : [];
      const items = list.filter((c) => c.type !== 'rdp').map((c) => ({
        label: c.name,
        sub: c.id === this.target.id ? 'Connected' : statusWord(c.status),
        checked: c.id === this.target.id,
        disabled: c.id === this.target.id,
        run: () => {
          this.stopped = true;
          if (this.conn && this.live) this.conn.send('session-end');
          this.teardown();
          this.adapter.switchTo(c.id);
        },
      }));
      this.openMenu(button, items.length ? items : [{ label: 'No other computers', disabled: true }]);
    }

    openMore(button) {
      const items = [{ heading: 'Quality' }];
      for (const [value, label] of QUALITY_LABELS) {
        items.push({ label, checked: this.quality === value, run: () => this.setQuality(value) });
      }
      items.push({ separator: true });
      if (this.touchMode) items.push({ label: 'Keyboard', run: () => this.openKeyboard() });
      if (this.zoom.scale > 1) items.push({ label: 'Reset zoom', run: () => this.setZoom(1, 0, 0) });
      items.push({ label: 'Full screen', run: () => this.toggleFullscreen() });
      if (!this.touchMode) items.push({ label: 'Ctrl+Alt+Home shows these controls', disabled: true, small: true });
      items.push({ separator: true });
      items.push({ label: 'Disconnect', danger: true, run: () => this.exit() });
      this.openMenu(button, items);
    }

    openMenu(anchor, items) {
      const { menu } = this.dom;
      this._menuItems = items;
      menu.replaceChildren(...items.map((item, index) => {
        if (item.separator) {
          const sep = document.createElement('div');
          sep.className = 'jv-sep';
          return sep;
        }
        if (item.heading) {
          const heading = document.createElement('div');
          heading.className = 'jv-heading';
          heading.textContent = item.heading;
          return heading;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `jv-item${item.danger ? ' danger' : ''}${item.small ? ' small' : ''}`;
        button.disabled = !!item.disabled;
        button.dataset.index = String(index);
        const check = document.createElement('span');
        check.className = 'jv-check';
        check.textContent = item.checked ? '✓' : '';
        const label = document.createElement('span');
        label.textContent = item.label;
        button.append(check, label);
        if (item.sub) {
          const sub = document.createElement('span');
          sub.className = 'jv-sub';
          sub.textContent = item.sub;
          button.append(sub);
        }
        return button;
      }));
      menu.hidden = false;
      clearTimeout(this.barTimer);
      const rect = anchor.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${rect.bottom + 6}px`;
    }

    closeMenu() {
      if (this.dom.menu.hidden) return;
      this.dom.menu.hidden = true;
      if (!this.dom.bar.matches(':hover')) this.hideBarSoon(1200);
    }

    setDisplay(id) {
      this.displayId = id;
      this.releaseKeys();
      if (this.conn) this.conn.send('display', { displayId: id });
    }

    setQuality(value) {
      this.quality = value;
      storage.set('jc.quality', value);
      if (this.conn) this.conn.send('quality', { quality: value });
    }

    toggleFullscreen() {
      if (this.adapter.windowAction) {
        this.adapter.windowAction('fullscreen');
      } else if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (this.dom.app.requestFullscreen) {
        this.dom.app.requestFullscreen().catch(() => {});
      }
    }

    async collectStats() {
      if (!this.pc) return;
      try {
        const report = await this.pc.getStats();
        let video = null;
        let pair = null;
        report.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') video = s;
          if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
        });
        if (!video) return;
        this.lastStats = {
          framesDecoded: video.framesDecoded,
          fps: video.framesPerSecond,
          width: video.frameWidth,
          height: video.frameHeight,
          rtt: pair ? pair.currentRoundTripTime : null,
        };
        if (this.adapter.report) this.adapter.report('stats', this.lastStats);
      } catch { /* connection closing */ }
    }
  }

  global.JConnectViewer = JConnectViewer;
})(window);
