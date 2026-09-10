// Connection layer for the JConnect web client. Speaks protocol v2 (src/shared/secure-channel.js):
// an X25519 + XSalsa20-Poly1305 channel bound to the computer's Ed25519 identity. Inside it:
//   client-> auth  {publicKey, name, os, sig('jconnect-v2-client:' + th), password?: scrypt proof}
//   host  -> auth-ok {permission, owner, locked, lockdown, mac, services} | auth-fail {reason, canPair}
//   client-> pair {proof?}          host -> pair-result {pending, sas} | {ok:false, reason} | {ok:true, host}
//   client-> session-start          host -> session {sid, displays, permission, iceServers} | session-denied
//   host  -> offer {sdp, sig('jconnect-sdp:<sdp>')}   client -> answer {sdp, sig}   both -> ice {candidate}
//   host  -> notice {kind}, tick   client -> session-end, owner-restore -> restored
// Pairing codes and passwords are never sent: both sides derive scrypt proofs bound to the channel.
(function () {
  const identity = window.JCIdentity;
  const S = window.JCSecure;
  const PORT = 47801;
  const HELLO_TIMEOUT_MS = 6000;
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  // ---------- small helpers ----------
  const b64url = (s) => String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '+');
  const padB64 = (s) => { const t = b64url(s); return t + '='.repeat((4 - (t.length % 4)) % 4); };
  const wsUrl = ({ host, port }) => `ws://${host.includes(':') ? `[${host}]` : host}:${port || PORT}/ws`;

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

  // scrypt runs in the browser; results are only used as proofs bound to one encrypted channel.
  function derive(secret, salt) {
    return window.scrypt.scrypt(secret, salt, S.SCRYPT.N, S.SCRYPT.r, S.SCRYPT.p, S.SCRYPT.dkLen);
  }
  let lastVerifier = null;

  // An encrypted channel with a message queue, so nothing that arrives early is lost.
  async function openSocket(target, timeoutMs = HELLO_TIMEOUT_MS, expectedKey = null) {
    let ws;
    try { ws = new WebSocket(wsUrl(target)); } catch (err) { throw new JCError('unreachable', err.message); }
    let channel;
    try {
      channel = await S.connect(S.fromBrowserSocket(ws), {
        verify: async (text, sig, key) => identity.verify(text, sig, key),
        expectedKey: expectedKey || null,
        timeoutMs,
      });
    } catch (err) {
      try { ws.close(); } catch { /* closed */ }
      const code = { identity: 'host-changed', security: 'host-changed', outdated: 'outdated', protocol: 'outdated' }[err.code] || 'unreachable';
      throw new JCError(code, `${err.code || err.message} ${target.host}`);
    }

    const inbox = [];
    const waiters = [];
    let closedInfo = null;
    const sock = {
      ws,
      channel,
      target,
      hello: channel.hello,
      welcome: channel.welcome,
      sas: channel.sas,
      onNotice: null,
      onClose: null,
      send(type, data = {}) { channel.send(type, data); },
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
      close(code = 1000) { channel.close(code, ''); },
    };
    channel.on('*', (msg) => {
      if (sock.onNotice && (msg.type === 'notice' || msg.type === 'offer' || msg.type === 'ice' || msg.type === 'tick')) {
        if (sock.onNotice(msg)) return;
      }
      const i = waiters.findIndex((w) => w.types.includes(msg.type));
      if (i >= 0) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else if (msg.type !== 'tick') {
        inbox.push(msg);
        if (inbox.length > 100) inbox.shift();
      }
    });
    channel.on('closed', (info) => {
      closedInfo = info;
      for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.reject(new JCError('closed', `${info.code} ${info.reason}`)); }
      if (sock.onClose) sock.onClose(info);
    });
    return sock;
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
        openSocket(target, timeoutMs, computer.publicKey || null).then((sock) => {
          if (sock.hello.id !== computer.id) {
            sock.close();
            throw new JCError('unreachable', `${target.host} is ${sock.hello.name}`);
          }
          if (won) { sock.close(); return; }
          won = true;
          resolve(sock);
        }).catch((err) => {
          if (err.code === 'host-changed') changed = true;
          errors.push(err.detail || err.message);
          if (--pending === 0 && !won) reject(new JCError(changed ? 'host-changed' : 'unreachable', errors.join('\n')));
        });
      }
    });
  }

  async function authenticate(sock, { password } = {}) {
    let proof;
    if (password && sock.welcome && sock.welcome.passwordSalt) {
      const salt = sock.welcome.passwordSalt;
      if (!lastVerifier || lastVerifier.hostId !== sock.hello.id || lastVerifier.salt !== salt || lastVerifier.password !== password) {
        lastVerifier = { hostId: sock.hello.id, salt, password, verifier: await derive(S.normalizeSecret(password), S.unb64(salt)) };
      }
      proof = S.b64(S.passwordProof(lastVerifier.verifier, sock.channel.th));
    }
    sock.send('auth', {
      name: identity.name,
      os: identity.os,
      publicKey: identity.publicKey,
      sig: identity.sign(S.PREFIX.client + sock.channel.thB64),
      password: proof,
    });
    const res = await sock.next(['auth-ok', 'auth-fail']);
    if (res.type === 'auth-ok') return res;
    if (res.reason === 'password') lastVerifier = null;
    const map = {
      untrusted: 'not-trusted', disabled: 'access-disabled', travel: 'travel', locked: 'lockdown',
      'password-required': 'password-required', password: 'bad-password', security: 'security',
    };
    const err = new JCError(map[res.reason] || 'denied', `auth-fail ${res.reason}`);
    err.canPair = !!res.canPair;
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
    const sock = await openSocket(target, HELLO_TIMEOUT_MS, target.publicKey || null);
    sock.close();
    const h = sock.hello;
    if (target.id && target.id !== h.id) throw new JCError('host-changed', 'QR code does not match this computer');
    return h;
  }

  async function pair(target, info, code, { signal, onPending } = {}) {
    const sock = await openSocket(target, HELLO_TIMEOUT_MS, info.publicKey);
    const abort = () => sock.close();
    if (signal) signal.addEventListener('abort', abort, { once: true });
    try {
      const h = sock.hello;
      if (h.id !== info.id) throw new JCError('host-changed', 'computer changed during pairing');
      const address = { host: target.host, port: target.port || h.port || PORT };
      const computer = { id: h.id, name: h.name, os: h.os, publicKey: h.publicKey, mac: [], addresses: [address] };

      try {
        const auth = await authenticate(sock);
        return { ...computer, mac: auth.mac || [] }; // already trusted
      } catch (err) {
        if (err.code === 'password-required') return computer; // trusted; the password is asked on Connect
        if (err.code !== 'not-trusted') throw err;
        if (!err.canPair) throw new JCError('pairing-closed', err.detail);
      }

      const digits = code ? String(code).replace(/\D/g, '') : '';
      const proof = digits ? S.b64(await derive(S.normalizeSecret(digits), S.pairSalt(sock.channel.th))) : null;
      sock.send('pair', proof ? { proof } : {});
      for (;;) {
        const res = await sock.next('pair-result', 0); // someone at the computer may take a while to answer
        if (res.pending) {
          if (onPending) onPending(res.sas || sock.sas);
          continue;
        }
        if (!res.ok) {
          const reasons = { code: 'bad-code', denied: 'denied', busy: 'busy', travel: 'pairing-closed', paused: 'pairing-closed' };
          throw new JCError(reasons[res.reason] || 'denied', `pair-result ${res.reason}`);
        }
        const host = res.host || {};
        if (host.publicKey !== h.publicKey || host.id !== h.id) throw new JCError('host-changed', 'pair-result host mismatch');
        return {
          ...computer,
          name: host.name || computer.name,
          os: host.os || computer.os,
          mac: host.mac || [],
          addresses: [address, ...(host.port && host.port !== address.port ? [{ host: target.host, port: host.port }] : [])],
        };
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
            if (sock) sock.onClose = null;
            teardown();
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
        await startMedia();
      } catch (err) {
        teardown();
        if (closed || ended) return;
        if (['not-trusted', 'access-disabled', 'travel', 'security', 'host-changed', 'denied', 'outdated'].includes(err.code)) {
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
      let thisPc = null;
      let sessionInfo = null;
      const pendingIce = [];
      const pendingOffers = [];

      function makePeer(iceServers) {
        pc = new RTCPeerConnection({ iceServers: iceServers && iceServers.length ? iceServers : ICE_SERVERS });
        thisPc = pc;
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
      }

      async function handleOffer(msg) {
        if (!identity.verify(`jconnect-sdp:${msg.sdp}`, msg.sig, computer.publicKey || s.hello.publicKey)) {
          endWith('host-changed', 'offer signature did not verify');
          return;
        }
        const peer = thisPc;
        await peer.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        for (const c of pendingIce.splice(0)) peer.addIceCandidate(c).catch(() => {});
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        const sdp = peer.localDescription.sdp;
        s.send('answer', { sdp, sig: identity.sign(`jconnect-sdp:${sdp}`) });
      }

      s.onNotice = (msg) => {
        if (msg.type === 'tick') return true;
        if (msg.type === 'ice') {
          if (!msg.candidate) return true;
          if (thisPc && thisPc.remoteDescription) thisPc.addIceCandidate(msg.candidate).catch(() => {});
          else pendingIce.push(msg.candidate);
          return true;
        }
        if (msg.type === 'offer') {
          if (thisPc) handleOffer(msg).catch((err) => lost(`offer failed: ${err.message}`));
          else pendingOffers.push(msg);
          return true;
        }
        if (msg.type === 'notice') { handleNotice(msg); return true; }
        return false;
      };

      s.send('session-start', { quality: 'auto', ice: pathState(s.target.host) === 'internet' ? 'internet' : undefined });
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
      makePeer(res.iceServers);
      for (const msg of pendingOffers.splice(0)) handleOffer(msg).catch((err) => lost(`offer failed: ${err.message}`));
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
        ended = false;
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
      outdated: `${name} and this page use different versions of JConnect. Update JConnect on the computer, then reload this page.`,
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
