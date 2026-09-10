// This browser's JConnect identity and the computers it may use.
// Uses tweetnacl (not crypto.subtle) because phones open JConnect over plain http on the local
// network, where browsers don't expose crypto.subtle. crypto.getRandomValues is still available.
(function () {
  const nacl = window.nacl;
  const IDENTITY_KEY = 'jconnect.identity.v1';
  const COMPUTERS_KEY = 'jconnect.computers.v1';
  const memory = new Map();

  const storage = {
    get(key) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? memory.get(key) ?? null : v;
      } catch { return memory.get(key) ?? null; }
    },
    set(key, value) {
      memory.set(key, value);
      try { localStorage.setItem(key, value); } catch { /* private mode: keep it in memory */ }
    },
  };

  const enc = new TextEncoder();
  const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  // Must match src/main/store.js deviceIdFromKey(): sha512(publicKey) hex, first 20 chars.
  function deviceIdFromKey(publicKeyB64) { return hex(nacl.hash(unb64(publicKeyB64))).slice(0, 20); }

  function guessKind() {
    const ua = navigator.userAgent || '';
    if (/GoogleTV|Android TV|AFT|BRAVIA|SmartTV|CrKey/i.test(ua)) return { kind: 'tv', name: 'Living Room TV' };
    if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return { kind: 'tablet', name: 'iPad' };
    if (/iPhone/i.test(ua)) return { kind: 'phone', name: 'iPhone' };
    if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? { kind: 'phone', name: 'Android phone' } : { kind: 'tablet', name: 'Android tablet' };
    return { kind: 'browser', name: 'Web browser' };
  }

  function load() {
    try {
      const saved = JSON.parse(storage.get(IDENTITY_KEY));
      if (saved && saved.secretKey) {
        const keyPair = nacl.sign.keyPair.fromSecretKey(unb64(saved.secretKey));
        return { keyPair, name: saved.name, kind: saved.kind, named: !!saved.named };
      }
    } catch { /* corrupted: make a new identity */ }
    const guess = guessKind();
    const fresh = { keyPair: nacl.sign.keyPair(), name: guess.name, kind: guess.kind, named: false };
    persist(fresh);
    return fresh;
  }

  function persist(state) {
    storage.set(IDENTITY_KEY, JSON.stringify({
      secretKey: b64(state.keyPair.secretKey), name: state.name, kind: state.kind, named: state.named,
    }));
  }

  const state = load();
  const publicKey = b64(state.keyPair.publicKey);

  const identity = {
    id: deviceIdFromKey(publicKey),
    publicKey,
    get name() { return state.name; },
    get kind() { return state.kind; },
    get named() { return state.named; },
    os: guessKind().kind === 'browser' ? 'Web' : (/iPhone|iPad|Macintosh/i.test(navigator.userAgent) ? 'iOS' : 'Android'),
    rename(name) {
      const clean = String(name || '').trim().slice(0, 64);
      if (!clean) return;
      state.name = clean;
      state.named = true;
      persist(state);
    },
    sign(text) { return b64(nacl.sign.detached(enc.encode(String(text)), state.keyPair.secretKey)); },
    verify(text, sigB64, publicKeyB64) {
      try { return nacl.sign.detached.verify(enc.encode(String(text)), unb64(sigB64), unb64(publicKeyB64)); } catch { return false; }
    },
    deviceIdFromKey,
    randomToken(bytes = 24) { return b64(nacl.randomBytes(bytes)); },
  };

  const computers = {
    list() {
      try { return JSON.parse(storage.get(COMPUTERS_KEY)) || []; } catch { return []; }
    },
    get(id) { return computers.list().find((c) => c.id === id) || null; },
    save(list) { storage.set(COMPUTERS_KEY, JSON.stringify(list)); },
    upsert(computer) {
      const list = computers.list();
      const i = list.findIndex((c) => c.id === computer.id);
      if (i >= 0) {
        const merged = { ...list[i], ...computer };
        const seen = new Set();
        merged.addresses = [...(computer.addresses || []), ...(list[i].addresses || [])]
          .filter((a) => a && a.host && !seen.has(`${a.host}|${a.port}`) && seen.add(`${a.host}|${a.port}`))
          .slice(0, 12);
        list[i] = merged;
      } else {
        list.push({ addresses: [], pairedAt: Date.now(), ...computer });
      }
      computers.save(list);
      return computers.get(computer.id);
    },
    remove(id) { computers.save(computers.list().filter((c) => c.id !== id)); },
  };

  window.JCIdentity = identity;
  window.JCComputers = computers;
})();
