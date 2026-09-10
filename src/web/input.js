// Turns what the person does on this device into JConnect input messages:
//   {t:'m', x, y}            pointer moved (x, y normalized 0..1 over the remote screen)
//   {t:'b', b, d, x, y}      button 0 left / 1 middle / 2 right, d = down
//   {t:'w', dx, dy}          wheel in browser pixels, dy > 0 scrolls down
//   {t:'k', c, d}            key by KeyboardEvent.code, d = down
//   {t:'x', s}               typed text (on-screen keyboards that don't report key codes)
(function () {
  const LONG_PRESS_MS = 550;
  const TAP_SLOP_PX = 10;
  const TRACKPAD_SPEED = 1.6;

  function wheelPixels(e) {
    const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    return { dx: e.deltaX * scale, dy: e.deltaY * scale };
  }

  // Where the remote picture actually is inside the <video> box (object-fit: contain adds bars).
  function contentRect(video) {
    const box = video.getBoundingClientRect();
    const vw = video.videoWidth || box.width;
    const vh = video.videoHeight || box.height;
    const scale = Math.min(box.width / vw, box.height / vh);
    const w = vw * scale;
    const h = vh * scale;
    return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h };
  }

  function createInput({ surface, video, send, keyboardInput }) {
    let enabled = true;
    let mode = 'direct'; // 'direct' touch = tap where you want; 'trackpad' = drag to move a cursor
    const cursor = { x: 0.5, y: 0.5 };
    const listeners = [];
    const heldKeys = new Set();
    const heldButtons = new Set();
    let pendingMove = null;
    let moveFrame = 0;

    const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); listeners.push([el, type, fn, opts]); };
    const emit = (msg) => { if (enabled) send(msg); };

    function normalize(clientX, clientY) {
      const r = contentRect(video);
      return {
        x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
      };
    }

    // Coalesce moves to one per frame so a fast mouse doesn't flood the connection.
    function queueMove(p) {
      pendingMove = p;
      if (moveFrame) return;
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0;
        if (pendingMove) emit({ t: 'm', x: pendingMove.x, y: pendingMove.y });
        pendingMove = null;
      });
    }

    function button(b, down, p) {
      if (down) heldButtons.add(b); else heldButtons.delete(b);
      emit({ t: 'b', b, d: down, x: p.x, y: p.y });
    }

    // ---- mouse / pen ----
    on(surface, 'pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const last = events[events.length - 1] || e;
      queueMove(normalize(last.clientX, last.clientY));
    });
    on(surface, 'pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      e.preventDefault();
      surface.setPointerCapture(e.pointerId);
      if (keyboardInput && document.activeElement !== keyboardInput) surface.focus({ preventScroll: true });
      if (e.button >= 0 && e.button <= 2) button(e.button, true, normalize(e.clientX, e.clientY));
    });
    on(surface, 'pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.button >= 0 && e.button <= 2) button(e.button, false, normalize(e.clientX, e.clientY));
    });
    on(surface, 'contextmenu', (e) => e.preventDefault());
    on(surface, 'wheel', (e) => {
      e.preventDefault();
      const { dx, dy } = wheelPixels(e);
      emit({ t: 'w', dx: Math.round(dx), dy: Math.round(dy) });
    }, { passive: false });

    // ---- touch ----
    const touch = { start: null, last: null, moved: false, longTimer: 0, longFired: false, dragging: false, twoFinger: null };

    function midpoint(list) {
      let x = 0; let y = 0;
      for (const t of list) { x += t.clientX; y += t.clientY; }
      return { x: x / list.length, y: y / list.length };
    }

    on(surface, 'touchstart', (e) => {
      e.preventDefault();
      clearTimeout(touch.longTimer);
      if (e.touches.length === 2) {
        touch.twoFinger = midpoint(e.touches);
        touch.start = null;
        return;
      }
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      touch.start = { x: t.clientX, y: t.clientY, at: Date.now() };
      touch.last = { x: t.clientX, y: t.clientY };
      touch.moved = false;
      touch.longFired = false;
      touch.dragging = false;
      if (mode === 'direct') queueMove(normalize(t.clientX, t.clientY));
      touch.longTimer = setTimeout(() => {
        if (touch.moved || !touch.start) return;
        touch.longFired = true;
        const p = mode === 'direct' ? normalize(touch.start.x, touch.start.y) : { ...cursor };
        button(2, true, p);
        button(2, false, p);
        if (navigator.vibrate) navigator.vibrate(15);
      }, LONG_PRESS_MS);
    }, { passive: false });

    on(surface, 'touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 2 && touch.twoFinger) {
        const m = midpoint(e.touches);
        const dx = touch.twoFinger.x - m.x;
        const dy = touch.twoFinger.y - m.y;
        if (Math.abs(dx) + Math.abs(dy) >= 2) {
          emit({ t: 'w', dx: Math.round(dx * 2), dy: Math.round(dy * 2) });
          touch.twoFinger = m;
        }
        return;
      }
      if (e.touches.length !== 1 || !touch.start) return;
      const t = e.touches[0];
      const dist = Math.hypot(t.clientX - touch.start.x, t.clientY - touch.start.y);
      if (dist > TAP_SLOP_PX) { touch.moved = true; clearTimeout(touch.longTimer); }
      if (!touch.moved) return;

      if (mode === 'direct') {
        const p = normalize(t.clientX, t.clientY);
        // Dragging with one finger in direct mode drags on the remote screen (select, move windows).
        if (!touch.dragging && !touch.longFired) { touch.dragging = true; button(0, true, normalize(touch.start.x, touch.start.y)); }
        queueMove(p);
      } else {
        const r = contentRect(video);
        cursor.x = Math.min(1, Math.max(0, cursor.x + ((t.clientX - touch.last.x) / r.width) * TRACKPAD_SPEED));
        cursor.y = Math.min(1, Math.max(0, cursor.y + ((t.clientY - touch.last.y) / r.height) * TRACKPAD_SPEED));
        queueMove({ ...cursor });
      }
      touch.last = { x: t.clientX, y: t.clientY };
    }, { passive: false });

    on(surface, 'touchend', (e) => {
      e.preventDefault();
      clearTimeout(touch.longTimer);
      if (e.touches.length > 0) return;
      touch.twoFinger = null;
      if (!touch.start) return;
      const p = mode === 'direct' ? normalize(touch.last.x, touch.last.y) : { ...cursor };
      if (touch.dragging) {
        button(0, false, p);
      } else if (!touch.moved && !touch.longFired) {
        button(0, true, p);
        button(0, false, p);
      }
      touch.start = null;
      touch.dragging = false;
    }, { passive: false });

    on(surface, 'touchcancel', () => {
      clearTimeout(touch.longTimer);
      if (touch.dragging) button(0, false, mode === 'direct' ? normalize(touch.last.x, touch.last.y) : { ...cursor });
      touch.start = null;
      touch.dragging = false;
      touch.twoFinger = null;
    });

    // ---- keyboard ----
    const isTextField = (el) => el && el !== keyboardInput && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);

    on(window, 'keydown', (e) => {
      if (!enabled || isTextField(e.target)) return;
      // On-screen keyboards often report no code (or keyCode 229); those arrive through 'beforeinput'.
      if (!e.code || e.keyCode === 229) return;
      e.preventDefault();
      heldKeys.add(e.code);
      emit({ t: 'k', c: e.code, d: true });
    }, true);

    on(window, 'keyup', (e) => {
      if (!enabled || isTextField(e.target) || !e.code || !heldKeys.has(e.code)) return;
      e.preventDefault();
      heldKeys.delete(e.code);
      emit({ t: 'k', c: e.code, d: false });
    }, true);

    if (keyboardInput) {
      const tapKey = (code) => { emit({ t: 'k', c: code, d: true }); emit({ t: 'k', c: code, d: false }); };
      on(keyboardInput, 'beforeinput', (e) => {
        e.preventDefault();
        switch (e.inputType) {
          case 'insertText':
          case 'insertReplacementText':
          case 'insertCompositionText':
            if (e.data) emit({ t: 'x', s: e.data });
            break;
          case 'insertLineBreak':
          case 'insertParagraph':
            tapKey('Enter');
            break;
          case 'deleteContentBackward':
          case 'deleteWordBackward':
            tapKey('Backspace');
            break;
          case 'deleteContentForward':
            tapKey('Delete');
            break;
          default:
        }
      });
      // Some Android keyboards skip beforeinput for composition; catch whatever still lands in the field.
      on(keyboardInput, 'input', () => {
        if (keyboardInput.value) {
          emit({ t: 'x', s: keyboardInput.value });
          keyboardInput.value = '';
        }
      });
    }

    // If this page loses focus mid-press, let go of everything so nothing stays held on the remote computer.
    function releaseAll() {
      for (const code of heldKeys) send({ t: 'k', c: code, d: false });
      for (const b of heldButtons) send({ t: 'b', b, d: false, x: cursor.x, y: cursor.y });
      heldKeys.clear();
      heldButtons.clear();
    }
    on(window, 'blur', releaseAll);
    on(document, 'visibilitychange', () => { if (document.hidden) releaseAll(); });

    return {
      get mode() { return mode; },
      setMode(next) { mode = next === 'trackpad' ? 'trackpad' : 'direct'; },
      setEnabled(value) { if (!value) releaseAll(); enabled = !!value; },
      // Send a key combination the local device can't produce itself, e.g. ['ControlLeft','AltLeft','Delete'].
      combo(codes) {
        for (const c of codes) emit({ t: 'k', c, d: true });
        for (const c of [...codes].reverse()) emit({ t: 'k', c, d: false });
      },
      releaseAll,
      destroy() {
        releaseAll();
        cancelAnimationFrame(moveFrame);
        for (const [el, type, fn, opts] of listeners) el.removeEventListener(type, fn, opts);
      },
    };
  }

  window.JCInput = { createInput, contentRect };
})();
