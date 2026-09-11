// JConnect web client: phones, tablets and TV browsers.
// Open -> Connect -> Work. No accounts, no addresses, no settings to learn.
(function () {
  const identity = window.JCIdentity;
  const computers = window.JCComputers;
  const conn = window.JCConnection;
  const $ = (id) => document.getElementById(id);

  const screens = ['screen-home', 'screen-pair', 'screen-session', 'screen-lockdown'];
  function show(id) { for (const s of screens) $(s).hidden = s !== id; }

  // ---------- home ----------
  const liveStatus = new Map(); // computer id -> { state: 'ready'|'private'|'internet'|'sleeping'|'off'|'offline'|'lockdown' }

  const STATUS_TEXT = {
    ready: 'Ready',
    private: 'Available through private network',
    internet: 'Available through the internet',
    sleeping: 'Asleep — Connect will wake it',
    off: 'Turned off',
    'off-by-policy': 'Offline — shut down by Travel Mode',
    lockdown: 'Remote access paused for safety',
    offline: 'Offline',
    checking: 'Checking…',
  };

  function renderHome() {
    $('rename-self').textContent = identity.name;
    const list = computers.list();
    const ul = $('computer-list');
    ul.replaceChildren();
    $('empty-home').hidden = list.length > 0;

    const groups = new Map();
    for (const c of list) {
      const key = c.person ? `${c.person}` : '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const [person, items] of groups) {
      if (person) {
        const label = document.createElement('li');
        label.className = 'group-label';
        label.textContent = person;
        ul.append(label);
      }
      for (const c of items.sort((a, b) => a.name.localeCompare(b.name))) ul.append(computerRow(c));
    }
  }

  function computerRow(c) {
    const status = (liveStatus.get(c.id) || { state: 'checking' }).state;
    const li = document.createElement('li');
    li.className = 'computer';

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = c.name;
    const line = document.createElement('div');
    line.className = 'status';
    const dot = document.createElement('span');
    dot.className = `dot ${status === 'ready' ? 'ready' : status === 'private' || status === 'internet' ? 'private' : status === 'sleeping' ? 'sleeping' : ''}`;
    const text = document.createElement('span');
    text.textContent = status === 'ready' && c.os ? c.os : STATUS_TEXT[status] || STATUS_TEXT.offline;
    line.append(dot, text);
    info.append(name, line);

    const more = document.createElement('button');
    more.className = 'more';
    more.type = 'button';
    more.setAttribute('aria-label', `More for ${c.name}`);
    more.textContent = '⋯';
    more.addEventListener('click', () => openComputerMenu(c));

    const connect = document.createElement('button');
    connect.className = 'primary connect';
    connect.type = 'button';
    connect.textContent = 'Connect';
    connect.addEventListener('click', () => startSession(c));

    li.append(info, more, connect);
    return li;
  }

  async function refreshStatuses() {
    const list = computers.list();
    await Promise.all(list.map(async (c) => {
      try {
        liveStatus.set(c.id, await conn.status(c));
      } catch {
        liveStatus.set(c.id, { state: 'offline' });
      }
    }));
    if (!$('screen-home').hidden) renderHome();
  }

  function openComputerMenu(c) {
    const dialog = $('computer-dialog');
    $('computer-dialog-name').textContent = c.name;
    dialog.onclose = async () => {
      switch (dialog.returnValue) {
        case 'rename': {
          const name = await ask('Rename computer', c.name);
          if (name) { computers.upsert({ id: c.id, name }); renderHome(); }
          break;
        }
        case 'wake':
          conn.wake(c).catch(() => {});
          liveStatus.set(c.id, { state: 'sleeping' });
          renderHome();
          break;
        case 'remove':
          computers.remove(c.id);
          renderHome();
          break;
        default:
      }
    };
    dialog.showModal();
  }

  function ask(title, value) {
    return new Promise((resolve) => {
      const dialog = $('rename-dialog');
      dialog.querySelector('h2').textContent = title;
      const input = $('rename-input');
      input.value = value || '';
      $('rename-preview').textContent = value || 'this device';
      input.oninput = () => { $('rename-preview').textContent = input.value || 'this device'; };
      dialog.onclose = () => resolve(dialog.returnValue === 'ok' ? input.value.trim() : null);
      dialog.showModal();
      input.select();
    });
  }

  $('rename-self').addEventListener('click', async () => {
    const name = await ask('Name this device', identity.name);
    if (name) { identity.rename(name); renderHome(); }
  });

  $('use-another').addEventListener('click', () => {
    // The Android app adds computers itself, by scanning the computer's code or taking its address.
    if (window.JCNative) {
      window.JCNative.addComputer(beginPairing);
      return;
    }
    // The page is normally opened by scanning the QR code on the computer, which already carries
    // everything needed. If someone opened JConnect directly on the computer's address, offer that one.
    const here = conn.hostFromLocation(location);
    if (here) beginPairing(here);
    else alert('On the computer you want to use, open JConnect and choose "Use from a phone". Then scan the code it shows with this camera.');
  });

  // ---------- pairing ----------
  let pairing = null;

  function pairView(which) {
    for (const id of ['pair-ask', 'pair-code-entry', 'pair-wait', 'pair-done']) $(id).hidden = id !== which;
    $('pair-error').hidden = true;
  }

  function pairError(text) {
    $('pair-error').textContent = text;
    $('pair-error').hidden = false;
  }

  async function beginPairing(target) {
    show('screen-pair');
    $('pair-name').textContent = 'Looking for the computer…';
    $('pair-os').textContent = '';
    pairView('pair-wait');
    $('pair-wait-text').textContent = 'Looking for the computer…';
    try {
      const info = await conn.hostInfo(target);
      pairing = { target, info };
      $('pair-name').textContent = info.name;
      $('pair-os').textContent = info.os || '';
      for (const el of document.querySelectorAll('.pair-name-inline')) el.textContent = info.name;
      const known = computers.get(info.id);
      if (known && known.publicKey === info.publicKey) {
        pairView('pair-done');
        return;
      }
      pairView('pair-ask');
      // A code from the QR is used automatically. Without one, the code can still be typed in.
      $('pair-use-code').hidden = !!target.code;
    } catch (err) {
      pairView('pair-ask');
      $('pair-ask').hidden = true;
      pairError(conn.friendly(err, 'That computer'));
    }
  }

  $('pair-cancel').addEventListener('click', goHome);
  $('pair-code-cancel').addEventListener('click', goHome);
  $('pair-wait-cancel').addEventListener('click', () => { if (pairing && pairing.abort) pairing.abort(); goHome(); });

  async function nameThisDevice() {
    if (identity.named) return;
    const name = await ask('Name this device', identity.name);
    if (name) identity.rename(name);
  }

  $('pair-allow').addEventListener('click', async () => {
    if (!pairing) return;
    await nameThisDevice();
    // With a code from the QR, the computer already knows someone is standing at it.
    // Without one, the computer asks "Allow <this device> to use this computer?".
    runPair(pairing.target.code || null);
  });

  $('pair-use-code').addEventListener('click', () => {
    pairView('pair-code-entry');
    $('pair-code').value = '';
    $('pair-code').focus();
  });

  $('pair-code').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
    e.target.value = digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
  });
  $('pair-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pair-code-ok').click(); });
  $('pair-code-ok').addEventListener('click', async () => {
    if (!pairing) return;
    const digits = $('pair-code').value.replace(/\D/g, '');
    if (digits.length !== 6) {
      pairError(`Enter the 6-digit code shown on ${pairing.info.name}.`);
      return;
    }
    await nameThisDevice();
    runPair(digits);
  });

  async function runPair(code) {
    pairView('pair-wait');
    $('pair-wait-text').textContent = code
      ? `Pairing with ${pairing.info.name}…`
      : `Waiting for ${pairing.info.name} to allow ${identity.name}…`;
    const controller = new AbortController();
    pairing.abort = () => controller.abort();
    try {
      const computer = await conn.pair(pairing.target, pairing.info, code, {
        signal: controller.signal,
        onPending: (sas) => {
          $('pair-wait-text').textContent = `Waiting for ${pairing.info.name} to allow ${identity.name}… Make sure the computer shows ${sas.slice(0, 3)} ${sas.slice(3)}.`;
        },
      });
      computers.upsert(computer);
      liveStatus.set(computer.id, { state: 'ready' });
      pairing.computer = computer;
      pairView('pair-done');
      // Clean the one-time code out of the address bar so a reload doesn't try to pair again.
      history.replaceState(null, '', location.pathname);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err && err.code === 'bad-code') { pairView('pair-code-entry'); $('pair-code').value = ''; }
      else pairView('pair-ask');
      pairError(conn.friendly(err, pairing.info.name));
    }
  }

  $('pair-connect').addEventListener('click', () => {
    const c = (pairing && (pairing.computer || computers.get(pairing.info.id)));
    if (c) startSession(c);
  });

  function goHome() {
    pairing = null;
    history.replaceState(null, '', location.pathname);
    show('screen-home');
    renderHome();
    refreshStatuses();
  }

  // ---------- session ----------
  let session = null;
  let input = null;
  let barTimer = 0;

  function overlay({ title, text, spinner = true, retry = false, diag = '' }) {
    $('overlay').hidden = false;
    $('overlay-title').textContent = title;
    $('overlay-text').textContent = text || '';
    $('overlay-spinner').hidden = !spinner;
    $('overlay-retry').hidden = !retry;
    $('overlay-details').hidden = !diag;
    $('overlay-diag').textContent = diag;
  }
  function hideOverlay() { $('overlay').hidden = true; }

  function openBar(autoHide = true) {
    $('bar').classList.add('open');
    clearTimeout(barTimer);
    if (autoHide) barTimer = setTimeout(closeBar, 3500);
  }
  function closeBar() {
    if ($('keys-menu').hidden === false) return;
    $('bar').classList.remove('open');
  }

  function startSession(c) {
    endSession(false);
    show('screen-session');
    $('bar-name').textContent = c.name;
    overlay({ title: `Connecting to ${c.name}…` });

    const video = $('remote');
    input = window.JCInput.createInput({
      surface: $('surface'),
      video,
      keyboardInput: $('soft-keyboard'),
      send: (msg) => session && session.send(msg),
    });
    input.setEnabled(false);
    updateTouchLabel();

    session = conn.connect(c, {
      onStream(stream) {
        video.srcObject = stream;
        video.play().catch(() => {});
      },
      onState(s) {
        switch (s.state) {
          case 'connecting':
            overlay({ title: `Connecting to ${c.name}…` });
            break;
          case 'waking':
            overlay({ title: `Waking ${c.name}…`, text: 'This can take a moment.' });
            break;
          case 'waiting-approval':
            overlay({ title: `Waiting for ${c.name}…`, text: 'Someone at the computer needs to allow this connection.' });
            break;
          case 'password':
            askPassword(c).then((pw) => (pw == null ? endSession() : session && session.providePassword(pw)));
            break;
          case 'connected':
            hideOverlay();
            input.setEnabled(!s.viewOnly);
            computers.upsert({ id: c.id, addresses: s.addresses || [] });
            openBar();
            break;
          case 'reconnecting':
            input.setEnabled(false);
            overlay({ title: 'Connection interrupted', text: 'Reconnecting…', diag: s.detail || '' });
            break;
          case 'unreachable':
            input.setEnabled(false);
            overlay({ title: conn.friendly({ code: s.code || 'unreachable' }, c.name), spinner: s.retrying !== false, retry: true, diag: s.detail || '' });
            break;
          case 'lockdown':
            endSession(false);
            showLockdown(c, s);
            break;
          case 'ended':
            input.setEnabled(false);
            if (s.code) overlay({ title: conn.friendly({ code: s.code }, c.name), spinner: false, retry: s.code !== 'denied', diag: s.detail || '' });
            else endSession();
            break;
          default:
        }
      },
    });
  }

  function askPassword(c) {
    return new Promise((resolve) => {
      const dialog = $('rename-dialog');
      dialog.querySelector('h2').textContent = `${c.name} asks for its password`;
      const input = $('rename-input');
      input.type = 'password';
      input.value = '';
      $('rename-preview').closest('p').hidden = true;
      dialog.onclose = () => {
        input.type = 'text';
        $('rename-preview').closest('p').hidden = false;
        resolve(dialog.returnValue === 'ok' ? input.value : null);
      };
      dialog.showModal();
      input.focus();
    });
  }

  function endSession(goBack = true) {
    if (input) { input.destroy(); input = null; }
    if (session) { const s = session; session = null; s.close(); }
    const video = $('remote');
    video.srcObject = null;
    video.muted = true;
    $('bar-sound').textContent = 'Sound off';
    hideOverlay();
    $('bar').classList.remove('open');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (goBack) goHome();
  }

  $('edge').addEventListener('pointerenter', () => openBar());
  $('pull-tab').addEventListener('click', () => ($('bar').classList.contains('open') ? closeBar() : openBar()));
  $('bar').addEventListener('pointerenter', () => clearTimeout(barTimer));
  $('bar').addEventListener('pointerleave', () => { barTimer = setTimeout(closeBar, 1200); });
  // Keyboard shortcut to reveal controls: Ctrl + Alt + Home (not forwarded to the remote computer).
  window.addEventListener('keydown', (e) => {
    if (session && e.ctrlKey && e.altKey && e.code === 'Home') {
      e.stopImmediatePropagation();
      e.preventDefault();
      $('bar').classList.contains('open') ? closeBar() : openBar(false);
    }
  }, true);

  $('bar-disconnect').addEventListener('click', () => endSession());
  $('overlay-back').addEventListener('click', () => endSession());
  $('overlay-retry').addEventListener('click', () => { if (session) session.retry(); });

  $('bar-keyboard').addEventListener('click', () => {
    const kb = $('soft-keyboard');
    kb.value = '';
    kb.focus({ preventScroll: true });
    closeBar();
  });

  function updateTouchLabel() {
    $('bar-touch').textContent = input && input.mode === 'trackpad' ? 'Touch: Trackpad' : 'Touch: Direct';
  }
  $('bar-touch').addEventListener('click', () => {
    if (!input) return;
    input.setMode(input.mode === 'direct' ? 'trackpad' : 'direct');
    updateTouchLabel();
  });

  $('bar-keys').addEventListener('click', () => {
    const menu = $('keys-menu');
    menu.hidden = !menu.hidden;
    $('bar-keys').setAttribute('aria-expanded', String(!menu.hidden));
    if (menu.hidden) openBar();
    else clearTimeout(barTimer);
  });
  $('keys-menu').addEventListener('click', (e) => {
    const combo = e.target.closest('[data-combo]');
    if (!combo || !input) return;
    input.combo(combo.dataset.combo.split(','));
    $('keys-menu').hidden = true;
    $('bar-keys').setAttribute('aria-expanded', 'false');
    closeBar();
  });

  $('bar-sound').addEventListener('click', () => {
    const video = $('remote');
    video.muted = !video.muted;
    if (!video.muted) video.play().catch(() => {});
    $('bar-sound').textContent = video.muted ? 'Sound off' : 'Sound on';
  });

  $('bar-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else $('screen-session').requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  });

  // ---------- lockdown ----------
  let lockdownFor = null;

  function showLockdown(c, s) {
    lockdownFor = c;
    show('screen-lockdown');
    $('lockdown-text').textContent = `Suspicious activity was detected on ${c.name}. Remote access has been temporarily disabled.`;
    $('lockdown-why').textContent = s.reason || 'Suspicious activity was detected.';
    $('lockdown-state').textContent = s.computerState || 'On';
    $('lockdown-access').textContent = 'Disabled';
    $('lockdown-restore').hidden = !s.canRestore;
  }

  $('lockdown-keep').addEventListener('click', async () => {
    if (lockdownFor) await conn.securityAction(lockdownFor, 'keep-locked').catch(() => {});
    goHome();
  });
  $('lockdown-restore').addEventListener('click', async () => {
    if (!lockdownFor) return;
    try {
      await conn.securityAction(lockdownFor, 'restore');
      $('lockdown-access').textContent = 'Restored';
      setTimeout(goHome, 900);
    } catch (err) {
      $('lockdown-access').textContent = conn.friendly(err, lockdownFor.name);
    }
  });
  $('lockdown-close').addEventListener('click', goHome);

  // ---------- start ----------
  const fromQr = conn.pairTargetFromLocation(location);
  if (fromQr) beginPairing(fromQr);
  else goHome();
  setInterval(() => { if (!$('screen-home').hidden) refreshStatuses(); }, 15000);
})();
