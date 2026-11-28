(() => {
  'use strict';

  const still0 = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;

  // ---- hero headline: one word at a time ----
  const h1 = document.querySelector('.hero h1');
  if (h1 && !still0) {
    h1.innerHTML = h1.textContent.trim().split(/\s+/).map((w, i) => '<span class="w" style="--w:' + i + '"><span>' + w + '</span></span>').join(' ');
  }

  // ---- nav border once scrolled; pause control ----
  const navEl = document.getElementById('nav');
  const onScroll = () => navEl.classList.toggle('is-scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  const pauseBtn = document.querySelector('.motion');
  pauseBtn.addEventListener('click', () => {
    const paused = root.classList.toggle('is-paused');
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.textContent = paused ? 'Play motion' : 'Pause motion';
  });

  // ---- hero mesh: devices, links and packets ----
  const canvas = document.querySelector('.hero__net');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const tokens = getComputedStyle(root);
    const linkColor = tokens.getPropertyValue('--color-night-accent').trim();
    const dotColor = tokens.getPropertyValue('--color-ink').trim();
    let w = 0, h = 0, nodes = [], packets = [], visible = true, raf = 0;
    const pointer = { x: -1e4, y: -1e4 };
    const LINK = 170;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.max(28, Math.min(90, Math.round((w * h) / 14000)));
      nodes = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35, r: 1.5 + Math.random() * 1.5 }));
    };
    const draw = (move) => {
      ctx.clearRect(0, 0, w, h);
      if (move) for (const n of nodes) {
        n.x += n.vx; n.y += n.vy;
        if (n.x < 0 || n.x > w) n.vx *= -1;
        if (n.y < 0 || n.y > h) n.vy *= -1;
        const dx = pointer.x - n.x, dy = pointer.y - n.y, d = Math.hypot(dx, dy);
        if (d < 140 && d > 1) { n.x += (dx / d) * 0.6; n.y += (dy / d) * 0.6; }
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = linkColor;
      const edges = [];
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        if (d < LINK) { edges.push([i, j]); ctx.globalAlpha = (1 - d / LINK) * 0.45; ctx.beginPath(); ctx.moveTo(nodes[i].x, nodes[i].y); ctx.lineTo(nodes[j].x, nodes[j].y); ctx.stroke(); }
      }
      for (const n of nodes) { const d = Math.hypot(pointer.x - n.x, pointer.y - n.y); if (d < 200) { ctx.globalAlpha = (1 - d / 200) * 0.7; ctx.beginPath(); ctx.moveTo(pointer.x, pointer.y); ctx.lineTo(n.x, n.y); ctx.stroke(); } }
      if (move && edges.length && packets.length < 7 && Math.random() < 0.05) packets.push({ e: edges[Math.floor(Math.random() * edges.length)], t: 0 });
      ctx.globalAlpha = 1; ctx.fillStyle = dotColor;
      for (const n of nodes) { ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 6.2832); ctx.fill(); }
      ctx.fillStyle = linkColor;
      packets = packets.filter((p) => p.t < 1);
      for (const p of packets) {
        const a = nodes[p.e[0]], b = nodes[p.e[1]];
        if (move) p.t += 0.018;
        ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * p.t, a.y + (b.y - a.y) * p.t, 3.2, 0, 6.2832); ctx.fill();
      }
    };
    const frame = () => {
      raf = 0;
      if (!visible) return;
      draw(!root.classList.contains('is-paused'));
      raf = requestAnimationFrame(frame);
    };
    resize();
    window.addEventListener('resize', () => { resize(); if (still0) draw(false); });
    if (still0) draw(false);
    else {
      canvas.parentElement.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top; }, { passive: true });
      canvas.parentElement.addEventListener('pointerleave', () => { pointer.x = pointer.y = -1e4; });
      new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible && !raf) raf = requestAnimationFrame(frame); }).observe(canvas);
    }
  }

  // ---- nav menu on small screens ----
  const toggle = document.querySelector('.nav__toggle');
  const links = document.getElementById('nav-links');
  const setMenu = (open) => {
    links.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setMenu(!links.classList.contains('open')));
  links.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

  // ---- protocol tabs: arrow keys, no auto-rotation ----
  for (const root of document.querySelectorAll('[data-switch]')) {
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')));
    const show = (index, focus) => {
      tabs.forEach((t, i) => {
        t.setAttribute('aria-selected', String(i === index));
        t.tabIndex = i === index ? 0 : -1;
        panels[i].hidden = i !== index;
      });
      if (focus) tabs[index].focus();
    };
    tabs.forEach((t, i) => t.addEventListener('click', () => show(i)));
    root.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (step) { e.preventDefault(); show((i + step + tabs.length) % tabs.length, true); }
      else if (e.key === 'Home') { e.preventDefault(); show(0, true); }
      else if (e.key === 'End') { e.preventDefault(); show(tabs.length - 1, true); }
    });
    show(0);
  }

  // ---- scroll reveal, once, staggered ----
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rolls = (el) => {
    const code = el.querySelector('.pair__code');
    if (!code || still) return;
    const end = code.textContent;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min((now - t0) / 800, 1);
      code.textContent = [...end].map((ch, i) => (ch === ' ' || p > (i + 1) / (end.length + 1) ? ch : Math.floor(Math.random() * 10))).join('');
      if (p < 1) requestAnimationFrame(tick); else code.textContent = end;
    };
    requestAnimationFrame(tick);
  };
  const count = (el) => {
    const f = el.querySelector && el.querySelector('[data-count]');
    if (!f || still) return;
    const to = Number(f.dataset.count), from = Number(f.dataset.from || 0), suffix = f.dataset.suffix || '';
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min((now - t0) / 1200, 1), ease = 1 - (1 - p) ** 3;
      f.textContent = Math.round(from + (to - from) * ease).toLocaleString('en-US') + suffix;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const steps = [...document.querySelectorAll('.pinned__steps > li')];
  if (steps.length) {
    steps[0].classList.add('is-active');
    const active = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        steps.forEach((s) => s.classList.toggle('is-active', s === e.target));
        rolls(e.target);
      }
    }, { rootMargin: '-40% 0px -40% 0px' });
    steps.forEach((s) => active.observe(s));
  }
  for (const parent of document.querySelectorAll('.rows__list, .jvpn__facts, .networks tbody, .figures__grid')) {
    [...parent.children].forEach((c, i) => { c.dataset.reveal = ''; c.style.setProperty('--i', i); });
  }
  for (const el of document.querySelectorAll('.rows h2, .jvpn__head, .security__text, .code, .networks__head, .close__main, .close__platforms')) el.dataset.reveal = '';
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      count(e.target);
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -10% 0px' });
  document.querySelectorAll('[data-reveal], .diagram, [data-observe], .session').forEach((el) => io.observe(el));

  // ---- download: label feedback, checksum, platform note ----
  for (const link of document.querySelectorAll('[data-download]')) {
    link.addEventListener('click', () => {
      if (link.dataset.busy) return;
      const label = link.textContent;
      link.dataset.busy = '1';
      link.setAttribute('aria-busy', 'true');
      link.textContent = 'Downloading…';
      setTimeout(() => {
        link.textContent = label;
        link.removeAttribute('aria-busy');
        delete link.dataset.busy;
      }, 3500);
    });
  }

  for (const hash of document.querySelectorAll('[data-sha256]')) {
    fetch(hash.dataset.sha256Src || 'download/JConnect-Setup.exe.sha256', { cache: 'no-store' })
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => {
        const sum = (text.match(/[0-9a-f]{64}/i) || [])[0];
        if (!sum) return;
        hash.querySelector('code').textContent = sum;
        hash.hidden = false;
      })
      .catch(() => {});
  }

  if (!/Windows/i.test(navigator.userAgent)) {
    for (const note of document.querySelectorAll('[data-download-note]')) {
      note.textContent = 'This installer is for Windows 10 and 11. Open this page on your Windows PC to install JConnect.';
    }
  }

  // ---- diagram: packets between random devices at random times ----
  const diagram = document.querySelector('.diagram');
  if (diagram && !still0) {
    const spot = { Laptop: [16, 22], Phone: [16, 82], 'Home PC': [84, 22], 'Office PC': [84, 82], Relay: [50, 52] };
    const nodeEls = Object.fromEntries([...diagram.querySelectorAll('.node')].map((n) => [n.textContent.trim(), n]));
    const devices = ['Laptop', 'Phone', 'Home PC', 'Office PC'];
    const live = new Set();
    let seen = false;
    new IntersectionObserver(([en]) => { seen = en.isIntersecting; }, { threshold: 0.3 }).observe(diagram);
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const send = () => {
      const from = pick(devices);
      const to = pick(devices.filter((d) => d !== from));
      const direct = (from === 'Laptop' && to === 'Home PC') || (from === 'Home PC' && to === 'Laptop');
      const route = direct ? [spot[from], [50, 7], spot[to]] : [spot[from], spot.Relay, spot[to]];
      const dot = document.createElement('i');
      dot.className = 'packet';
      dot.setAttribute('aria-hidden', 'true');
      diagram.appendChild(dot);
      const keys = route.map((p, i) => ({ transform: 'translate(' + p[0] + '%, ' + p[1] + '%)', opacity: i === 0 || i === route.length - 1 ? 0 : 1, offset: i / (route.length - 1) }));
      keys[0].opacity = 0; keys.splice(1, 0, { transform: keys[0].transform, opacity: 1, offset: 0.06 }); keys.splice(keys.length - 1, 0, { transform: keys[keys.length - 1].transform, opacity: 1, offset: 0.94 });
      keys.sort((x, y) => x.offset - y.offset);
      const anim = dot.animate(keys, { duration: 1400 + Math.random() * 1800, easing: 'ease-in-out', fill: 'forwards' });
      live.add(anim);
      if (root.classList.contains('is-paused')) anim.pause();
      anim.onfinish = () => { live.delete(anim); dot.remove(); const n = nodeEls[to]; if (n) { n.classList.add('is-ping'); setTimeout(() => n.classList.remove('is-ping'), 500); } };
    };
    const loop = () => {
      if (seen && !root.classList.contains('is-paused') && live.size < 5) send();
      setTimeout(loop, 300 + Math.random() * 1000);
    };
    loop();
    pauseBtn.addEventListener('click', () => live.forEach((a) => (root.classList.contains('is-paused') ? a.pause() : a.play())));
  }
})();
