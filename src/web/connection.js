// Connection layer for the JConnect web client. Speaks the host agent's /ws protocol (src/main/host.js):
//   host  -> hello {id, name, os, publicKey, nonce, requiresPassword, lockdown, pairing, ...}
//   client-> auth  {publicKey, id, name, os, nonce, sig('jconnect-auth:<hostNonce>:<hostId>'), password?}
//   host  -> auth-ok {sig('jconnect-host:<clientNonce>:<clientId>'), permission, owner, locked, lockdown}
//          | auth-fail {reason, canPair}
//   client-> pair {code?}          host -> pair-result {pending} | {ok:false, reason} | {ok:true, sig, host}
//   client-> session-start         host -> session {sid, displays, permission, inputAvailable} | session-denied
//   host  -> offer {sdp, sig('jconnect-sdp:<sdp>')}   client -> answer {sdp, sig}   both -> ice {candidate}
//   host  -> notice {kind}, tick   client -> session-end, owner-restore -> restored
(function () {
  const identity = window.JCIdentity;
  const PORT = 47801;
  const HELLO_TIMEOUT_MS = 6000;
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  // ---------- small helpers ----------
  const b64url = (s) => String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '+');
  const padB64 = (s) => { const t = b64url(s); return t + '='.repeat((4 - (t.length % 4)) % 4); };
  const wsUrl = ({ host, port }) => `ws://${host.includes(':') ? `[${host}]` : host}:${port || PORT}/ws`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isTailscale(host) {
    if (/^fd7a:115c:a1e0:/i.test(host) || /\.ts\.net$/i.test(host)) return true;
    const m = /^100\.(\d+)\./.exec(host);
    return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
  }
  function isPrivate(host) {
    return host === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fe80:|fc|fd)/i.test(host);
  }
  function pathState(host) {
    if (isTailscale(host)) return 'private';
    return isPrivate(host) ? 'ready' : 'internet';
  }

  class JCError extends Error {
    constructor(code, detail) { super(detail || code); this.code = code; this.detail = detail || ''; }
  }

  function nonce() { return identity.randomToken(18); }

  // A WebSocket with a message queue, so nothing that arrives early is lost.
  function openSocket(target, timeoutMs = HELLO_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(wsUrl(target)); } catch (err) { reject(new JCError('unreachable', err.message)); return; }
      const inbox = [];
      const waiters = [];
      let closedInfo = null;
      const timer = setTimeout(() => { ws.close(); reject(new JCError('unreachable', `timeout ${target.host}`)); }, timeoutMs);

      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (!msg || typeof msg.type !== 'string') return;
        if (sock.onNotice && (msg.type === 'notice' || msg.type === 'offer' || msg.type === 'ice' || msg.type === 'tick')) {
          if (sock.onNotice(msg)) return;
        }
        const i = waiters.findIndex((w) => w.types.includes(msg.type));
        if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(msg); } else inbox.push(msg);
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        closedInfo = { code: e.code, reason: e.reason };
        for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.reject(new JCError('closed', `${e.code} ${e.reason}`)); }
        if (sock.onClose) sock.onClose(closedInfo);
        reject(new JCError('unreachable', `closed ${e.code} ${target.host}`));
      };
      ws.onerror = () => {};

      const sock = {
        ws,
        target,
        onNotice: null,
        onClose: null,
        send(type, data = {}) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data })); },
        next(types, ms = 20000) {
          const list = Array.isArray(types) ? types : [types];
          const i = inbox.findIndex((m) => list.includes(m.type));
          if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
          if (closedInfo) return Promise.reject(new JCError('closed', `${closedInfo.code} ${closedInfo.reason}`));
          return new Promise((res, rej) => {
            const w = { types: list, resolve: res, reject: rej, timer: 0 };
            if (ms) w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new JCError('unreachable', `no ${list.join('/')}`)); }, ms);
            waiters.push(w);
          });
        },
        close(code = 1000) { try { ws.close(code); } catch { /* already closed */ } },
      };

      sock.next('hello', timeoutMs).then((hello) => {
        clearTimeout(timer);
        sock.hello = hello;
        resolve(sock);
      }, (err) => { clearTimeout(timer); ws.close(); reject(err); });
    });
  }

  function candidates(computer) {
    const list = [...(computer.addresses || [])];
    const here = hostFromLocation(location);
    if (here && (!computer.id || here.id === computer.id || !list.length)) list.unshift(here);
    const seen = new Set();
    return list.filter((a) => a && a.host && !seen.has(`${a.host}|${a.port}`) && seen.add(`${a.host}|${a.port}`));
  }

  // Open every known path at once; keep the first one that proves it's the right computer.
  function reach(computer, timeoutMs = HELLO_TIMEOUT_MS) {
    const list = candidates(computer);
    if (!list.length) return Promise.reject(new JCError('unreachable', 'no known addresses'));
    return new Promise((resolve, reject) => {
      let pending = list.length;
      let won = false;
      let changed = false;
      const errors = [];
      for (const target of list) {
        openSocket(target, timeoutMs).then((sock) => {
          const h = sock.hello;
          const same = h.id === computer.id && (!computer.publicKey || h.publicKey === computer.publicKey)
            && identity.deviceIdFromKey(h.publicKey) === h.id;
          if (!same) {
            if (h.id === computer.id) changed = true;
            sock.close();
            throw new JCError(h.id === computer.id ? 'host-changed' : 'unreachable', `${target.host} is ${h.name}`);
          }
          if (won) { sock.close(); return; }
          won = true;
          resolve(sock);
        }).catch((err) => {
          errors.push(err.detail || err.message);
          if (--pending === 0 && !won) reject(new JCError(changed ? 'host-changed' : 'unreachable', errors.join('\n')));
        });
      }
    });
  }

  async function authenticate(sock, { password } = {}) {
    const h = sock.hello;
    const myNonce = nonce();
    sock.send('auth', {
      id: identity.id,
      publicKey: identity.publicKey,
      name: identity.name,
      os: identity.os,
      nonce: myNonce,
      sig: identity.sign(`jconnect-auth:${h.nonce}:${h.id}`),
      ...(password ? { password } : {}),
    });
    const res = await sock.next(['auth-ok', 'auth-fail']);
    if (res.type === 'auth-ok') {
      if (!identity.verify(`jconnect-host:${myNonce}:${identity.id}`, res.sig, h.publicKey)) {
        sock.close();
        throw new JCError('host-changed', 'host signature did not verify');
      }
      return { ...res, myNonce };
    }
    const map = {
      untrusted: 'not-trusted', disabled: 'access-disabled', travel: 'travel', locked: 'lockdown',
      'password-required': 'password-required', password: 'bad-password', security: 'security',
    };
    const err = new JCError(map[res.reason] || 'denied', `auth-fail ${res.reason}`);
    err.canPair = !!res.canPair;
    err.myNonce = myNonce; // the host signs a later pairing approval with this nonce
    throw err;
  }

  // ---------- public API ----------
  function hostFromLocation(loc) {
    if (!/^https?:$/.test(loc.protocol) || !loc.hostname) return null;
    const port = Number(loc.port) || (loc.protocol === 'https:' ? 443 : 80);
    return { host: loc.hostname, port };
  }

  function pairTargetFromLocation(loc) {
    const q = new URLSearchParams(loc.search || (loc.hash || '').replace(/^#\??/, ''));
    const code = (q.get('code') || q.get('c') || '').replace(/\D/g, '');
    const id = q.get('id') || q.get('i') || '';
    const key = q.get('k') || q.get('key') || q.get('pk') || '';
    const hostParam = q.get('host') || q.get('h');
    if (!code && !id && !key && !q.has('pair')) return null;
    const here = hostFromLocation(loc);
    const target = hostParam
      ? { host: hostParam.replace(/:\d+$/, ''), port: Number((hostParam.match(/:(\d+)$/) || [])[1]) || PORT }
      : here;
    if (!target) return null;
    return { ...target, code: code.length === 6 ? code : '', id, publicKey: key ? padB64(key) : '' };
  }

  async function hostInfo(target) {
    const sock = await openSocket(target);
    sock.close();
    const h = sock.hello;
    if (identity.deviceIdFromKey(h.publicKey) !== h.id) throw new JCError('host-changed', 'id not bound to key');
    if ((target.id && target.id !== h.id) || (target.publicKey && target.publicKey !== h.publicKey)) {
      throw new JCError('host-changed', 'QR code does not match this computer');
    }
    return h;
  }

  async function pair(target, info, code, { signal } = {}) {
    const sock = await openSocket(target);
    const abort = () => sock.close();
    if (signal) signal.addEventListener('abort', abort, { once: true });
    try {
      const h = sock.hello;
      if (h.id !== info.id || h.publicKey !== info.publicKey) throw new JCError('host-changed', 'computer changed during pairing');
      const address = { host: target.host, port: target.port || h.port || PORT };
      const computer = { id: h.id, name: h.name, os: h.os, publicKey: h.publicKey, mac: h.mac || [], addresses: [address] };

      let myNonce;
      try {
        await authenticate(sock);
        return computer; // already trusted
      } catch (err) {
        if (err.code !== 'not-trusted') throw err;
        if (!err.canPair) throw new JCError('pairing-closed', err.detail);
        myNonce = err.myNonce;
      }

      // The host kept this connection in its "proven" state; ask to pair.
      sock.send('pair', code ? { code: String(code).replace(/\D/g, '') } : {});
      for (;;) {
        const res = await sock.next('pair-result', 0); // someone at the computer may take a while to answer
        if (res.pending) continue;
        if (!res.ok) {
          const reasons = { code: 'bad-code', denied: 'denied', busy: 'busy', travel: 'pairing-closed', paused: 'pairing-closed' };
          throw new JCError(reasons[res.reason] || 'denied', `pair-result ${res.reason}`);
        }
        const host = res.host || {};
        if (host.publicKey !== h.publicKey || host.id !== h.id) throw new JCError('host-changed', 'pair-result host mismatch');
        // Our auth message carried a nonce before pairing; the host signs its approval with it.
        if (!identity.verify(`jconnect-host:${myNonce}:${identity.id}`, res.sig, h.publicKey)) {
          throw new JCError('host-changed', 'pair-result signature');
        }
        return { ...computer, name: host.name || computer.name, os: host.os || computer.os, mac: host.mac || computer.mac,
          addresses: [address, ...(host.port && host.port !== address.port ? [{ host: target.host, port: host.port }] : [])] };
      }
    } finally {
      if (signal) signal.removeEventListener('abort', abort);
      sock.close();
    }
  }

  async function status(computer) {
    try {
      const sock = await reach(computer, 2500);
      sock.close();
      if (sock.hello.lockdown) return { state: 'lockdown' };
      return { state: pathState(sock.target.host) };
    } catch {
      return { state: 'offline' };
    }
  }

  async function securityAction(computer, action) {
    if (action !== 'restore') return true; // "Keep Locked" leaves things exactly as they are.
    const sock = await reach(computer);
    try {
      const auth = await authenticate(sock);
      if (!auth.owner) throw new JCError('denied', 'not an owner device');
      sock.send('owner-restore');
      await sock.next('restored', 10000);
      return true;
    } finally {
      sock.close();
    }
  }

  function wake() {
    // Browsers can't send Wake-on-LAN packets. A JConnect computer on the same network does this instead.
    return Promise.reject(new JCError('sleeping', 'wake not available in browser'));
  }

  // ---------- a live session ----------
  function connect(computer, { onStream, onState }) {
    let closed = false;
    let sock = null;
    let pc = null;
    let channels = [];
    let password = null;
    let attempt = 0;
    let failingSince = 0;
    let wakeTimer = 0;
    let disconnectTimer = 0;
    let ended = false;
    let retryNow = null;
    let viewOnly = false;

    const state = (s) => { if (!closed) onState(s); };

    function teardown() {
      clearTimeout(disconnectTimer);
      for (const ch of channels) { try { ch.close(); } catch { /* closed */ } }
      channels = [];
      if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = null; }
      if (sock) { sock.onClose = null; sock.onNotice = null; sock.close(); sock = null; }
    }

    function endWith(code, detail) {
      ended = true;
      teardown();
      state({ state: 'ended', code, detail });
    }

    function lost(detail) {
      if (closed || ended) return;
      teardown();
      if (!failingSince) failingSince = Date.now();
      state({ state: 'reconnecting', detail });
      schedule(0);
    }

    function schedule(delay) {
      clearTimeout(wakeTimer);
      wakeTimer = setTimeout(run, delay);
    }

    async function run() {
      if (closed || ended) return;
      attempt++;
      if (attempt === 1) state({ state: 'connecting' });
      try {
        sock = await reach(computer);
        sock.onClose = (info) => lost(`connection closed (${info.code}${info.reason ? ` ${info.reason}` : ''})`);

        let auth;
        try {
          auth = await authenticate(sock, { password });
        } catch (err) {
          if (err.code === 'password-required' || err.code === 'bad-password') {
            sock.onClose = null;
            if (err.code === 'bad-password') password = null;
            state({ state: 'password', wrong: err.code === 'bad-password' });
            return;
          }
          if (err.code === 'lockdown') { ended = true; teardown(); state({ state: 'lockdown', reason: '', canRestore: false }); return; }
          throw err;
        }

        if (auth.locked) {
          ended = true;
          teardown();
          state({ state: 'lockdown', reason: auth.lockdown && auth.lockdown.reason, canRestore: !!auth.owner, computerState: 'On' });
          return;
        }

        viewOnly = auth.permission !== 'control' || auth.inputAvailable === false;
        await startMedia(auth);
      } catch (err) {
        teardown();
        if (closed || ended) return;
        if (['not-trusted', 'access-disabled', 'travel', 'security', 'host-changed', 'denied'].includes(err.code)) {
          endWith(err.code, err.detail);
          return;
        }
        if (!failingSince) failingSince = Date.now();
        const waited = Date.now() - failingSince;
        // No artificial give-up: keep trying, just less often, and tell the person plainly.
        const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
        state(waited > 8000
          ? { state: 'unreachable', code: err.code === 'capture' ? 'capture' : 'unreachable', retrying: true, detail: err.detail || err.message }
          : { state: 'reconnecting', detail: err.detail || err.message });
        await new Promise((r) => { retryNow = r; wakeTimer = setTimeout(r, delay); });
        retryNow = null;
        run();
      }
    }

    async function startMedia() {
      const s = sock;
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const thisPc = pc;
      let sessionInfo = null;

      pc.ontrack = (e) => {
        const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
        onStream(stream);
      };
      pc.ondatachannel = (e) => {
        const ch = e.channel;
        channels.push(ch);
        ch.onmessage = (m) => handleChannelMessage(ch, m.data);
      };
      pc.onicecandidate = (e) => { if (e.candidate) s.send('ice', { candidate: e.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => {
        if (thisPc !== pc) return;
        const cs = pc.connectionState;
        if (cs === 'connected') {
          clearTimeout(disconnectTimer);
          failingSince = 0;
          attempt = 1;
          state({ state: 'connected', viewOnly, addresses: [{ host: s.target.host, port: s.target.port }], displays: sessionInfo && sessionInfo.displays });
        } else if (cs === 'disconnected') {
          clearTimeout(disconnectTimer);
          disconnectTimer = setTimeout(() => lost('media path lost'), 3000);
        } else if (cs === 'failed') {
          lost('media path failed');
        }
      };

      const pendingIce = [];
      s.onNotice = (msg) => {
        if (msg.type === 'tick') return true;
        if (msg.type === 'ice') {
          if (!msg.candidate) return true;
          if (thisPc.remoteDescription) thisPc.addIceCandidate(msg.candidate).catch(() => {});
          else pendingIce.push(msg.candidate);
          return true;
        }
        if (msg.type === 'offer') {
          handleOffer(msg).catch((err) => lost(`offer failed: ${err.message}`));
          return true;
        }
        if (msg.type === 'notice') { handleNotice(msg); return true; }
        return false;
      };

      async function handleOffer(msg) {
        if (!identity.verify(`jconnect-sdp:${msg.sdp}`, msg.sig, computer.publicKey || s.hello.publicKey)) {
          endWith('host-changed', 'offer signature did not verify');
          return;
        }
        await thisPc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        for (const c of pendingIce.splice(0)) thisPc.addIceCandidate(c).catch(() => {});
        const answer = await thisPc.createAnswer();
        await thisPc.setLocalDescription(answer);
        const sdp = thisPc.localDescription.sdp;
        s.send('answer', { sdp, sig: identity.sign(`jconnect-sdp:${sdp}`) });
      }

      s.send('session-start', { quality: 'auto' });
      const res = await s.next(['session', 'session-denied']);
      if (res.type === 'session-denied') {
        if (res.reason === 'locked') {
          ended = true;
          teardown();
          state({ state: 'lockdown', reason: '', canRestore: false });
          return;
        }
        throw new JCError(res.reason === 'capture' ? 'capture' : 'busy', `session-denied ${res.reason}`);
      }
      sessionInfo = res;
      viewOnly = viewOnly || res.permission !== 'control' || res.inputAvailable === false;
    }

    function handleChannelMessage(ch, data) {
      // Hosts may send small status messages over the channel (e.g. clipboard); ignore what we don't know.
      if (typeof data !== 'string') return;
      try {
        const msg = JSON.parse(data);
        if (msg && msg.type === 'notice') handleNotice(msg);
      } catch { /* not JSON */ }
    }

    function handleNotice(msg) {
      switch (msg.kind) {
        case 'ended-by-owner': endWith('ended-by-owner'); break;
        case 'revoked': endWith('not-trusted'); break;
        case 'disabled': endWith('access-disabled'); break;
        case 'travel-mode': endWith('travel'); break;
        case 'lockdown':
          ended = true; teardown();
          state({ state: 'lockdown', reason: msg.message || '', canRestore: false });
          break;
        case 'security-alert':
          if (msg.level === 'high' || msg.lockdown) {
            ended = true; teardown();
            state({ state: 'lockdown', reason: msg.message || (msg.lockdown && msg.lockdown.reason) || '', canRestore: true, computerState: 'On' });
          }
          break;
        case 'permission':
          viewOnly = msg.permission !== 'control';
          state({ state: 'connected', viewOnly });
          break;
        default:
      }
    }

    function pickChannel(type) {
      const open = channels.filter((c) => c.readyState === 'open');
      if (type === 'm') {
        const fast = open.find((c) => c.ordered === false || /move|pointer|unreliable/i.test(c.label));
        if (fast) return fast;
      }
      return open.find((c) => /input|control/i.test(c.label)) || open.find((c) => c.ordered !== false) || open[0];
    }

    run();

    return {
      send(msg) {
        if (viewOnly || !msg) return;
        const ch = pickChannel(msg.t);
        if (ch && ch.bufferedAmount < 512 * 1024) ch.send(JSON.stringify(msg));
      },
      providePassword(pw) {
        password = pw;
        teardown();
        attempt = 0;
        schedule(0);
      },
      retry() {
        if (ended) { ended = false; attempt = 0; failingSince = 0; schedule(0); return; }
        if (retryNow) retryNow();
      },
      close() {
        if (closed) return;
        if (sock) sock.send('session-end');
        closed = true;
        clearTimeout(wakeTimer);
        teardown();
      },
    };
  }

  function friendly(err, hostName) {
    const name = hostName || 'This computer';
    const code = (err && err.code) || 'unreachable';
    const map = {
      unreachable: `${name} isn't reachable right now. JConnect will keep trying automatically.`,
      closed: `${name} isn't reachable right now. JConnect will keep trying automatically.`,
      denied: `${name} didn't allow this device.`,
      'not-trusted': `This device isn't allowed to use ${name} yet.`,
      'bad-code': "That code doesn't match. Check the code shown on the computer.",
      'pairing-closed': `${name} isn't accepting new devices right now.`,
      busy: `${name} is busy. Try again in a moment.`,
      'password-required': `${name} asks for its password.`,
      'bad-password': "That password isn't right.",
      'access-disabled': `Remote access is turned off on ${name}.`,
      travel: `${name} is in Travel Mode and only allows its owner's devices.`,
      lockdown: `${name} has paused remote access for safety.`,
      security: `${name} stopped the connection to keep things safe.`,
      'host-changed': `${name} doesn't look like the computer you paired with, so JConnect stopped to keep you safe.`,
      'ended-by-owner': `Someone at ${name} ended the connection.`,
      capture: `${name} couldn't share its screen right now.`,
      sleeping: `This device can't wake ${name}. Wake it from a computer on the same network, or press a key on it.`,
    };
    return map[code] || map.unreachable;
  }

  window.JCConnection = {
    hostFromLocation(loc) { return hostFromLocation(loc); },
    pairTargetFromLocation,
    hostInfo,
    pair,
    status,
    connect,
    securityAction,
    wake,
    friendly,
    JCError,
  };
})();
