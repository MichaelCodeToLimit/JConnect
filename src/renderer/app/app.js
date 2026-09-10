(function () {
  'use strict';

  const jc = window.jconnect;
  const { HostConnection, failure } = window.JConnectProtocol;
  const adapter = {
    identity: () => jc.invoke('jc:identity'),
    sign: (text) => jc.invoke('jc:sign', text),
    verify: (text, sig, key) => jc.invoke('jc:verify', text, sig, key),
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
    toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  const friendly = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  async function call(channel, ...args) {
    try {
      return await jc.invoke(channel, ...args);
    } catch (err) {
      toast(friendly(err));
      return undefined;
    }
  }

  function pairError(code, name) {
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
      identity: "This doesn't look like the same computer, so pairing was stopped to keep you safe.",
      security: "JConnect couldn't verify this computer, so pairing was stopped to keep you safe.",
      timeout: `${name} didn't answer in time.`,
    };
    return messages[code] || 'Something went wrong. Please try again.';
  }

  // ---- pairing ----

  async function pairWithRoute(route, code, onPending, onConnection) {
    const conn = new HostConnection(route.url, adapter);
    if (onConnection) onConnection(conn);
    try {
      const hello = await conn.open();
      if (route.publicKey && hello.publicKey !== route.publicKey) throw failure('identity');
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
        mac: (host && host.mac) || hello.mac || [],
        addresses: [{ host: route.host, port: route.port }],
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
    switch (st.state) {
      case 'online':
        if (st.travelMode) return ['ok', `${c.os || 'Computer'} · Travel Mode`];
        if (st.path === 'private') return ['ok', 'Available through private network'];
        return ['ok', c.os || 'Ready'];
      case 'lockdown': return ['bad', '🔒 Emergency Lockdown'];
      case 'waking': return ['warn', 'Waking…'];
      case 'sleeping': return ['warn', 'Sleeping'];
      case 'offline': return ['off', c.lastState === 'security-shutdown' ? 'Shut down for security' : 'Offline'];
      default: return ['off', c.os || ''];
    }
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
      h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'My Computers'),
        computersList(),
        h('button', { class: 'add-row', type: 'button', onclick: openAdd }, h('span', { class: 'add-plus' }, '+'), 'Add Computer')),
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
        h('p', { class: 'muted' }, 'Install JConnect on another computer, then add it here.'));
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

  function computerCard(c) {
    const [dot, subtitle] = statusInfo(c);
    return h('div', { class: 'card', oncontextmenu: (e) => computerMenu(c, e), ondblclick: () => call('jc:connect', c.id) },
      h('span', { class: `dot ${dot}` }),
      h('div', { class: 'card-main' }, h('div', { class: 'card-title' }, c.name), h('div', { class: 'card-sub' }, subtitle)),
      h('button', { class: 'btn primary', type: 'button', onclick: () => call('jc:connect', c.id) }, 'Connect'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `More for ${c.name}`, onclick: (e) => computerMenu(c, e) }, '⋯'));
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
    let status = 'Ready to connect';
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
    popover(e, [
      { label: 'Connect', run: () => call('jc:connect', c.id) },
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
        if (force && active && body.contains(active)) active.blur();
        const scroll = body.scrollTop;
        body.replaceChildren(...[].concat(build()).flat(Infinity).filter(Boolean));
        body.scrollTop = scroll;
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

  function openPair(target) {
    let step = 'choose';
    let error = '';
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
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, `Enter the pairing code shown on ${target.name}`), codeInput),
          error && h('p', { class: 'error' }, error),
          h('button', { class: 'btn primary wide', type: 'button', onclick: () => run(codeInput.value) }, 'Pair'),
          h('div', { class: 'or' }, h('span', {}, 'or')),
          h('button', { class: 'btn wide', type: 'button', onclick: () => run(null) }, `Ask ${target.name} for permission`),
          h('p', { class: 'hint' }, `The code is at the bottom of the JConnect window on ${target.name}.`),
        ];
      }
      if (step === 'working') return [h('div', { class: 'spinner' }), h('p', { class: 'center' }, 'Pairing…')];
      if (step === 'waiting') {
        return [
          h('div', { class: 'spinner' }),
          h('p', { class: 'center' }, `Waiting for someone at ${target.name} to allow this device…`),
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
        const result = await pairWithRoute(route, digits, () => { if (!cancelled) go('waiting'); }, (conn) => { active = conn; });
        if (cancelled) return;
        savedId = result.computerId;
        savedName = result.name;
        go('done');
      } catch (err) {
        if (cancelled) return;
        error = pairError(err.code || 'unknown', target.name);
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

    const current = openSheet('Add Computer', () => [
      h('p', { class: 'muted' }, 'Computers with JConnect on your network show up here automatically.'),
      state.nearby.length
        ? state.nearby.map(nearbyCard)
        : h('div', { class: 'looking' }, h('div', { class: 'spinner small' }), 'Looking for computers…'),
      h('div', { class: 'rows' },
        h('button', { class: 'row-btn', type: 'button', onclick: importRdp },
          h('span', { class: 'row-icon' }, '🗂'),
          h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, 'Import Remote Desktop file'), h('span', { class: 'row-sub' }, 'Use an existing .rdp connection'))),
        h('button', { class: 'row-btn', type: 'button', onclick: () => openSettings('phone') },
          h('span', { class: 'row-icon' }, '📱'),
          h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, 'Use this computer from a phone'), h('span', { class: 'row-sub' }, 'Scan a code with the phone camera')))),
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
    [name, person].forEach((input) => input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); }));
    openSheet('Rename', () => [
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Whose computer is it? (optional)'), person),
      h('p', { class: 'hint' }, "Computers that belong to other people are grouped under that person's name."),
      h('button', { class: 'btn primary wide', type: 'button', onclick: save }, 'Save'),
    ]);
    setTimeout(() => name.select(), 60);
  }

  // ---- settings ----

  function toggle(label, sub, checked, onchange) {
    return h('label', { class: 'toggle' },
      h('span', { class: 'toggle-main' }, h('span', { class: 'toggle-title' }, label), sub && h('span', { class: 'toggle-sub' }, sub)),
      h('input', { type: 'checkbox', class: 'switch', checked: !!checked, onchange }));
  }

  const group = (id, title, children) => h('section', { class: 'group-block', id: `set-${id}` }, h('h3', {}, title), children);

  function advancedView() {
    const a = state.advanced;
    const rows = [
      ['Device ID', a.id],
      ['Port', a.port],
      ['Network', a.addresses.map((i) => `${i.address}${i.tailscale ? ' (Tailscale)' : ''}`).join(', ') || 'No network'],
      ['Tailscale', a.tailscale.available ? (a.tailscale.online ? 'Connected' : 'Installed, not connected') : 'Not installed'],
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
      return [
        group('this', 'This computer', [
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), nameInput),
          toggle('Remote access', 'Allow your paired devices to use this computer.', s.remoteAccess, setBool('remoteAccess')),
          s.remoteAccess && h('div', { class: 'code-block' },
            h('div', { class: 'field-label' }, 'Pairing code'),
            state.pairingAllowed
              ? h('div', { class: 'big-code' }, fmtCode(state.pairingCode))
              : h('div', { class: 'muted' }, s.travelMode ? 'Pairing is off in Travel Mode.' : state.lockdown ? 'Pairing is off during Emergency Lockdown.' : 'Pairing is paused for a little while.'),
            state.pairingAllowed && h('button', { class: 'btn small', type: 'button', onclick: () => call('jc:rotate-code') }, 'New code')),
          toggle('Start with this computer', 'JConnect stays ready in the background.', s.startAtLogin, setBool('startAtLogin')),
        ]),
        s.remoteAccess && state.pairingAllowed && group('phone', 'Use this computer from a phone', [
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
              h('div', { class: 'card-title' }, t.name, t.owner && h('span', { class: 'badge' }, 'My device')),
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
            h('div', { class: 'card-sub' }, `Connected ${ago(x.since)}${x.permission === 'view' ? ' · View only' : ''}`)),
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
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (popover.current) closePopover();
      else closeSheet();
    });
  }

  init().catch((err) => {
    document.getElementById('home').replaceChildren(h('p', { class: 'error' }, `JConnect couldn't start: ${friendly(err)}`));
  });
})();
