(function () {
  'use strict';

  const jc = window.jconnect;
  const id = new URLSearchParams(location.search).get('id');

  const adapter = {
    electron: true,
    identity: () => jc.invoke('jc:identity'),
    sign: (text) => jc.invoke('jc:sign', text),
    verify: (text, sig, key) => jc.invoke('jc:verify', text, sig, key),
    target: () => jc.invoke('jc:session-target', id),
    resolve: () => jc.invoke('jc:resolve', id),
    wake: () => jc.invoke('jc:wake', id),
    computers: () => jc.invoke('jc:computers'),
    switchTo: (other) => jc.invoke('jc:switch', other),
    windowAction: (action) => jc.invoke('jc:window', action),
    exit: () => jc.invoke('jc:window', 'home'),
    report: (state, info) => jc.invoke('jc:report', id, state, info).catch(() => {}),
  };

  window.addEventListener('error', (e) => adapter.report('error', { message: String(e.message) }));
  window.addEventListener('unhandledrejection', (e) => adapter.report('error', { message: String(e.reason && (e.reason.stack || e.reason.message || e.reason)) }));

  new window.JConnectViewer(document.getElementById('root'), adapter).start();
})();
