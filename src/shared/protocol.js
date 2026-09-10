// Client side of the JConnect handshake. Used by the desktop app and the browser client.
(function (global) {
  'use strict';

  const AUTH = 'jconnect-auth:';
  const HOST = 'jconnect-host:';
  const SDP = 'jconnect-sdp:';

  function nonce() {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function failure(code, extra) {
    const err = new Error(code);
    err.code = code;
    return Object.assign(err, extra);
  }

  class HostConnection {
    constructor(url, adapter) {
      this.url = url;
      this.adapter = adapter;
      this.listeners = new Map();
      this.waiters = new Set();
      this.hello = null;
      this.isClosed = false;
      this.lastNonce = null;
      this.lastMessageAt = Date.now();
      this.whenClosed = new Promise((resolve) => { this._resolveClosed = resolve; });
    }

    open(timeoutMs = 6000) {
      return new Promise((resolve, reject) => {
        let ws;
        try {
          ws = new WebSocket(this.url);
        } catch {
          reject(failure('unreachable'));
          return;
        }
        this.ws = ws;
        const timer = setTimeout(() => {
          reject(failure('unreachable'));
          this.close();
        }, timeoutMs);

        ws.onmessage = (event) => {
          let msg;
          try { msg = JSON.parse(event.data); } catch { return; }
          if (!msg || typeof msg.type !== 'string') return;
          this.lastMessageAt = Date.now();
          if (msg.type === 'hello' && !this.hello) {
            clearTimeout(timer);
            this.hello = msg;
            resolve(msg);
          }
          this._dispatch(msg);
        };
        ws.onclose = (event) => {
          clearTimeout(timer);
          this.isClosed = true;
          if (!this.hello) reject(failure('unreachable'));
          const code = event.code >= 4000 && event.reason ? event.reason : 'closed';
          for (const waiter of [...this.waiters]) waiter.fail(failure(code));
          this._emit('closed', { code: event.code, reason: event.reason });
          this._resolveClosed({ code: event.code, reason: event.reason });
        };
        ws.onerror = () => {};
      });
    }

    _dispatch(msg) {
      for (const waiter of [...this.waiters]) {
        if (waiter.types.includes(msg.type)) waiter.done(msg);
      }
      this._emit(msg.type, msg);
    }

    _emit(type, msg) {
      const set = this.listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(msg); } catch (err) { console.error(err); }
      }
    }

    on(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
      return () => this.listeners.get(type).delete(fn);
    }

    next(types, timeoutMs = 10000) {
      if (this.isClosed) return Promise.reject(failure('closed'));
      return new Promise((resolve, reject) => {
        const waiter = { types };
        const finish = () => { clearTimeout(waiter.timer); this.waiters.delete(waiter); };
        waiter.done = (msg) => { finish(); resolve(msg); };
        waiter.fail = (err) => { finish(); reject(err); };
        waiter.timer = setTimeout(() => waiter.fail(failure('timeout')), timeoutMs);
        this.waiters.add(waiter);
      });
    }

    send(type, data = {}) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ ...data, type }));
    }

    async authenticate({ password } = {}) {
      const me = await this.adapter.identity();
      const myNonce = nonce();
      this.lastNonce = myNonce;
      const sig = await this.adapter.sign(`${AUTH}${this.hello.nonce}:${this.hello.id}`);
      const reply = this.next(['auth-ok', 'auth-fail'], 15000);
      this.send('auth', { id: me.id, name: me.name, os: me.os, publicKey: me.publicKey, sig, nonce: myNonce, password });
      const res = await reply;
      if (res.type === 'auth-fail') return { ok: false, reason: res.reason, canPair: !!res.canPair };
      // The computer proves it holds its private key before we trust anything else it says.
      if (!(await this.adapter.verify(`${HOST}${myNonce}:${me.id}`, res.sig, this.hello.publicKey))) {
        this.close();
        throw failure('security');
      }
      return {
        ok: true,
        permission: res.permission,
        owner: !!res.owner,
        locked: !!res.locked,
        lockdown: res.lockdown,
        inputAvailable: res.inputAvailable !== false,
      };
    }

    async pair({ code, onPending } = {}) {
      const me = await this.adapter.identity();
      const withCode = code != null;
      let reply = this.next(['pair-result'], withCode ? 15000 : 130000);
      this.send('pair', withCode ? { code: String(code) } : {});
      for (;;) {
        const res = await reply;
        if (res.pending) {
          reply = this.next(['pair-result'], 130000);
          if (onPending) onPending();
          continue;
        }
        if (!res.ok) return { ok: false, reason: res.reason };
        if (!(await this.adapter.verify(`${HOST}${this.lastNonce}:${me.id}`, res.sig, this.hello.publicKey))) {
          this.close();
          throw failure('security');
        }
        return { ok: true, host: res.host };
      }
    }

    verifySdp(sdp, sig) {
      return this.adapter.verify(SDP + sdp, sig, this.hello.publicKey);
    }

    signSdp(sdp) {
      return this.adapter.sign(SDP + sdp);
    }

    close() {
      if (this.ws && this.ws.readyState <= 1) {
        try { this.ws.close(1000); } catch { /* already closing */ }
      }
    }
  }

  global.JConnectProtocol = { HostConnection, failure };
})(window);
