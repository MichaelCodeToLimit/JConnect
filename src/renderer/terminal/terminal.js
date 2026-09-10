(function () {
  'use strict';

  const jc = window.jconnect;
  const $ = (id) => document.getElementById(id);
  const name = new URLSearchParams(location.search).get('name') || 'SSH';
  $('name').textContent = name;
  document.title = `${name} — JConnect`;

  const term = new window.Terminal({
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#0f1115', foreground: '#e8eaf0', cursor: '#7aa2ff', selectionBackground: '#2f6bff66' },
  });
  const fit = window.FitAddon ? new window.FitAddon.FitAddon() : null;
  if (fit) term.loadAddon(fit);
  term.open($('term'));

  const resize = () => {
    if (fit) {
      try { fit.fit(); } catch { /* not visible yet */ }
    }
    jc.send('ssh:resize', { cols: term.cols, rows: term.rows });
  };
  window.addEventListener('resize', resize);
  requestAnimationFrame(resize);
  term.onData((data) => jc.send('ssh:input', { data }));

  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dim = (text) => `\x1b[90m${String(text).replace(/\n/g, '\r\n')}\x1b[0m`;
  let connected = false;
  let promptId = null;

  function setStatus(text, dot) {
    $('status').textContent = text;
    $('dot').className = `dot ${dot || ''}`;
  }

  function showActions(live) {
    $('reconnect').hidden = live;
    $('disconnect').hidden = !live;
  }

  function answer(value) {
    if (!promptId) return;
    jc.send('ssh:answer', { id: promptId, value });
    promptId = null;
    $('overlay').hidden = true;
    $('prompt-input').value = '';
    term.focus();
  }

  function prompt({ id, kind, message, detail, value, confirm }) {
    promptId = id;
    $('overlay').hidden = false;
    $('prompt-title').textContent = message;
    $('prompt-detail').textContent = detail || '';
    $('prompt-detail').hidden = !detail;
    const input = $('prompt-input');
    input.hidden = kind === 'confirm';
    input.type = kind === 'password' ? 'password' : 'text';
    input.value = value || '';
    $('prompt-ok').textContent = confirm || (kind === 'confirm' ? 'Continue' : 'OK');
    setTimeout(() => (kind === 'confirm' ? $('prompt-ok') : input).focus(), 30);
    $('prompt-form').onsubmit = (e) => {
      e.preventDefault();
      answer(kind === 'confirm' ? true : input.value);
    };
    $('prompt-cancel').onclick = () => answer(kind === 'confirm' ? false : null);
  }

  jc.on('ssh:event', (e) => {
    switch (e.type) {
      case 'status':
        setStatus(e.text, connected ? 'ok' : 'warn');
        break;
      case 'connected':
        connected = true;
        setStatus('Connected', 'ok');
        showActions(true);
        resize();
        term.focus();
        break;
      case 'data':
        term.write(bytes(e.data));
        break;
      case 'prompt':
        prompt(e);
        break;
      case 'closed':
        connected = false;
        setStatus('Disconnected', 'off');
        term.write(`\r\n${dim(e.message)}\r\n`);
        showActions(false);
        break;
      case 'error':
        connected = false;
        $('overlay').hidden = true;
        setStatus(e.message, 'bad');
        term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`);
        if (e.detail) term.write(`${dim(e.detail)}\r\n`);
        showActions(false);
        break;
      default:
    }
  });

  $('copy-key').addEventListener('click', async () => {
    const key = await jc.invoke('jc:ssh-public-key');
    $('copy-key').textContent = 'Copied';
    setTimeout(() => { $('copy-key').textContent = 'Copy my SSH key'; }, 1800);
    term.write(`\r\n${dim(`Your JConnect SSH key is on the clipboard. Add it to ~/.ssh/authorized_keys on hosts you use:\n${key}`)}\r\n`);
  });
  $('reconnect').addEventListener('click', () => {
    term.reset();
    setStatus('Connecting…', 'warn');
    showActions(true);
    jc.send('ssh:start');
  });
  $('disconnect').addEventListener('click', () => {
    jc.send('ssh:disconnect');
    connected = false;
    setStatus('Disconnected', 'off');
    showActions(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && promptId) answer(null);
  });

  jc.send('ssh:start');
})();
