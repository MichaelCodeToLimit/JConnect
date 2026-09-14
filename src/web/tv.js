// JConnect on a TV: a layout that reads from across the room, the remote's arrows moving between controls, and the
// remote as the computer's mouse. Used by the Android app on TVs and by TV web browsers.
(function () {
  const TV_BROWSER = /\b(Android TV|GoogleTV|SMART-TV|SmartTV|Tizen|Web0S|BRAVIA|HbbTV|CrKey)\b/i;
  const FIRE_TV = /\bAFT[A-Z]{1,4}\b/;

  // The Android app marks TVs in its user agent. TV browsers are recognised by theirs, and ?tv=1 forces the layout.
  function detect(userAgent, search) {
    return /\bJConnectTV\b/.test(userAgent) || TV_BROWSER.test(userAgent) || FIRE_TV.test(userAgent)
      || new URLSearchParams(search || '').get('tv') === '1';
  }

  // Of the rects that lie in the direction pressed, the closest one, preferring those straight ahead.
  function nearest(from, rects, dir) {
    const cx = (r) => r.left + r.width / 2;
    const cy = (r) => r.top + r.height / 2;
    let best = -1;
    let bestScore = Infinity;
    rects.forEach((r, i) => {
      const dx = cx(r) - cx(from);
      const dy = cy(r) - cy(from);
      const ahead = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      const aside = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (ahead < 1) return;
      const score = ahead + aside * 2;
      if (score < bestScore) {
        best = i;
        bestScore = score;
      }
    });
    return best;
  }

  const on = detect(navigator.userAgent || '', location.search);
  const api = { on, detect, nearest, back: () => false };
  window.JCTV = api;
  if (!on) return;

  document.documentElement.classList.add('tv');

  const $ = (id) => document.getElementById(id);
  const FOCUSABLE = 'button, input:not([type="hidden"]), select, textarea, a[href], summary';
  const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const BACK_KEYS = new Set(['GoBack', 'BrowserBack', 'XF86Back']);
  const LONG_PRESS_MS = 650;

  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const isTextField = (el) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|checkbox|radio|submit|reset)$/.test(el.type)));
  const openDialog = () => [...document.querySelectorAll('dialog[open]')].pop() || null;
  const sessionShown = () => !$('screen-session').hidden;
  const barOpen = () => $('bar').classList.contains('open');

  // ---------- moving between controls ----------
  // Where the arrows can go right now. null means the remote is driving the computer.
  function scope() {
    const dialog = openDialog();
    if (dialog) return dialog;
    if (sessionShown()) {
      if (!$('overlay').hidden) return $('overlay');
      if (!$('keys-menu').hidden) return $('keys-menu');
      return barOpen() ? $('bar') : null;
    }
    return document.querySelector('.screen:not([hidden])');
  }

  function candidates(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.id !== 'soft-keyboard' && visible(el));
  }

  // Where the remote starts on a screen: its main action.
  function preferred(list) {
    return list.find((el) => el.matches('.nearby-item, .connect')) || list.find((el) => el.matches('.primary')) || list[0];
  }

  function focusOn(el) {
    if (el) el.focus({ focusVisible: true });
  }

  function move(dir) {
    const root = scope();
    const list = root ? candidates(root) : [];
    if (!list.length) return false;
    const current = document.activeElement;
    if (!list.includes(current)) {
      focusOn(preferred(list));
      return true;
    }
    const others = list.filter((el) => el !== current);
    const i = nearest(current.getBoundingClientRect(), others.map((el) => el.getBoundingClientRect()), dir);
    if (i >= 0) focusOn(others[i]);
    return true;
  }

  // In a text field, left and right move the caret until it reaches either end.
  function caretCanMove(el, dir) {
    try {
      if (el.selectionStart !== el.selectionEnd) return true;
      return dir === 'left' ? el.selectionStart > 0 : el.selectionEnd < el.value.length;
    } catch {
      return false;
    }
  }

  // When a screen or dialog changes, or My Computers is redrawn, the remote keeps a place to be.
  let listFocus = null;
  document.addEventListener('focusin', (e) => {
    const row = e.target.closest ? e.target.closest('#computer-list > li') : null;
    listFocus = row ? { index: [...row.parentNode.children].indexOf(row), connect: e.target.classList.contains('connect') } : null;
  });

  // A timer rather than an animation frame, which a page that isn't being drawn never gets.
  let settleTimer = 0;
  function settle() {
    settleTimer = 0;
    const root = scope();
    if (!root) return;
    const current = document.activeElement;
    if (current && current !== document.body && root.contains(current) && visible(current)) return;
    const list = candidates(root);
    if (!list.length) return;
    const rows = $('computer-list').children;
    const row = listFocus && root.contains($('computer-list')) ? rows[Math.min(listFocus.index, rows.length - 1)] : null;
    const again = row ? row.querySelector(listFocus.connect ? '.connect' : '.more') : null;
    focusOn(again && list.includes(again) ? again : preferred(list));
  }
  new MutationObserver(() => { if (!settleTimer) settleTimer = setTimeout(settle, 0); })
    .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open'] });

  // ---------- the remote as the computer's mouse ----------
  const MODES = { pointer: 'Remote: Pointer', scroll: 'Remote: Scroll', keys: 'Remote: Arrow keys' };
  const MODE_HINTS = {
    pointer: 'The arrows move the pointer. OK clicks, and holding OK right-clicks. Back shows the controls.',
    scroll: 'The arrows scroll. OK clicks. Back shows the controls.',
    keys: 'The arrows and OK go to the computer as keys. Back shows the controls.',
  };
  let mode = 'pointer';
  const held = new Set();
  let heldSince = 0;
  let lastFrame = 0;
  let frame = 0;
  let press = null; // OK held down: { at, dragging, timer }
  const scrollCarry = { x: 0, y: 0 };

  const control = () => (window.JCInput && window.JCInput.active) || null;
  // The remote drives the computer when nothing else is on top of the session.
  const driving = () => sessionShown() && $('overlay').hidden && !openDialog() && !barOpen() && $('keys-menu').hidden;

  const modeButton = document.createElement('button');
  modeButton.type = 'button';
  modeButton.id = 'bar-remote';
  modeButton.textContent = MODES[mode];
  $('bar-name').after(modeButton);
  modeButton.addEventListener('click', () => {
    const order = Object.keys(MODES);
    mode = order[(order.indexOf(mode) + 1) % order.length];
    modeButton.textContent = MODES[mode];
    showHint(MODE_HINTS[mode]);
  });

  const cursor = document.createElement('div');
  cursor.className = 'tv-cursor';
  cursor.hidden = true;
  const hint = document.createElement('div');
  hint.className = 'tv-hint';
  hint.setAttribute('role', 'status');
  hint.hidden = true;
  $('screen-session').append(cursor, hint);

  // The picture from the computer lags a little, so a ring shows at once where the pointer is going.
  let cursorTimer = 0;
  function showCursor(p) {
    const r = window.JCInput.contentRect($('remote'));
    cursor.style.transform = `translate(${Math.round(r.left + p.x * r.width)}px, ${Math.round(r.top + p.y * r.height)}px)`;
    cursor.hidden = false;
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => { if (!press) cursor.hidden = true; }, 2500);
  }

  let hintTimer = 0;
  function showHint(text) {
    hint.textContent = text;
    hint.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.hidden = true; }, 6000);
  }

  function step(now) {
    frame = 0;
    const input = control();
    if (!held.size || !input || !driving()) {
      lastFrame = 0;
      return;
    }
    const dt = lastFrame ? Math.min(now - lastFrame, 50) : 16;
    lastFrame = now;
    const dx = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
    const dy = (held.has('down') ? 1 : 0) - (held.has('up') ? 1 : 0);
    const heldFor = (now - heldSince) / 1000;
    if (mode === 'pointer') {
      // Slow for a short press, faster the longer an arrow is held. Speed is a share of the screen width per second.
      const speed = Math.min(0.12 + heldFor * 0.5, 0.8) * (dt / 1000);
      const r = window.JCInput.contentRect($('remote'));
      const aspect = r.height ? r.width / r.height : 16 / 9;
      if (press && !press.dragging && (dx || dy)) {
        press.dragging = true; // holding OK while moving drags
        input.pointerButton(0, true);
      }
      showCursor(input.movePointerBy(dx * speed, dy * speed * aspect));
    } else if (mode === 'scroll') {
      const pixels = Math.min(400 + heldFor * 900, 2000) * (dt / 1000);
      scrollCarry.x += dx * pixels;
      scrollCarry.y += dy * pixels;
      flushScroll(input, 20);
    }
    frame = requestAnimationFrame(step);
  }

  function flushScroll(input, atLeast) {
    const sx = Math.trunc(scrollCarry.x);
    const sy = Math.trunc(scrollCarry.y);
    if (Math.abs(sx) < atLeast && Math.abs(sy) < atLeast) return;
    input.scroll(sx, sy);
    scrollCarry.x -= sx;
    scrollCarry.y -= sy;
  }

  function pressDown(input) {
    press = { at: performance.now(), dragging: false, timer: 0 };
    showCursor(input.pointerPosition());
    cursor.classList.add('press');
    press.timer = setTimeout(() => cursor.classList.add('long'), LONG_PRESS_MS);
  }

  function pressUp(input) {
    const { at, dragging, timer } = press;
    press = null;
    clearTimeout(timer);
    cursor.classList.remove('press', 'long');
    if (!input) return;
    if (dragging) {
      input.pointerButton(0, false);
      return;
    }
    const button = performance.now() - at >= LONG_PRESS_MS ? 2 : 0;
    input.pointerButton(button, true);
    input.pointerButton(button, false);
  }

  // Nothing stays pressed on the computer when the remote stops driving it.
  function letGo() {
    held.clear();
    lastFrame = 0;
    scrollCarry.x = 0;
    scrollCarry.y = 0;
    if (!press) return;
    clearTimeout(press.timer);
    cursor.classList.remove('press', 'long');
    if (press.dragging && control()) control().pointerButton(0, false);
    press = null;
  }
  window.addEventListener('blur', letGo);

  function openControls() {
    letGo();
    if (!barOpen()) $('pull-tab').click();
    focusOn(candidates($('bar'))[0]);
  }

  function closeControls() {
    $('keys-menu').hidden = true;
    $('bar-keys').setAttribute('aria-expanded', 'false');
    $('bar').classList.remove('open');
    $('surface').focus({ preventScroll: true });
  }

  // Back from the Android app or a TV browser's remote. Returns true when it was used here.
  api.back = function back() {
    if (openDialog() || !sessionShown()) return false;
    if (!$('keys-menu').hidden) {
      $('keys-menu').hidden = true;
      $('bar-keys').setAttribute('aria-expanded', 'false');
      focusOn($('bar-keys'));
      return true;
    }
    if (!$('overlay').hidden) return false;
    if (barOpen()) closeControls();
    else openControls();
    return true;
  };

  // Registered before a session's input exists, so these listeners run first and can keep keys for the remote.
  window.addEventListener('keydown', (e) => {
    if (BACK_KEYS.has(e.key) || e.keyCode === 461 || e.keyCode === 10009) {
      const dialog = openDialog();
      if (dialog) dialog.close();
      else if (!api.back()) {
        if (!sessionShown() || $('overlay').hidden) return;
        $('overlay-back').click();
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    const dir = DIRS[e.key];
    if (driving()) {
      if (e.key === 'ContextMenu') {
        e.preventDefault();
        e.stopImmediatePropagation();
        openControls();
        return;
      }
      const input = control();
      const typing = document.activeElement === $('soft-keyboard');
      if (mode === 'keys' || !input || (!dir && (e.key !== 'Enter' || typing))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // An arrow only reaches the page once the on-screen keyboard has closed.
      if (typing) $('surface').focus({ preventScroll: true });
      if (dir) {
        if (!held.size) heldSince = performance.now();
        held.add(dir);
        if (!frame) frame = requestAnimationFrame(step);
      } else if (!press) {
        pressDown(input);
      }
      return;
    }

    if (dir) {
      const el = document.activeElement;
      if (isTextField(el) && (dir === 'left' || dir === 'right') && caretCanMove(el, dir)) return;
      if (move(dir)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    } else if (e.key === 'Enter' && sessionShown()) {
      // OK on a session control presses it without also sending Enter to the computer.
      e.stopImmediatePropagation();
    }
  }, true);

  window.addEventListener('keyup', (e) => {
    const dir = DIRS[e.key];
    if (dir && held.delete(dir)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!held.size) {
        lastFrame = 0;
        if (control()) flushScroll(control(), 1);
      }
      return;
    }
    if (e.key === 'Enter' && press) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pressUp(control());
    }
  }, true);

  // Once a session connects, the remote drives the pointer straight away, and a hint says how.
  // This watches the hidden attribute, and setting it even to the value it has counts as a change, so it's only
  // written when it really changes.
  let wasDriving = false;
  new MutationObserver(() => {
    const shown = sessionShown();
    const connected = shown && $('overlay').hidden;
    if (connected && !wasDriving) {
      $('bar').classList.remove('open');
      $('surface').focus({ preventScroll: true });
      showHint(MODE_HINTS[mode]);
    }
    if (!connected && wasDriving) letGo();
    wasDriving = connected;
    if (!shown && (mode !== 'pointer' || !hint.hidden || !cursor.hidden)) {
      mode = 'pointer';
      modeButton.textContent = MODES[mode];
      hint.hidden = true;
      cursor.hidden = true;
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
})();
