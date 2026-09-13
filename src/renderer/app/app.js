(function () {
  'use strict';

  const jc = window.jconnect;
  const { HostConnection, failure } = window.JConnectProtocol;
  const S = window.JCSecure;
  const adapter = {
    identity: () => jc.invoke('jc:identity'),
    sign: (text) => jc.invoke('jc:sign', text),
    verify: (text, sig, key) => jc.invoke('jc:verify', text, sig, key),
    derive: async (secret, salt) => S.unb64(await jc.invoke('jc:derive', S.b64(secret), S.b64(salt))),
  };

  let state = null;
  let sheet = null;
  let qr = null;
  let qrLoading = false;

  // ---- helpers ----

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'value' || key === 'checked' || key === 'disabled') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  const fmtCode = (code) => (code ? `${code.slice(0, 3)}-${code.slice(3)}` : '———');

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3800);
  }

  const codeOf = (err) => String((err && (err.code || err.message)) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function errorText(err, name = 'The computer') {
    const code = codeOf(err);
    const messages = {
      code: `That code didn't match. Check the code on ${name} and try again.`,
      denied: `${name} didn't allow this device.`,
      paused: `Pairing is paused on ${name} for a little while. Try again later.`,
      busy: `${name} is already answering another request. Try again in a moment.`,
      travel: `${name} is in Travel Mode and isn't accepting new devices.`,
      locked: `${name} is in Emergency Lockdown.`,
      disabled: `Remote access is turned off on ${name}.`,
      unreachable: `${name} isn't reachable right now.`,
      closed: `${name} isn't reachable right now.`,
      identity: "This doesn't look like the same computer, so JConnect stopped to keep you safe.",
      security: "JConnect couldn't verify this computer, so it stopped to keep you safe.",
      timeout: `${name} didn't answer in time.`,
      outdated: `${name} uses a different version of JConnect. Update JConnect on both computers.`,
      protocol: `${name} uses a different version of JConnect. Update JConnect on both computers.`,
      credentials: "That email and password don't match.",
      totp: "That code didn't work. Check your authenticator app.",
      'totp-required': 'Enter the 6-digit code from your authenticator app.',
      exists: 'An account with this email already exists. Sign in instead.',
      'weak-password': 'Use at least 10 characters for your password.',
      'slow-down': 'Too many tries. Wait a few minutes, then try again.',
      server: "JConnect Cloud couldn't finish that. Try again.",
      'insecure-server': 'Use an https:// address. Plain http is only allowed on your own network.',
      expired: 'Sign in again to keep syncing.',
      'vault-key': "This device can't open your synced data. Sign out and sign in again.",
      'not-installed': 'That VPN isn’t installed on this computer.',
      'elevation-cancelled': 'Starting the VPN needs administrator permission.',
      'vpn-not-connected': 'The VPN didn’t connect. Open it to check its sign-in.',
      'account-required': 'Connect an account first.',
      network: 'Check the network name.',
      api: 'The VPN service didn’t accept that request.',
      'bad-config': "That doesn't look like a WireGuard tunnel file.",
      'not-shared': `${name} doesn't share that through JVPN yet.`,
      'not-running': `${name} doesn't have that service running.`,
      host: 'Enter a host name or address.',
      'shutdown-failed': 'This computer couldn’t be shut down. Use the system’s own Shut Down instead.',
    };
    return messages[code] || (code && code.length > 24 ? code : 'Something went wrong. Please try again.');
  }

  async function call(channel, ...args) {
    try {
      return await jc.invoke(channel, ...args);
    } catch (err) {
      toast(errorText(err));
      return undefined;
    }
  }

  const networkName = (id) => {
    const base = String(id || '').split(':')[0];
    const found = state && state.networks.find((n) => n.id === base);
    const arg = String(id || '').split(':').slice(1).join(':');
    const label = base === 'auto' ? 'Automatic' : base === 'direct' ? 'Direct' : (found ? found.name : base);
    return arg ? `${label} (${arg})` : label;
  };

  // ---- pairing ----

  async function pairWithRoute(route, code, onPending, onConnection) {
    const conn = new HostConnection(route.url, adapter);
    if (onConnection) onConnection(conn);
    try {
      const hello = await conn.open({ expectedKey: route.publicKey || null });
      const auth = await conn.authenticate();
      let host = null;
      if (!auth.ok && auth.reason !== 'password-required') {
        if (auth.reason !== 'untrusted') throw failure(auth.reason);
        if (!auth.canPair) throw failure('paused');
        const result = await conn.pair({ code, onPending });
        if (!result.ok) throw failure(result.reason);
        host = result.host;
      }
      const computer = await jc.invoke('jc:save-computer', {
        id: hello.id,
        name: hello.name,
        os: hello.os,
        publicKey: hello.publicKey,
        mac: (host && host.mac) || auth.mac || [],
        addresses: route.host ? [{ host: route.host, port: route.port }] : [],
      });
      return { ok: true, computerId: computer.id, name: computer.name };
    } finally {
      conn.close();
    }
  }

  window.JConnectApp = {
    async pairWithUrl(url, code) {
      const parsed = new URL(url.replace(/^ws/, 'http'));
      try {
        return await pairWithRoute({ url, host: parsed.hostname.replace(/^\[|\]$/g, ''), port: Number(parsed.port) }, code);
      } catch (err) {
        return { ok: false, reason: err.code || err.message };
      }
    },
  };

  // ---- home ----

  function render() {
    renderHome();
    renderFooter();
    if (sheet && sheet.live) sheet.rerender();
  }

  function statusInfo(c) {
    const st = c.status || { state: 'checking' };
    if (c.type === 'rdp') {
      if (st.state === 'online') return ['ok', 'Remote Desktop'];
      return ['off', st.state === 'checking' ? 'Remote Desktop' : 'Remote Desktop · Offline'];
    }
    if (c.type === 'host') {
      const what = [c.services && c.services.ssh ? 'SSH' : null, c.services && c.services.rdp ? 'Remote Desktop' : null].filter(Boolean).join(' · ') || 'Computer';
      const via = c.via && c.via !== 'auto' ? ` · ${networkName(c.via)}` : '';
      return st.state === 'online' ? ['ok', `${what}${via}`] : ['off', `${st.state === 'checking' ? what : 'Offline'}${via}`];
    }
    if (!c.paired) return [st.state === 'online' ? 'ok' : 'off', `${c.source ? `From ${networkName(c.source)} · ` : ''}Not paired yet`];
    switch (st.state) {
      case 'online':
        if (st.path === 'jvpn') return ['ok', 'Available through JVPN'];
        if (st.path === 'private') return ['ok', 'Available through private network'];
        return ['ok', c.os || 'Ready'];
      case 'lockdown': return ['bad', '🔒 Emergency Lockdown'];
      case 'waking': return ['warn', 'Waking…'];
      case 'sleeping': return ['warn', 'Sleeping'];
      case 'offline': return ['off', c.lastState === 'security-shutdown' ? 'Shut down for security' : (c.via && c.via !== 'auto' ? `Offline · ${networkName(c.via)}` : 'Offline')];
      default: return ['off', c.os || ''];
    }
  }

  function networkStrip() {
    const shown = state.networks.filter((n) => n.builtin || (n.installed && (n.connected || n.id === 'tailscale' || n.id === 'twingate')));
    if (!shown.length) return null;
    return h('div', { class: 'chips' }, shown.map((n) => h('button', { class: 'chip', type: 'button', onclick: () => openNetworks(n.id), title: n.detail || '' },
      h('span', { class: `dot ${n.connected ? 'ok' : n.running ? 'warn' : 'off'}` }),
      n.name,
      h('span', { class: 'chip-sub' }, n.connected ? 'Connected' : n.builtin && !state.settings.jvpnEnabled ? 'Off' : n.running ? 'On' : 'Off'))));
  }

  function renderHome() {
    const home = document.getElementById('home');
    home.replaceChildren(...[
      state.lockdown && h('div', { class: 'banner danger' },
        h('div', { class: 'banner-icon' }, '🔒'),
        h('div', { class: 'banner-main' }, h('strong', {}, 'Emergency Lockdown'), h('div', {}, 'Remote access to this computer is temporarily disabled.')),
        h('button', { class: 'btn small', type: 'button', onclick: () => openSettings('security') }, 'Review')),
      state.settings.travelMode && h('div', { class: 'banner' },
        h('div', { class: 'banner-icon' }, '✈'),
        h('div', { class: 'banner-main' }, h('strong', {}, 'Travel Mode is on'), h('div', {}, state.settings.travelOwnerOnly ? 'Only your own devices can connect to this computer.' : 'New devices cannot pair with this computer.')),
        h('button', { class: 'btn small', type: 'button', onclick: () => openSettings('travel') }, 'Change')),
      state.settings.remoteAccess && macPermissionsMissing() && h('div', { class: 'banner' },
        h('div', { class: 'banner-icon' }, '🔐'),
        h('div', { class: 'banner-main' }, h('strong', {}, 'Allow JConnect on this Mac'), h('div', {}, 'macOS needs your permission before your devices can see and control this Mac.')),
        h('button', { class: 'btn small', type: 'button', onclick: () => openSettings('mac') }, 'Allow')),
      networkStrip(),
      h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'My Computers'),
        computersList(),
        h('button', { class: 'add-row', type: 'button', onclick: openAdd }, h('span', { class: 'add-plus' }, '+'), 'Add Computer')),
      state.sshHosts.length > 0 && h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'SSH'),
        state.sshHosts.map(sshCard)),
      state.nearby.length > 0 && h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'Nearby'),
        state.nearby.map(nearbyCard)),
    ].filter(Boolean));
  }

  function computersList() {
    if (!state.computers.length) {
      return h('div', { class: 'empty' },
        h('div', { class: 'empty-icon' }, '🖥'),
        h('p', {}, 'No computers yet.'),
        h('p', { class: 'muted' }, 'Install JConnect on another computer, or import the machines from Tailscale and other networks.'));
    }
    const groups = new Map();
    for (const c of state.computers) {
      const key = c.person || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const hasPeople = [...groups.keys()].some(Boolean);
    return [...groups.entries()]
      .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
      .map(([person, items]) => h('div', { class: 'group' },
        hasPeople && h('div', { class: 'group-title' }, person ? `👤 ${person}` : 'My Devices'),
        items.map(computerCard)));
  }

  async function connect(c, e) {
    if (c.type === 'host') {
      const options = [
        c.services && c.services.ssh !== false && { label: 'Open SSH terminal', run: () => call('jc:open-ssh', { computerId: c.id }) },
        c.services && c.services.rdp && { label: 'Open with Remote Desktop', run: () => call('jc:open-rdp', c.id) },
      ].filter(Boolean);
      if (options.length === 1) options[0].run();
      else if (e) popover(e, options.length ? options : [{ label: 'Open SSH terminal', run: () => call('jc:open-ssh', { computerId: c.id }) }, { label: 'Open with Remote Desktop', run: () => call('jc:open-rdp', c.id) }]);
      return;
    }
    const result = await call('jc:connect', c.id);
    if (result && result.needsPairing) {
      openPair({ name: c.name, os: c.os, route: () => jc.invoke('jc:computer-route', c.id) });
    }
  }

  function computerCard(c) {
    const [dot, subtitle] = statusInfo(c);
    const label = c.type === 'host' ? 'Open' : !c.paired ? 'Pair' : 'Connect';
    return h('div', { class: 'card', oncontextmenu: (e) => computerMenu(c, e), ondblclick: (e) => connect(c, e) },
      h('span', { class: `dot ${dot}` }),
      h('div', { class: 'card-main' }, h('div', { class: 'card-title' }, c.name), h('div', { class: 'card-sub' }, subtitle)),
      h('button', { class: 'btn primary', type: 'button', onclick: (e) => connect(c, e) }, label),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `More for ${c.name}`, onclick: (e) => computerMenu(c, e) }, '⋯'));
  }

  function sshCard(entry) {
    const target = `${entry.username ? `${entry.username}@` : ''}${entry.host}${entry.port && entry.port !== 22 ? `:${entry.port}` : ''}`;
    return h('div', { class: 'card', ondblclick: () => call('jc:open-ssh', { hostId: entry.id }) },
      h('span', { class: 'term-icon' }, '>_'),
      h('div', { class: 'card-main' },
        h('div', { class: 'card-title' }, entry.name),
        h('div', { class: 'card-sub' }, entry.via && entry.via !== 'auto' ? `${target} · ${networkName(entry.via)}` : target)),
      h('button', { class: 'btn primary', type: 'button', onclick: () => call('jc:open-ssh', { hostId: entry.id }) }, 'Open'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `More for ${entry.name}`, onclick: (e) => popover(e, [
        { label: 'Open terminal', run: () => call('jc:open-ssh', { hostId: entry.id }) },
        { label: 'Edit…', run: () => openSshHost(entry) },
        { label: 'Remove', danger: true, run: () => openConfirm(`Remove ${entry.name}?`, 'You can add it again later.', 'Remove', () => call('jc:ssh-remove', entry.id)) },
      ]) }, '⋯'));
  }

  function nearbyCard(p) {
    const sub = [p.os, p.path === 'private' ? 'private network' : null, p.travelMode ? 'Travel Mode' : null].filter(Boolean).join(' · ');
    return h('div', { class: 'card' },
      h('span', { class: 'dot ok' }),
      h('div', { class: 'card-main' }, h('div', { class: 'card-title' }, p.name), h('div', { class: 'card-sub' }, sub)),
      h('button', { class: 'btn', type: 'button', onclick: () => openPair({ name: p.name, os: p.os, route: () => jc.invoke('jc:peer-route', p.id) }) }, 'Pair'));
  }

  function renderFooter() {
    const s = state.settings;
    let status = 'Ready to connect · Encrypted';
    if (state.lockdown) status = 'Emergency Lockdown';
    else if (!s.remoteAccess) status = 'Remote access is off';
    else if (state.sessions.length) status = `${state.sessions.map((x) => x.name).join(', ')} connected`;
    else if (s.travelMode) status = 'Travel Mode';
    const dot = state.lockdown ? 'bad' : s.remoteAccess ? 'ok' : 'off';
    document.getElementById('footer').replaceChildren(
      h('button', { class: 'footer-btn', type: 'button', onclick: () => openSettings('this') },
        h('span', { class: `dot ${dot}` }),
        h('span', { class: 'footer-main' }, h('span', { class: 'footer-title' }, `This computer · ${state.device.name}`), h('span', { class: 'footer-sub' }, status)),
        s.remoteAccess && state.pairingAllowed && h('span', { class: 'footer-code', title: 'Pairing code' }, fmtCode(state.pairingCode))));
    const accountBtn = document.getElementById('account-btn');
    accountBtn.textContent = state.account.signedIn ? state.account.email.slice(0, 1).toUpperCase() : '👤';
    accountBtn.classList.toggle('signed-in', state.account.signedIn);
    accountBtn.title = state.account.signedIn ? `Signed in as ${state.account.email}` : 'Sign in to sync';
  }

  // ---- popover menu ----

  function closeOnOutside(e) {
    if (popover.current && !popover.current.contains(e.target)) closePopover();
  }

  function closePopover() {
    if (!popover.current) return;
    popover.current.remove();
    popover.current = null;
    document.removeEventListener('pointerdown', closeOnOutside, true);
  }

  function popover(e, items) {
    closePopover();
    const menu = h('div', { class: 'popover', role: 'menu' }, items.filter(Boolean).map((item) => h('button', {
      class: `pop-item${item.danger ? ' danger' : ''}`,
      type: 'button',
      role: 'menuitem',
      onclick: () => { closePopover(); item.run(); },
    }, item.label)));
    document.body.append(menu);
    let { clientX: x, clientY: y } = e;
    if (!x && !y && e.currentTarget && e.currentTarget.getBoundingClientRect) {
      const r = e.currentTarget.getBoundingClientRect();
      x = r.left;
      y = r.bottom;
    }
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    popover.current = menu;
    setTimeout(() => document.addEventListener('pointerdown', closeOnOutside, true));
    const first = menu.querySelector('button');
    if (first) first.focus();
  }

  function computerMenu(c, e) {
    e.preventDefault();
    e.stopPropagation();
    const canSsh = c.type === 'host' ? !(c.services && c.services.ssh === false) : c.type === 'jconnect';
    const canRdp = c.type === 'host' || c.type === 'jconnect';
    popover(e, [
      { label: c.type === 'host' ? 'Open…' : c.paired ? 'Connect' : 'Pair', run: () => connect(c, e) },
      canSsh && c.paired && { label: 'Open SSH terminal', run: () => call('jc:open-ssh', { computerId: c.id }) },
      canRdp && c.paired && c.type === 'jconnect' && { label: 'Open with Remote Desktop', run: () => call('jc:open-rdp', c.id) },
      c.type === 'host' && { label: 'Open with Remote Desktop', run: () => call('jc:open-rdp', c.id) },
      { label: 'Connect using…', run: () => openVia(c) },
      { label: 'Rename…', run: () => openRename(c) },
      c.type !== 'rdp' && {
        label: 'Create Shortcut',
        run: async () => {
          if (await call('jc:shortcut', c.id)) toast(`A shortcut to ${c.name} is on your desktop.`);
        },
      },
      c.canWake && {
        label: 'Wake',
        run: async () => {
          if (await call('jc:wake', c.id)) toast(`Waking ${c.name}…`);
        },
      },
      { label: 'Remove', danger: true, run: () => openConfirm(`Remove ${c.name}?`, 'You can add it again later.', 'Remove', () => call('jc:computer-remove', c.id)) },
    ]);
  }

  // ---- sheets ----

  function openSheet(title, build, { live = false, onClose } = {}) {
    closeSheet();
    const body = h('div', { class: 'sheet-body' });
    const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
      h('div', { class: 'sheet-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => closeSheet() }, '✕')),
      body);
    const backdrop = h('div', { class: 'sheet-backdrop' }, panel);
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) closeSheet(); });
    document.body.append(backdrop);
    const current = {
      live,
      onClose,
      body,
      backdrop,
      rerender(force) {
        const active = document.activeElement;
        const editing = active && body.contains(active)
          && (active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || (active.tagName === 'INPUT' && !['checkbox', 'radio'].includes(active.type)));
        if (editing && !force) return;
        if (force && active && body.contains(active) && active.tagName !== 'INPUT') active.blur();
        const scroll = body.scrollTop;
        const keep = force && active && body.contains(active) && active.tagName === 'INPUT' ? active : null;
        body.replaceChildren(...[].concat(build()).flat(Infinity).filter(Boolean));
        body.scrollTop = scroll;
        if (keep && body.contains(keep)) keep.focus();
      },
    };
    sheet = current;
    current.rerender(true);
    requestAnimationFrame(() => backdrop.classList.add('open'));
    return current;
  }

  function closeSheet() {
    if (!sheet) return;
    const closing = sheet;
    sheet = null;
    if (closing.onClose) closing.onClose();
    closing.backdrop.remove();
  }

  function openConfirm(title, text, label, fn) {
    openSheet(title, () => [
      h('p', { class: 'muted' }, text),
      h('div', { class: 'button-row' },
        h('button', { class: 'btn', type: 'button', onclick: () => closeSheet() }, 'Cancel'),
        h('button', { class: 'btn danger-fill', type: 'button', onclick: async () => { closeSheet(); await fn(); } }, label)),
    ]);
  }

  const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint && h('span', { class: 'field-hint' }, hint));

  function openPair(target) {
    let step = 'choose';
    let error = '';
    let sas = '';
    let savedId = null;
    let savedName = target.name;
    let cancelled = false;
    let active = null;

    const codeInput = h('input', { class: 'code-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '7', placeholder: '000-000', 'aria-label': 'Pairing code' });
    codeInput.addEventListener('input', () => {
      const digits = codeInput.value.replace(/\D/g, '').slice(0, 6);
      codeInput.value = digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
    });
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(codeInput.value); });

    const current = openSheet(`Pair with ${target.name}`, () => {
      if (step === 'choose') {
        return [
          h('div', { class: 'pair-target' }, h('div', { class: 'pc-icon' }, '🖥'), h('div', {}, h('div', { class: 'card-title' }, target.name), h('div', { class: 'card-sub' }, target.os || ''))),
          field(`Enter the pairing code shown on ${target.name}`, codeInput),
          error && h('p', { class: 'error' }, error),
          h('button', { class: 'btn primary wide', type: 'button', onclick: () => run(codeInput.value) }, 'Pair'),
          h('div', { class: 'or' }, h('span', {}, 'or')),
          h('button', { class: 'btn wide', type: 'button', onclick: () => run(null) }, `Ask ${target.name} for permission`),
          h('p', { class: 'hint' }, `The code is at the bottom of the JConnect window on ${target.name}. The code never leaves this device: JConnect proves it knows the code over an encrypted connection.`),
        ];
      }
      if (step === 'working') return [h('div', { class: 'spinner' }), h('p', { class: 'center' }, 'Pairing…')];
      if (step === 'waiting') {
        return [
          h('div', { class: 'spinner' }),
          h('p', { class: 'center' }, `Waiting for someone at ${target.name} to allow this device…`),
          sas && h('div', { class: 'sas-block' },
            h('div', { class: 'field-label' }, `Make sure ${target.name} shows this code`),
            h('div', { class: 'big-code' }, fmtCode(sas))),
          h('button', { class: 'btn wide', type: 'button', onclick: () => closeSheet() }, 'Cancel'),
        ];
      }
      return [
        h('div', { class: 'success' }, '✓'),
        h('p', { class: 'center big' }, `${savedName} is ready`),
        h('p', { class: 'center muted' }, "You won't need to pair again."),
        h('button', { class: 'btn primary wide', type: 'button', onclick: () => { closeSheet(); call('jc:connect', savedId); } }, 'Connect'),
        h('button', { class: 'btn wide', type: 'button', onclick: () => closeSheet() }, 'Done'),
      ];
    }, { onClose: () => { cancelled = true; if (active) active.close(); } });

    const go = (next) => {
      step = next;
      if (sheet === current) current.rerender(true);
    };

    async function run(code) {
      const digits = code == null ? null : code.replace(/\D/g, '');
      if (digits != null && digits.length !== 6) {
        error = 'Enter the 6-digit code.';
        go('choose');
        codeInput.focus();
        return;
      }
      error = '';
      go(digits ? 'working' : 'waiting');
      try {
        const route = await target.route();
        if (!route) throw failure('unreachable');
        const result = await pairWithRoute(route, digits, (shown) => {
          if (cancelled) return;
          sas = shown || '';
          go('waiting');
        }, (conn) => { active = conn; });
        if (cancelled) return;
        savedId = result.computerId;
        savedName = result.name;
        go('done');
      } catch (err) {
        if (cancelled) return;
        error = errorText(err, target.name);
        go('choose');
      }
    }

    setTimeout(() => codeInput.focus(), 60);
  }

  function openAdd() {
    let finding = false;
    let findError = '';
    let moreOpen = false;
    const address = h('input', { class: 'text-input', placeholder: 'Computer name or address', 'aria-label': 'Computer name or address' });

    const row = (icon, title, sub, onclick) => h('button', { class: 'row-btn', type: 'button', onclick },
      h('span', { class: 'row-icon' }, icon),
      h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, title), h('span', { class: 'row-sub' }, sub)));

    const current = openSheet('Add Computer', () => [
      h('p', { class: 'muted' }, 'Computers with JConnect on your network show up here automatically.'),
      state.nearby.length
        ? state.nearby.map(nearbyCard)
        : h('div', { class: 'looking' }, h('div', { class: 'spinner small' }), 'Looking for computers…'),
      h('div', { class: 'rows' },
        row('🌐', 'Import from a network', 'Tailscale, Twingate, ZeroTier, WireGuard and your JVPN devices', () => openNetworks()),
        row('>_', 'Add SSH host', 'Or import from ~/.ssh/config', () => openSshHost()),
        row('🗂', 'Import Remote Desktop file', 'Use an existing .rdp connection', importRdp),
        row('📱', 'Use this computer from a phone', 'Scan a code with the phone camera', () => openSettings('phone'))),
      h('details', { class: 'more', open: moreOpen || finding || !!findError, ontoggle: (e) => { moreOpen = e.target.open; } },
        h('summary', {}, 'Other ways to connect'),
        h('div', { class: 'inline-form' }, address, h('button', { class: 'btn', type: 'button', onclick: find, disabled: finding }, finding ? 'Finding…' : 'Find')),
        findError && h('p', { class: 'error' }, findError)),
    ], { live: true });

    async function find() {
      const value = address.value.trim();
      if (!value || finding) return;
      finding = true;
      findError = '';
      current.rerender(true);
      const route = await jc.invoke('jc:probe-address', value).catch(() => null);
      finding = false;
      if (!route) {
        findError = `JConnect couldn't find a computer at “${value}”.`;
        if (sheet === current) current.rerender(true);
        return;
      }
      openPair({ name: route.name, os: route.os, route: async () => route });
    }
    address.addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
  }

  async function importRdp() {
    const computer = await call('jc:import-rdp');
    if (computer) {
      closeSheet();
      toast(`${computer.name} was added.`);
    }
  }

  function openRename(c) {
    const name = h('input', { class: 'text-input', maxlength: '64', value: c.name });
    const person = h('input', { class: 'text-input', maxlength: '48', placeholder: 'For example: Dad', value: c.person || '' });
    const save = async () => {
      await call('jc:computer-update', c.id, { name: name.value, person: person.value });
      closeSheet();
    };
    [name, person].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); }));
    openSheet('Rename', () => [
      field('Name', name),
      field('Whose computer is it? (optional)', person),
      h('p', { class: 'hint' }, "Computers that belong to other people are grouped under that person's name."),
      h('button', { class: 'btn primary wide', type: 'button', onclick: save }, 'Save'),
    ]);
    setTimeout(() => name.select(), 60);
  }

  // Which network JConnect uses (and starts) to reach this computer.
  function viaOptions() {
    const options = [
      { value: 'auto', title: 'Automatic', sub: 'Direct when nearby, then JVPN or any VPN that is already connected' },
      { value: 'jvpn', title: 'JVPN', sub: 'JConnect’s own encrypted network. Works from anywhere when you’re signed in.' },
    ];
    for (const n of state.networks.filter((x) => !x.builtin && x.installed)) {
      // A computer keeps the connection's name, so only names that can be saved are offered one by one.
      const tunnels = (n.tunnels || []).filter((t) => /^[\w .()-]{1,64}$/.test(t.name));
      if (['wireguard', 'forticlient', 'windows'].includes(n.id) && tunnels.length) {
        for (const t of tunnels) options.push({ value: `${n.id}:${t.name}`, title: `${n.name} · ${t.name}`, sub: t.connected ? 'Connected' : 'JConnect connects it when needed' });
      } else {
        options.push({ value: n.id, title: n.name, sub: n.connected ? 'Connected' : 'JConnect starts it when you connect' });
      }
    }
    return options;
  }

  function openVia(c) {
    let selected = c.via || 'auto';
    openSheet(`Connect to ${c.name} using`, () => [
      h('div', { class: 'radio-list' }, viaOptions().map((o) => h('label', { class: `radio-row${selected === o.value ? ' selected' : ''}` },
        h('input', { type: 'radio', name: 'via', value: o.value, checked: selected === o.value, onchange: () => { selected = o.value; } }),
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, o.title), h('span', { class: 'row-sub' }, o.sub))))),
      h('p', { class: 'hint' }, 'Every JConnect connection is end-to-end encrypted, whichever network carries it.'),
      h('button', {
        class: 'btn primary wide',
        type: 'button',
        onclick: async () => {
          await call('jc:computer-update', c.id, { via: selected });
          closeSheet();
          toast(`${c.name} will connect using ${networkName(selected)}.`);
        },
      }, 'Save'),
    ]);
  }

  // ---- networks ----

  function openNetworks(focus) {
    const forms = {};
    let busy = null;
    const progressOff = jc.on('jc:progress', (message) => { if (busy) toast(message); });

    const act = async (id, action, options) => {
      busy = `${id}:${action}`;
      if (sheet === current) current.rerender(true);
      try {
        await jc.invoke('jc:network-action', id, action, options || {});
        if (action === 'signIn') delete forms[id];
      } catch (err) {
        toast(errorText(err));
      } finally {
        busy = null;
        if (sheet === current) current.rerender(true);
      }
    };

    const accountForm = (n) => {
      if (n.id === 'twingate') {
        const network = h('input', { class: 'text-input', placeholder: 'yourcompany (from yourcompany.twingate.com)' });
        const apiKey = h('input', { class: 'text-input', type: 'password', placeholder: 'Read-only API key from the Twingate Admin Console' });
        return h('div', { class: 'net-form' }, field('Network name', network), field('API key', apiKey, 'Stored encrypted on this computer and used only to list Resources.'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => act('twingate', 'signIn', { network: network.value, apiKey: apiKey.value }) }, 'Connect account'));
      }
      if (n.id === 'zerotier') {
        const networks = h('input', { class: 'text-input', placeholder: '16-character network ID(s)' });
        const token = h('input', { class: 'text-input', type: 'password', placeholder: 'ZeroTier Central API token (optional)' });
        return h('div', { class: 'net-form' }, field('Networks', networks), field('API token', token, 'Needed to list the other members of your network.'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => act('zerotier', 'signIn', { networks: networks.value, token: token.value }) }, 'Save'));
      }
      return null;
    };

    const current = openSheet('Networks', () => state.networks.map((n) => {
      const pending = busy && busy.startsWith(`${n.id}:`);
      const statusText = !n.installed ? 'Not installed' : n.connected ? 'Connected' : n.needsSignIn ? 'Needs sign-in' : n.running ? 'On' : 'Off';
      const buttons = [];
      if (n.builtin) {
        buttons.push(h('button', { class: 'btn small', type: 'button', disabled: pending, onclick: () => act('jvpn', state.settings.jvpnEnabled ? 'disconnect' : 'connect') }, state.settings.jvpnEnabled ? 'Turn off' : 'Turn on'));
        if (!state.account.signedIn) buttons.push(h('button', { class: 'btn small primary', type: 'button', onclick: openAccount }, 'Sign in'));
        buttons.push(h('button', { class: 'btn small', type: 'button', onclick: () => openImport(n) }, 'My devices'));
      } else if (!n.installed) {
        if (n.website && n.id !== 'windows') buttons.push(h('button', { class: 'btn small', type: 'button', onclick: () => call('jc:open-external', n.website) }, `Get ${n.name}`));
      } else {
        if (n.id === 'tailscale' && n.needsSignIn) buttons.push(h('button', { class: 'btn small primary', type: 'button', disabled: pending, onclick: () => act(n.id, 'signIn') }, 'Sign in'));
        if (n.id === 'wireguard') buttons.push(h('button', { class: 'btn small', type: 'button', disabled: pending, onclick: () => act(n.id, 'signIn') }, 'Add tunnel file'));
        if (n.id === 'forticlient') buttons.push(h('button', { class: 'btn small', type: 'button', disabled: pending, onclick: () => act(n.id, 'signIn') }, 'Open FortiClient'));
        if ((n.id === 'twingate' || n.id === 'zerotier') && !n.canImport) buttons.push(h('button', { class: 'btn small', type: 'button', onclick: () => { forms[n.id] = !forms[n.id]; current.rerender(true); } }, forms[n.id] ? 'Cancel' : 'Connect account'));
        // FortiClient on Windows and macOS doesn't say which connection is up, so the network keeps its own Disconnect.
        if (!n.tunnels || !n.tunnels.length || (n.connected && !n.tunnels.some((t) => t.connected))) {
          buttons.push(h('button', { class: `btn small${n.connected ? '' : ' primary'}`, type: 'button', disabled: pending, onclick: () => act(n.id, n.connected ? 'disconnect' : 'connect') }, pending ? 'Working…' : n.connected ? 'Disconnect' : 'Connect'));
        }
        if (n.id === 'tailscale' || n.canImport) buttons.push(h('button', { class: 'btn small', type: 'button', onclick: () => openImport(n) }, 'Import'));
        if ((n.id === 'twingate' || n.id === 'zerotier') && n.canImport) buttons.push(h('button', { class: 'btn small danger', type: 'button', onclick: () => act(n.id, 'signOut') }, 'Forget account'));
      }
      return h('section', { class: `net-row${focus === n.id ? ' focus' : ''}`, id: `net-${n.id}` },
        h('div', { class: 'net-head' },
          h('span', { class: `dot ${n.connected ? 'ok' : n.installed && n.running ? 'warn' : 'off'}` }),
          h('div', { class: 'net-main' },
            h('div', { class: 'card-title' }, n.name, n.builtin && h('span', { class: 'badge' }, 'Built in')),
            h('div', { class: 'card-sub' }, [statusText, n.account, n.builtin ? null : n.detail && n.detail !== statusText ? n.detail : null].filter(Boolean).join(' · '))),
        ),
        n.builtin && h('p', { class: 'hint tight' }, n.detail),
        n.tunnels && n.tunnels.length > 0 && h('div', { class: 'tunnels' }, n.tunnels.map((t) => h('div', { class: 'tunnel' },
          h('span', { class: `dot ${t.connected ? 'ok' : 'off'}` }),
          h('span', { class: 'tunnel-name' }, t.name),
          h('button', { class: 'btn small', type: 'button', disabled: pending, onclick: () => act(n.id, t.connected ? 'disconnect' : 'connect', { arg: t.name }) }, t.connected ? 'Disconnect' : 'Connect')))),
        forms[n.id] && accountForm(n),
        buttons.length > 0 && h('div', { class: 'net-actions' }, buttons));
    }).concat(h('p', { class: 'hint' }, 'JConnect never changes a VPN’s own settings. It starts the service and connects when a computer needs it, asking Windows for permission when that’s required.')), {
      live: true,
      onClose: () => progressOff(),
    });

    jc.invoke('jc:networks', true).catch(() => {});
    if (focus) requestAnimationFrame(() => { const el = document.getElementById(`net-${focus}`); if (el) el.scrollIntoView({ block: 'center' }); });
  }

  function openImport(network) {
    let items = null;
    let error = '';
    const selected = new Set();
    const current = openSheet(network.builtin ? 'Your JVPN devices' : `Import from ${network.name}`, () => {
      if (error) return [h('p', { class: 'error' }, error), h('button', { class: 'btn wide', type: 'button', onclick: () => openNetworks(network.id) }, 'Back')];
      if (!items) return [h('div', { class: 'spinner' }), h('p', { class: 'center muted' }, `Asking ${network.name} which machines it knows…`)];
      if (!items.length) {
        return [h('p', { class: 'muted' }, network.builtin
          ? 'Devices signed in to your JConnect account appear here. Sign in on your other computers to see them.'
          : `${network.name} didn't list any machines.`)];
      }
      const addable = items.filter((i) => !i.exists);
      return [
        h('p', { class: 'muted' }, 'Choose what to add to My Computers. JConnect remembers to use this network for them.'),
        h('div', { class: 'check-list' }, items.map((item) => {
          const badges = [
            item.services && item.services.jconnect && 'JConnect',
            item.services && item.services.ssh && 'SSH',
            item.services && item.services.rdp && 'Remote Desktop',
            item.online === false && 'Offline',
          ].filter(Boolean);
          return h('label', { class: `check-row${item.exists ? ' exists' : ''}` },
            h('input', { type: 'checkbox', disabled: item.exists, checked: item.exists || selected.has(item.key), onchange: (e) => { if (e.target.checked) selected.add(item.key); else selected.delete(item.key); current.rerender(true); } }),
            h('span', { class: 'row-main' },
              h('span', { class: 'row-title' }, item.name, item.exists && h('span', { class: 'badge muted-badge' }, 'Added')),
              h('span', { class: 'row-sub' }, [item.host, item.os, item.group].filter(Boolean).join(' · '))),
            h('span', { class: 'badges' }, badges.map((b) => h('span', { class: `badge${b === 'Offline' ? ' muted-badge' : ''}` }, b))));
        })),
        addable.length > 1 && h('button', { class: 'btn small', type: 'button', onclick: () => { for (const i of addable) selected.add(i.key); current.rerender(true); } }, 'Select all'),
        h('button', {
          class: 'btn primary wide',
          type: 'button',
          disabled: !selected.size,
          onclick: async () => {
            const count = await call('jc:network-import', network.id, [...selected]);
            if (count != null) {
              closeSheet();
              toast(`Added ${count} ${count === 1 ? 'computer' : 'computers'} from ${network.name}.`);
            }
          },
        }, selected.size ? `Add ${selected.size}` : 'Add'),
      ];
    });
    jc.invoke('jc:network-importable', network.id).then((list) => {
      items = list;
      if (sheet === current) current.rerender(true);
    }, (err) => {
      error = errorText(err);
      if (sheet === current) current.rerender(true);
    });
  }

  // ---- SSH ----

  function openSshHost(entry = null) {
    const name = h('input', { class: 'text-input', maxlength: '64', placeholder: 'For example: Raspberry Pi', value: entry ? entry.name : '' });
    const hostInput = h('input', { class: 'text-input', maxlength: '255', placeholder: 'host name or address', value: entry ? entry.host : '' });
    const port = h('input', { class: 'text-input', inputmode: 'numeric', maxlength: '5', value: entry ? String(entry.port || 22) : '22' });
    const user = h('input', { class: 'text-input', maxlength: '64', placeholder: 'user name', value: entry ? entry.username || '' : '' });
    const via = h('select', { class: 'select wide' }, viaOptions().filter((o) => o.value !== 'jvpn').map((o) => h('option', { value: o.value, selected: (entry ? entry.via || 'auto' : 'auto') === o.value }, o.title)));

    const save = async (open) => {
      const id = await call('jc:ssh-save', { id: entry && entry.id, name: name.value || hostInput.value, host: hostInput.value, port: port.value, username: user.value, via: via.value });
      if (!id) return;
      closeSheet();
      if (open) call('jc:open-ssh', { hostId: id });
    };

    openSheet(entry ? `Edit ${entry.name}` : 'Add SSH host', () => [
      field('Name', name),
      h('div', { class: 'form-grid' }, field('Host', hostInput), field('Port', port)),
      field('User', user),
      field('Reach it using', via, 'If the host is on Tailscale, Twingate or another VPN, JConnect starts that VPN first.'),
      h('div', { class: 'button-row' },
        h('button', { class: 'btn', type: 'button', onclick: () => save(false) }, 'Save'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => save(true) }, 'Save and open')),
      !entry && h('div', { class: 'rows' },
        h('button', {
          class: 'row-btn',
          type: 'button',
          onclick: async () => {
            const count = await call('jc:ssh-import-config');
            if (count != null) {
              closeSheet();
              toast(count ? `Imported ${count} host${count === 1 ? '' : 's'} from ~/.ssh/config.` : 'No hosts found in ~/.ssh/config.');
            }
          },
        }, h('span', { class: 'row-icon' }, '📄'), h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, 'Import from ~/.ssh/config'), h('span', { class: 'row-sub' }, 'Adds every named host'))),
        h('button', {
          class: 'row-btn',
          type: 'button',
          onclick: async () => { if (await call('jc:ssh-public-key')) toast('Your JConnect SSH key is on the clipboard. Add it to ~/.ssh/authorized_keys on your hosts.'); },
        }, h('span', { class: 'row-icon' }, '🔑'), h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, 'Copy my SSH key'), h('span', { class: 'row-sub' }, 'Sign in to hosts without a password')))),
    ]);
    setTimeout(() => (entry ? name : hostInput).focus(), 60);
  }

  // ---- account ----

  function openAccount() {
    let mode = 'sign-in';
    let error = '';
    let working = false;
    let needTotp = false;
    let totpSetup = null;
    const server = h('input', { class: 'text-input', placeholder: 'https://cloud.example.com', value: state.cloudServer || '' });
    const email = h('input', { class: 'text-input', type: 'email', autocomplete: 'username', placeholder: 'you@example.com' });
    const password = h('input', { class: 'text-input', type: 'password', autocomplete: 'current-password' });
    const confirm = h('input', { class: 'text-input', type: 'password', autocomplete: 'new-password' });
    const totp = h('input', { class: 'code-input', inputmode: 'numeric', maxlength: '6', placeholder: '000000', autocomplete: 'one-time-code' });
    const totpCode = h('input', { class: 'code-input', inputmode: 'numeric', maxlength: '6', placeholder: '000000' });

    const submit = async () => {
      error = '';
      if (mode === 'sign-up' && password.value !== confirm.value) {
        error = "The passwords don't match.";
        current.rerender(true);
        return;
      }
      working = true;
      current.rerender(true);
      try {
        await jc.invoke('jc:account', mode, { server: server.value, email: email.value, password: password.value, totp: needTotp ? totp.value : undefined });
        password.value = '';
        confirm.value = '';
        needTotp = false;
        toast('Signed in. Your computers now sync, end-to-end encrypted.');
      } catch (err) {
        if (codeOf(err) === 'totp-required') needTotp = true;
        error = errorText(err);
      } finally {
        working = false;
        if (sheet === current) current.rerender(true);
      }
    };
    [email, password, confirm, totp].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));

    const current = openSheet('JConnect account', () => {
      const a = state.account;
      if (a.signedIn) {
        return [
          h('div', { class: 'account-card' },
            h('div', { class: 'avatar' }, a.email.slice(0, 1).toUpperCase()),
            h('div', {}, h('div', { class: 'card-title' }, a.email), h('div', { class: 'card-sub' }, a.server))),
          h('div', { class: 'sync-row' },
            h('span', { class: `dot ${a.state === 'error' || a.state === 'expired' ? 'bad' : a.state === 'syncing' ? 'warn' : 'ok'}` }),
            h('span', { class: 'row-main' },
              h('span', { class: 'row-title' }, a.state === 'syncing' ? 'Syncing…' : a.error || `Synced ${ago(a.lastSync)}`),
              h('span', { class: 'row-sub' }, 'Computers, SSH hosts and your device list are encrypted on this device before they’re synced.')),
            h('button', { class: 'btn small', type: 'button', onclick: () => call('jc:account', 'sync') }, 'Sync now')),
          h('h3', { class: 'sub-title' }, 'Devices on your account'),
          a.devices.length
            ? a.devices.map((d) => h('div', { class: 'person' },
              h('div', { class: 'person-main' }, h('div', { class: 'card-title' }, d.name), h('div', { class: 'card-sub' }, [d.os, `Updated ${ago(d.updatedAt)}`].filter(Boolean).join(' · '))),
              h('button', { class: 'btn small danger', type: 'button', onclick: () => openConfirm(`Remove ${d.name} from your account?`, 'It stops syncing and can no longer reach your computers through JVPN.', 'Remove', () => call('jc:account', 'remove-device', { id: d.id })) }, 'Remove')))
            : h('p', { class: 'muted' }, 'Sign in on your other computers to see them here.'),
          h('h3', { class: 'sub-title' }, 'Two-step sign-in'),
          a.totp
            ? [h('p', { class: 'muted' }, 'On. Signing in on a new device needs a code from your authenticator app.'),
              field('Code to turn it off', totpCode),
              h('button', { class: 'btn small', type: 'button', onclick: async () => { if (await call('jc:account', 'totp-disable', { code: totpCode.value })) toast('Two-step sign-in is off.'); } }, 'Turn off')]
            : totpSetup
              ? [h('div', { class: 'qr-row' }, h('img', { class: 'qr', src: totpSetup.qr, alt: 'Authenticator QR code', width: '168', height: '168' }),
                h('div', { class: 'qr-text' }, h('p', {}, 'Scan with your authenticator app, then enter the code it shows.'), h('code', { class: 'url' }, totpSetup.secret))),
              field('Code', totpCode),
              h('button', { class: 'btn small primary', type: 'button', onclick: async () => { if (await call('jc:account', 'totp-enable', { code: totpCode.value })) { totpSetup = null; toast('Two-step sign-in is on.'); } } }, 'Turn on')]
              : [h('p', { class: 'muted' }, 'Add a code from an authenticator app to every new sign-in.'),
                h('button', { class: 'btn small', type: 'button', onclick: async () => { totpSetup = await call('jc:account', 'totp-setup'); current.rerender(true); } }, 'Set up')],
          h('button', { class: 'btn wide danger', type: 'button', onclick: () => call('jc:account', 'sign-out') }, 'Sign out'),
        ];
      }
      return [
        h('div', { class: 'tabs' },
          h('button', { class: `tab${mode === 'sign-in' ? ' active' : ''}`, type: 'button', onclick: () => { mode = 'sign-in'; error = ''; current.rerender(true); } }, 'Sign in'),
          h('button', { class: `tab${mode === 'sign-up' ? ' active' : ''}`, type: 'button', onclick: () => { mode = 'sign-up'; error = ''; current.rerender(true); } }, 'Create account')),
        h('p', { class: 'muted' }, 'An account is optional. It syncs your computers and lets JVPN reach them from anywhere. Your password never leaves this device, and synced data is encrypted before upload.'),
        field('JConnect Cloud address', server, 'Your own JConnect Cloud server (see server/cloud in the project).'),
        field('Email', email),
        field('Password', password, mode === 'sign-up' ? 'At least 10 characters. It can’t be recovered, so keep it somewhere safe.' : null),
        mode === 'sign-up' && field('Confirm password', confirm),
        needTotp && field('Authenticator code', totp),
        error && h('p', { class: 'error' }, error),
        h('button', { class: 'btn primary wide', type: 'button', disabled: working, onclick: submit }, working ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'),
      ];
    }, { live: true });
    setTimeout(() => (server.value ? email : server).focus(), 60);
  }

  // ---- settings ----

  function toggle(label, sub, checked, onchange) {
    return h('label', { class: 'toggle' },
      h('span', { class: 'toggle-main' }, h('span', { class: 'toggle-title' }, label), sub && h('span', { class: 'toggle-sub' }, sub)),
      h('input', { type: 'checkbox', class: 'switch', checked: !!checked, onchange }));
  }

  const group = (id, title, children) => h('section', { class: 'group-block', id: `set-${id}` }, h('h3', {}, title), children);

  function permissionRow(title, sub, granted, kind) {
    return h('div', { class: 'sync-row' },
      h('span', { class: `dot ${granted ? 'ok' : 'warn'}` }),
      h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, title), h('span', { class: 'row-sub' }, granted ? 'Allowed' : sub)),
      !granted && h('button', { class: 'btn small', type: 'button', onclick: () => call('jc:mac-permission', kind) }, 'Allow…'));
  }

  const macPermissionsMissing = () => !!state.permissions && (state.permissions.screen !== 'granted' || !state.permissions.accessibility);

  function advancedView() {
    const a = state.advanced;
    const rows = [
      ['Device ID', a.id],
      ['Encryption', a.protocol],
      ['Port', a.port],
      ['JVPN relay', state.jvpn.state + (state.jvpn.error ? ` · ${state.jvpn.error}` : '')],
      ['Network', a.addresses.map((i) => `${i.address}${i.tailscale ? ' (Tailscale)' : ''}`).join(', ') || 'No network'],
      ['Remote control', a.input],
      ['Streaming', `${a.resources.level} · CPU ${a.resources.cpu}% · thermal ${a.resources.thermal}`],
      ['Data folder', a.userData],
    ];
    return h('dl', { class: 'diag' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]));
  }

  function openSettings(focus) {
    let passwordOpen = false;
    let advancedOpen = false;
    const nameInput = h('input', { class: 'text-input', maxlength: '64', value: state.device.name, 'aria-label': 'Computer name' });
    nameInput.addEventListener('change', () => call('jc:set-setting', 'deviceName', nameInput.value));
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
    const passwordInput = h('input', { class: 'text-input', type: 'password', placeholder: 'New password', autocomplete: 'new-password' });
    const sshPort = h('input', { class: 'text-input narrow', inputmode: 'numeric', maxlength: '5', value: String(state.settings.sshPort || 22) });
    sshPort.addEventListener('change', () => call('jc:set-setting', 'sshPort', Number(sshPort.value)));
    const setBool = (key) => (e) => call('jc:set-setting', key, e.target.checked);

    const loadQr = async () => {
      if (qrLoading) return;
      qrLoading = true;
      try {
        qr = await jc.invoke('jc:pairing-qr');
      } catch {
        qr = null;
      }
      qrLoading = false;
      if (sheet === current) current.rerender();
    };

    const savePassword = async () => {
      if (passwordInput.value.length < 4) {
        toast('Use at least 4 characters.');
        return;
      }
      await call('jc:set-password', passwordInput.value);
      passwordInput.value = '';
      passwordOpen = false;
      toast('Password saved.');
    };

    const current = openSheet('Settings', () => {
      const s = state.settings;
      if (!qr || qr.code !== state.pairingCode) loadQr();
      if (document.activeElement !== nameInput) nameInput.value = state.device.name;
      const away = state.networks.filter((n) => n.builtin || n.installed);
      return [
        group('this', 'This computer', [
          field('Name', nameInput),
          toggle('Remote access', 'Allow your paired devices to use this computer.', s.remoteAccess, setBool('remoteAccess')),
          s.remoteAccess && h('div', { class: 'code-block' },
            h('div', { class: 'field-label' }, 'Pairing code'),
            state.pairingAllowed
              ? h('div', { class: 'big-code' }, fmtCode(state.pairingCode))
              : h('div', { class: 'muted' }, s.travelMode ? 'Pairing is off in Travel Mode.' : state.lockdown ? 'Pairing is off during Emergency Lockdown.' : 'Pairing is paused for a little while.'),
            state.pairingAllowed && h('button', { class: 'btn small', type: 'button', onclick: () => call('jc:rotate-code') }, 'New code')),
          toggle('Start with this computer', 'JConnect stays ready in the background.', s.startAtLogin, setBool('startAtLogin')),
        ]),
        state.permissions && group('mac', 'Mac permissions', [
          permissionRow('Screen Recording', 'Needed so your devices can see this Mac.', state.permissions.screen === 'granted', 'screen'),
          permissionRow('Accessibility', 'Needed so your devices can use the mouse and keyboard.', state.permissions.accessibility, 'accessibility'),
          h('p', { class: 'hint tight' }, 'Turn JConnect on in System Settings → Privacy & Security. macOS may ask you to reopen JConnect afterwards.'),
        ]),
        group('account', 'Account', [
          h('div', { class: 'sync-row' },
            h('span', { class: `dot ${state.account.signedIn ? 'ok' : 'off'}` }),
            h('span', { class: 'row-main' },
              h('span', { class: 'row-title' }, state.account.signedIn ? state.account.email : 'Not signed in'),
              h('span', { class: 'row-sub' }, state.account.signedIn ? `Synced ${ago(state.account.lastSync)} · end-to-end encrypted` : 'Optional. Sign in to sync computers and use JVPN from anywhere.')),
            h('button', { class: 'btn small', type: 'button', onclick: openAccount }, state.account.signedIn ? 'Manage' : 'Sign in')),
        ]),
        group('jvpn', 'JVPN', [
          toggle('Use JVPN', 'JConnect’s built-in encrypted network. No other VPN needed.', s.jvpnEnabled, setBool('jvpnEnabled')),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'When a computer isn’t nearby, use'),
            h('select', { class: 'select wide', onchange: (e) => call('jc:set-setting', 'defaultVia', e.target.value) },
              away.map((n) => h('option', { value: n.id, selected: s.defaultVia === n.id }, n.builtin ? 'JVPN (recommended)' : n.name)))),
          h('p', { class: 'hint tight' }, state.jvpn.state === 'online' ? 'This computer is reachable through JVPN.' : state.account.signedIn ? (state.jvpn.error || 'Connecting to JVPN…') : 'Sign in to make this computer reachable through JVPN from anywhere.'),
          h('button', { class: 'btn small', type: 'button', onclick: () => openNetworks() }, 'Networks and VPNs…'),
        ]),
        group('services', 'Share through JVPN', [
          toggle('SSH', 'Let your paired devices open SSH on this computer through JVPN.', s.shareSsh, setBool('shareSsh')),
          s.shareSsh && h('div', { class: 'inline-form' }, h('span', { class: 'field-label' }, 'SSH port on this computer'), sshPort),
          jc.platform !== 'darwin' && toggle('Remote Desktop', 'Let your paired devices use Windows Remote Desktop through JVPN.', s.shareRdp, setBool('shareRdp')),
          state.streams.length > 0 && h('p', { class: 'hint tight' }, `In use: ${state.streams.map((x) => `${x.name} (${x.service})`).join(', ')}`),
        ]),
        s.remoteAccess && state.pairingAllowed && s.allowBrowserClients && group('phone', 'Use this computer from a phone', [
          h('div', { class: 'qr-row' },
            qr ? h('img', { class: 'qr', src: qr.dataUrl, alt: 'Pairing QR code', width: '168', height: '168' }) : h('div', { class: 'qr placeholder' }),
            h('div', { class: 'qr-text' },
              h('p', {}, 'Scan with the phone camera, then tap Pair.'),
              h('p', { class: 'muted small' }, 'The phone needs to be on the same network, or on the same private network such as Tailscale.'),
              qr && h('code', { class: 'url' }, qr.url))),
        ]),
        group('travel', 'Travel Mode', [
          toggle('✈ Travel Mode', 'Use when you leave this computer unattended. New pairing is turned off and JConnect uses fewer resources.', s.travelMode, setBool('travelMode')),
          toggle('Only my own devices', 'While in Travel Mode, only devices marked as yours can connect.', s.travelOwnerOnly, setBool('travelOwnerOnly')),
          toggle('Emergency shutdown', 'In Travel Mode, safely shut down this computer if JConnect finds strong evidence of unauthorized activity.', s.emergencyShutdown, setBool('emergencyShutdown')),
        ]),
        group('security', 'Security', [
          h('div', { class: 'secure-note' }, '🔒 Every connection is end-to-end encrypted and both sides prove who they are. Pairing codes and passwords are never sent over the network.'),
          state.lockdown && h('div', { class: 'banner danger' },
            h('div', { class: 'banner-icon' }, '🔒'),
            h('div', { class: 'banner-main' }, h('strong', {}, 'Emergency Lockdown'), h('div', {}, state.lockdown.reason), h('div', { class: 'muted small' }, ago(state.lockdown.at))),
            h('button', { class: 'btn small', type: 'button', onclick: () => call('jc:lockdown-restore') }, 'Restore Remote Access')),
          toggle('Require password', 'An extra step for every connection. Paired devices are already protected without it.', s.requirePassword || passwordOpen, (e) => {
            if (e.target.checked) {
              passwordOpen = true;
              current.rerender(true);
              passwordInput.focus();
            } else {
              passwordOpen = false;
              call('jc:set-password', null);
            }
          }),
          passwordOpen && !s.requirePassword && h('div', { class: 'inline-form' }, passwordInput, h('button', { class: 'btn primary', type: 'button', onclick: savePassword }, 'Save')),
          toggle('Trust my account’s devices', 'Devices signed in to your JConnect account can connect without pairing. Off: they still need to be approved here once.', s.accountTrust, setBool('accountTrust')),
          toggle('Hide from nearby devices', 'Don’t announce this computer on the local network. Paired devices can still connect.', s.hideFromNearby, setBool('hideFromNearby')),
          toggle('Allow phones and browsers', 'Serve the JConnect web page for phones, tablets and TVs on your network.', s.allowBrowserClients, setBool('allowBrowserClients')),
          h('div', { class: 'field-label spaced' }, 'Recent activity'),
          state.securityLog.length
            ? h('ul', { class: 'log' }, state.securityLog.slice(0, 12).map((entry) => h('li', { class: `log-item ${entry.level || 'info'}` },
              h('span', { class: 'log-level' }),
              h('span', { class: 'log-text' }, entry.message || entry.kind),
              h('span', { class: 'log-time' }, ago(entry.at)))))
            : h('p', { class: 'muted' }, 'Nothing yet.'),
        ]),
        group('people', 'Devices that can use this computer', state.trusted.length
          ? state.trusted.map((t) => h('div', { class: 'person' },
            h('div', { class: 'person-main' },
              h('div', { class: 'card-title' }, t.name, t.owner && h('span', { class: 'badge' }, 'My device'), t.via === 'account' && h('span', { class: 'badge' }, 'Account')),
              h('div', { class: 'card-sub' }, [t.os, `Last used ${ago(t.lastSeen)}`].filter(Boolean).join(' · '))),
            h('div', { class: 'person-actions' },
              h('select', { class: 'select', 'aria-label': `Permission for ${t.name}`, onchange: (e) => call('jc:trusted-update', t.id, { permission: e.target.value }) },
                h('option', { value: 'control', selected: t.permission === 'control' }, 'Full control'),
                h('option', { value: 'view', selected: t.permission === 'view' }, 'View only')),
              h('button', { class: 'btn small', type: 'button', onclick: () => call('jc:trusted-update', t.id, { owner: !t.owner }) }, t.owner ? 'Not mine' : 'Mine'),
              h('button', { class: 'btn small danger', type: 'button', onclick: () => openConfirm(`Remove ${t.name}?`, `${t.name} will no longer be able to use this computer.`, 'Remove', () => call('jc:trusted-remove', t.id)) }, 'Remove'))))
          : h('p', { class: 'muted' }, 'No devices yet. Pair a device with the code above.')),
        state.sessions.length > 0 && group('connected', 'Connected now', state.sessions.map((x) => h('div', { class: 'person' },
          h('div', { class: 'person-main' },
            h('div', { class: 'card-title' }, x.name),
            h('div', { class: 'card-sub' }, `Connected ${ago(x.since)}${x.path === 'jvpn' ? ' · through JVPN' : ''}${x.permission === 'view' ? ' · View only' : ''}`)),
          h('button', { class: 'btn small danger', type: 'button', onclick: () => call('jc:session-disconnect', x.sid) }, 'Disconnect')))),
        h('details', { class: 'more', open: advancedOpen, ontoggle: (e) => { advancedOpen = e.target.open; } },
          h('summary', {}, 'Advanced'),
          advancedView()),
      ];
    }, { live: true });

    if (focus) {
      requestAnimationFrame(() => {
        const target = document.getElementById(`set-${focus}`) || document.getElementById('set-this');
        if (target) target.scrollIntoView({ block: 'start' });
      });
    }
  }

  // ---- stop ----

  const TERMINATE_TEXT = 'Every connection and task ends, and remote access, JVPN, syncing and JConnect’s other background services stop. JConnect starts again when you open it, or when you sign in if “Start with this computer” is on.';
  const SHUT_DOWN_TEXT = 'Devices connected to this computer are disconnected, and the computer turns off. Save your work in other apps first.';

  // The manual stop switch: terminate JConnect completely, or shut the whole computer down.
  function openStop() {
    openSheet('Stop', () => {
      const connected = state.sessions.map((x) => x.name);
      return [
        connected.length > 0 && h('p', { class: 'muted' }, `${connected.join(', ')} ${connected.length === 1 ? 'is' : 'are'} connected now and will be disconnected.`),
        h('div', { class: 'sync-row stop-row' },
          h('span', { class: 'row-main' },
            h('span', { class: 'row-title' }, 'Terminate JConnect'),
            h('span', { class: 'row-sub' }, 'Ends every connection and task, stops all of JConnect’s background services and closes JConnect.')),
          h('button', {
            class: 'btn small danger',
            type: 'button',
            onclick: () => openConfirm('Terminate JConnect?', TERMINATE_TEXT, 'Terminate', () => call('jc:terminate')),
          }, 'Terminate')),
        h('div', { class: 'sync-row stop-row' },
          h('span', { class: 'row-main' },
            h('span', { class: 'row-title' }, 'Shut down this computer'),
            h('span', { class: 'row-sub' }, 'Turns this computer off completely.')),
          h('button', {
            class: 'btn small danger-fill',
            type: 'button',
            onclick: () => openConfirm('Shut down this computer?', SHUT_DOWN_TEXT, 'Shut Down', () => call('jc:shutdown')),
          }, 'Shut Down')),
      ];
    }, { live: true });
  }

  // ---- start ----

  async function init() {
    state = await jc.invoke('jc:state');
    render();
    jc.on('jc:state', (next) => {
      state = next;
      render();
    });
    jc.on('jc:navigate', (where) => openSettings(where));
    document.getElementById('settings-btn').addEventListener('click', () => openSettings());
    document.getElementById('power-btn').addEventListener('click', openStop);
    document.getElementById('account-btn').addEventListener('click', openAccount);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (popover.current) closePopover();
      else closeSheet();
    });
  }

  init().catch((err) => {
    document.getElementById('home').replaceChildren(h('p', { class: 'error' }, `JConnect couldn't start: ${codeOf(err)}`));
  });
})();
