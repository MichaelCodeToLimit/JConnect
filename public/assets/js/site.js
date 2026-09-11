(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // ---- nav ----
  const nav = document.getElementById('nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 12);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const toggle = document.querySelector('.nav-toggle');
  const links = document.getElementById('nav-links');
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  links.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      links.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });

  // ---- reveal on scroll ----
  const revealer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      revealer.unobserve(entry.target);
    }
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  $$('.reveal, .card, .network').forEach((el) => revealer.observe(el));

  // ---- cursor spotlight on cards ----
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest && e.target.closest('.spot');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--x', `${e.clientX - rect.left}px`);
    card.style.setProperty('--y', `${e.clientY - rect.top}px`);
  }, { passive: true });

  // ---- 3D tilt on the hero stage ----
  if (!reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    for (const el of $$('[data-tilt]')) {
      const area = el.closest('.hero') || el;
      area.addEventListener('pointermove', (e) => {
        const rect = el.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width - 0.5;
        const y = (e.clientY - rect.top) / rect.height - 0.5;
        el.style.transform = `rotateX(${(-y * 5).toFixed(2)}deg) rotateY(${(x * 7).toFixed(2)}deg)`;
      });
      area.addEventListener('pointerleave', () => { el.style.transform = ''; });
    }
  }

  // ---- lazy media from /media (Higgsfield animations), with graceful fallback ----
  const mediaObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      mediaObserver.unobserve(el);
      const src = el.dataset.src;
      if (!src) continue;
      if (el.tagName === 'VIDEO') {
        if (reduceMotion) continue;
        el.addEventListener('loadeddata', () => {
          el.classList.add('ready');
          el.play().catch(() => {});
        }, { once: true });
        el.addEventListener('error', () => el.remove(), { once: true });
        el.src = src;
        el.load();
      } else {
        el.addEventListener('load', () => el.classList.add('ready'), { once: true });
        el.addEventListener('error', () => el.remove(), { once: true });
        el.src = src;
      }
    }
  }, { rootMargin: '300px 0px' });
  $$('[data-src]').forEach((el) => mediaObserver.observe(el));

  // Pause background videos when they scroll out of view.
  const playObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target;
      if (!video.classList.contains('ready')) continue;
      if (entry.isIntersecting) video.play().catch(() => {});
      else video.pause();
    }
  });
  $$('video.bg-video').forEach((v) => playObserver.observe(v));

  // ---- hero particle network ----
  const canvas = document.getElementById('hero-canvas');
  if (canvas && !reduceMotion) {
    const ctx = canvas.getContext('2d');
    let width = 0;
    let height = 0;
    let points = [];
    let visible = true;
    const mouse = { x: -9999, y: -9999 };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(90, (width * height) / 16000));
      points = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height * 0.75,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r: Math.random() * 1.4 + 0.4,
      }));
    };

    const step = () => {
      if (visible) {
        ctx.clearRect(0, 0, width, height);
        for (const p of points) {
          p.x += p.vx;
          p.y += p.vy;
          if (p.x < 0 || p.x > width) p.vx *= -1;
          if (p.y < 0 || p.y > height * 0.8) p.vy *= -1;
          const dx = p.x - mouse.x;
          const dy = p.y - mouse.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 14000) {
            p.x += dx * 0.012;
            p.y += dy * 0.012;
          }
        }
        for (let i = 0; i < points.length; i++) {
          const a = points[i];
          for (let j = i + 1; j < points.length; j++) {
            const b = points[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 130) {
              ctx.strokeStyle = `rgba(91, 140, 255, ${(1 - dist / 130) * 0.28})`;
              ctx.lineWidth = 0.7;
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
            }
          }
        }
        for (const p of points) {
          const fade = 1 - Math.min(1, p.y / (height * 0.8));
          ctx.fillStyle = `rgba(190, 210, 255, ${0.35 + fade * 0.5})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      requestAnimationFrame(step);
    };

    window.addEventListener('resize', resize);
    canvas.closest('.hero').addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    });
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(canvas);
    resize();
    requestAnimationFrame(step);
  }

  // ---- pairing code digits roll ----
  if (!reduceMotion) {
    for (const el of $$('[data-code-flip]')) {
      setInterval(() => {
        const digits = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
        let frame = 0;
        const roll = setInterval(() => {
          frame++;
          const shown = digits.split('').map((d, i) => (frame > i * 2 + 4 ? d : String(Math.floor(Math.random() * 10))));
          el.textContent = `${shown.slice(0, 3).join('')}-${shown.slice(3).join('')}`;
          if (frame > 16) clearInterval(roll);
        }, 45);
      }, 4400 + Math.random() * 1200);
    }
  }

  // ---- code tabs with typing ----
  const typeInto = (pre) => {
    if (pre.dataset.typed || reduceMotion) return;
    pre.dataset.typed = '1';
    const code = pre.querySelector('code');
    const html = code.innerHTML;
    const lines = html.split('\n');
    code.innerHTML = '';
    let i = 0;
    const next = () => {
      if (i >= lines.length) return;
      code.innerHTML += (i ? '\n' : '') + lines[i];
      i++;
      setTimeout(next, lines[i - 1].trim() ? 110 : 40);
    };
    next();
  };

  for (const panel of $$('[data-tabs]')) {
    const tabs = $$('.code-tab', panel);
    const bodies = $$('.code-body', panel);
    const show = (name) => {
      tabs.forEach((t) => {
        const active = t.dataset.tab === name;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
      });
      bodies.forEach((b) => {
        const active = b.dataset.panel === name;
        b.classList.toggle('active', active);
        if (active) typeInto(b);
      });
    };
    tabs.forEach((t) => t.addEventListener('click', () => {
      show(t.dataset.tab);
      panel.dataset.userPicked = '1';
    }));
    new IntersectionObserver(([entry], observer) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      typeInto(bodies[0]);
      if (reduceMotion) return;
      let index = 0;
      setInterval(() => {
        if (panel.dataset.userPicked || panel.matches(':hover')) return;
        index = (index + 1) % tabs.length;
        show(tabs[index].dataset.tab);
      }, 7000);
    }, { threshold: 0.3 }).observe(panel);
  }

  // ---- SSH terminal session ----
  const terminal = document.querySelector('[data-terminal] code');
  if (terminal) {
    const script = [
      ['muted', 'Connecting to Raspberry Pi through Tailscale…'],
      ['muted', 'Host key SHA256:q9Xc…e41 matches the one you trusted.'],
      ['ok', 'Signed in with your JConnect key.'],
      ['', ''],
      ['prompt', 'pi@raspberrypi:~ $ ', 'uptime'],
      ['', ' 02:24:11 up 41 days,  3 users,  load average: 0.08, 0.05, 0.01'],
      ['prompt', 'pi@raspberrypi:~ $ ', 'systemctl status homeassistant --no-pager | head -3'],
      ['ok', '● homeassistant.service - Home Assistant'],
      ['', '     Active: active (running) since Tue 09:12'],
      ['prompt', 'pi@raspberrypi:~ $ ', ''],
    ];
    const colors = { muted: 'c-muted', ok: 'c-green', prompt: 'c-blue' };
    const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const render = async () => {
      terminal.innerHTML = '';
      for (const [kind, text, typed] of script) {
        const line = document.createElement('span');
        if (colors[kind]) line.className = colors[kind];
        line.innerHTML = escape(text);
        terminal.appendChild(line);
        if (kind === 'prompt') {
          const cmd = document.createElement('span');
          terminal.appendChild(cmd);
          for (const ch of typed) {
            cmd.textContent += ch;
            await new Promise((r) => setTimeout(r, reduceMotion ? 0 : 38 + Math.random() * 40));
          }
          if (!typed) {
            const caret = document.createElement('span');
            caret.className = 'caret';
            terminal.appendChild(caret);
          }
          await new Promise((r) => setTimeout(r, reduceMotion ? 0 : 450));
        } else {
          await new Promise((r) => setTimeout(r, reduceMotion ? 0 : 320));
        }
        if (typed !== '' || kind !== 'prompt') terminal.appendChild(document.createTextNode('\n'));
      }
    };
    new IntersectionObserver(([entry], observer) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      render();
    }, { threshold: 0.3 }).observe(terminal);
  }

  // ---- counters ----
  for (const el of $$('[data-count]')) {
    const target = Number(el.dataset.count);
    new IntersectionObserver(([entry], observer) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      if (reduceMotion || target === 0) { el.textContent = target.toLocaleString('en-US'); return; }
      const start = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - start) / 1600);
        const eased = 1 - (1 - t) ** 3;
        el.textContent = Math.round(target * eased).toLocaleString('en-US');
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }).observe(el);
  }

  // ---- download page: point each visitor at their own platform ----
  const platformCards = $$('[data-platform]');
  if (platformCards.length) {
    const ua = navigator.userAgent;
    const detect = () => {
      if (/AppleTV|tvOS/i.test(ua)) return 'apple-tv';
      if (/SmartTV|SMART-TV|Tizen|Web0S|webOS|BRAVIA|Android TV|GoogleTV|CrKey|AFT[A-Z]/i.test(ua)) return 'tv';
      if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
      if (/Android/i.test(ua)) return 'android';
      if (/Windows/i.test(ua)) return 'windows';
      if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
      if (/Linux (aarch64|armv7l|armv8)/i.test(ua)) return 'raspberry-pi';
      if (/Linux|X11/i.test(ua)) return 'linux';
      return null;
    };
    // [button label, where it goes, note under it] for everyone who can't use the Windows installer
    const RECOMMEND = {
      mac: ['JConnect for Mac is coming soon', '#mac', 'Apple silicon and Intel Macs. Windows is available now.'],
      linux: ['JConnect for Linux is coming soon', '#linux', 'An AppImage and a .deb for 64-bit PCs. Windows is available now.'],
      'raspberry-pi': ['Raspberry Pi is coming soon', '#raspberry-pi', '64-bit Raspberry Pi OS. Windows is available now.'],
      android: ['Open JConnect in your browser', '#how', 'Nothing to install on Android. Set up JConnect on your computer first.'],
      ios: ['Open JConnect in Safari', '#how', 'Nothing to install on iPhone or iPad. Set up JConnect on your computer first.'],
      tv: ['Open JConnect in the TV’s browser', '#how', 'Type the address your JConnect computer shows.'],
      'apple-tv': ['Apple TV is coming soon', '#apple-tv', 'Apple TV has no web browser, so it needs its own app.'],
    };
    const current = detect();
    const card = platformCards.find((el) => el.dataset.platform === current);
    if (card) {
      card.classList.add('is-current');
      const badge = document.createElement('span');
      badge.className = 'you';
      badge.textContent = 'Your device';
      card.querySelector('h3').before(badge);
      $$(`.dl-devices a[href="#${card.id}"]`).forEach((a) => a.classList.add('is-current'));
    }
    const button = document.querySelector('[data-recommend-button]');
    const note = document.querySelector('[data-recommend-note]');
    const pick = RECOMMEND[current];
    if (button && note && pick) {
      button.removeAttribute('download');
      delete button.dataset.download;
      [button.textContent, button.href, note.textContent] = [pick[0], pick[1], pick[2]];
    }
  }

  // ---- download ----
  for (const link of $$('[data-download]')) {
    link.addEventListener('click', () => {
      const label = link.textContent;
      if (link.dataset.busy) return;
      link.dataset.busy = '1';
      link.textContent = 'Downloading…';
      setTimeout(() => {
        link.textContent = label;
        delete link.dataset.busy;
      }, 3500);
    });
  }

  for (const hash of $$('[data-sha256]')) {
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
    for (const note of $$('[data-download-note]')) {
      note.textContent = 'This installer is for Windows 10 and 11. Open this page on your Windows PC to install JConnect.';
    }
  }
})();
