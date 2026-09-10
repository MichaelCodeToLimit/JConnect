// Desktop client for a JConnect computer: an encrypted protocol v2 channel (see secure-channel.js).
(function (global) {
  'use strict';

  const S = global.JCSecure;
  const { failure } = S;

  class HostConnection {
    // adapter: identity(), sign(text), verify(text, sig, key), derive(secretBytes, saltBytes)
    constructor(url, adapter) {
      this.url = url;
      this.adapter = adapter;
      this.channel = null;
      this.hello = null;
      this.welcome = null;
      this.sas = null;
    }

    async open({ expectedKey = null, timeoutMs } = {}) {
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch {
        throw failure('unreachable');
      }
      this.ws = ws;
      try {
        this.channel = await S.connect(S.fromBrowserSocket(ws), {
          verify: (text, sig, key) => this.adapter.verify(text, sig, key),
          expectedKey,
          timeoutMs,
        });
      } catch (err) {
        try { ws.close(); } catch { /* closed */ }
        throw err;
      }
      this.hello = this.channel.hello;
      this.welcome = this.channel.welcome;
      this.sas = this.channel.sas;
      return this.hello;
    }

    get lastMessageAt() { return this.channel ? this.channel.lastMessageAt : 0; }
    get whenClosed() { return this.channel ? this.channel.whenClosed : Promise.resolve({ code: 1006 }); }
    get isClosed() { return !this.channel || this.channel.isClosed; }

    on(type, fn) { return this.channel ? this.channel.on(type, fn) : () => {}; }
    next(types, timeoutMs) { return this.channel ? this.channel.next(types, timeoutMs) : Promise.reject(failure('closed')); }
    send(type, data) { return this.channel ? this.channel.send(type, data) : false; }

    async authenticate({ password } = {}) {
      const me = await this.adapter.identity();
      return S.authenticate(this.channel, {
        identity: { ...me, sign: (text) => this.adapter.sign(text) },
        password,
        derive: (secret, salt) => this.adapter.derive(secret, salt),
      });
    }

    pair({ code, onPending } = {}) {
      return S.pair(this.channel, { code, onPending, derive: (secret, salt) => this.adapter.derive(secret, salt) });
    }

    verifySdp(sdp, sig) { return this.adapter.verify(S.PREFIX.sdp + sdp, sig, this.hello.publicKey); }
    signSdp(sdp) { return this.adapter.sign(S.PREFIX.sdp + sdp); }

    close() {
      if (this.channel) this.channel.close(1000, '');
      else if (this.ws) {
        try { this.ws.close(); } catch { /* closed */ }
      }
    }
  }

  global.JConnectProtocol = { HostConnection, failure };
})(window);
