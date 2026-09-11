// JConnect for Android. Adds what a web page can't do by itself: scanning the code a computer shows,
// adding a computer by its address, and the Android back button. Loads before the web client scripts.
(function () {
  const plugin = (name) => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;
  const DEFAULT_PORT = 47801;
  const QR_CODE = 0;
  const $ = (id) => document.getElementById(id);

  // "192.168.1.20", "office-pc:47801", "[fd7a::1]:47801" or a pasted http:// address.
  function parseAddress(text) {
    const value = String(text || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
    if (!value) return null;
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
    if (bracket) return { host: bracket[1], port: Number(bracket[2]) || DEFAULT_PORT };
    const parts = value.split(':');
    if (parts.length === 2) return parts[0] ? { host: parts[0], port: Number(parts[1]) || DEFAULT_PORT } : null;
    return { host: value, port: DEFAULT_PORT };
  }

  // The code in JConnect's Settings is an address like http://192.168.1.20:47801/?code=…&id=…&k=…
  function targetFromCode(text) {
    try {
      const url = new URL(String(text).trim());
      const conn = window.JCConnection;
      const target = conn.pairTargetFromLocation(url);
      if (target) return target;
      const host = conn.hostFromLocation(url);
      return host ? { ...host, code: '', id: '', publicKey: '' } : null;
    } catch {
      return null;
    }
  }

  async function scanCode() {
    const scanner = plugin('CapacitorBarcodeScanner');
    if (!scanner) return { error: 'The camera scanner isn’t available on this device. Type the address instead.' };
    try {
      const result = await scanner.scanBarcode({
        hint: QR_CODE,
        scanInstructions: 'Point the camera at the code in JConnect',
        scanButton: false,
        android: { scanningLibrary: 'zxing' },
      });
      return { text: result && result.ScanResult ? result.ScanResult : '' };
    } catch (err) {
      if (/permission|denied/i.test(String(err && err.message))) {
        return { error: 'JConnect needs the camera to scan the code. Allow it in Android Settings, or type the address instead.' };
      }
      return { text: '' }; // closed the scanner
    }
  }

  let dialog = null;
  function addDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'add-dialog';
    dialog.innerHTML = `
      <form method="dialog">
        <h2>Add a computer</h2>
        <p class="muted native-hint">On the computer, open JConnect and go to <strong>Settings → Use this computer from a phone</strong>.</p>
        <div class="stack">
          <button type="button" id="add-scan" class="primary">Scan the code</button>
          <label class="native-field">
            <span class="muted">Or type the computer’s address</span>
            <input id="add-address" type="text" inputmode="url" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="192.168.1.20" enterkeyhint="go">
          </label>
          <button type="button" id="add-by-address" class="secondary">Use this address</button>
          <button type="button" id="add-cancel" class="link">Cancel</button>
        </div>
        <p id="add-error" class="error" role="alert" hidden></p>
      </form>`;
    document.body.append(dialog);
    return dialog;
  }

  function addComputer(beginPairing) {
    const d = addDialog();
    const error = $('add-error');
    const address = $('add-address');
    const showError = (text) => {
      error.textContent = text;
      error.hidden = false;
      if (!d.open) d.showModal();
    };
    error.hidden = true;
    address.value = '';

    $('add-scan').onclick = async () => {
      d.close();
      const result = await scanCode();
      if (result.error) return showError(result.error);
      if (!result.text) return undefined;
      const target = targetFromCode(result.text);
      if (!target) return showError('That isn’t a JConnect code. Scan the code shown in JConnect on the computer.');
      return beginPairing(target);
    };
    const useAddress = () => {
      const target = parseAddress(address.value);
      if (!target) return showError('Type the computer’s address, for example 192.168.1.20.');
      d.close();
      return beginPairing({ ...target, code: '', id: '', publicKey: '' });
    };
    $('add-by-address').onclick = useAddress;
    address.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); useAddress(); } };
    $('add-cancel').onclick = () => d.close();
    d.showModal();
  }

  // Back closes what's on top: a dialog, then the session controls, then the session or pairing screen.
  function onBack() {
    const open = document.querySelector('dialog[open]');
    if (open) { open.close(); return; }
    const visible = (id) => $(id) && !$(id).hidden;
    if (visible('screen-session')) {
      if (visible('overlay')) $('overlay-back').click();
      else if ($('bar').classList.contains('open')) $('bar-disconnect').click();
      else $('pull-tab').click();
      return;
    }
    if (visible('screen-pair')) {
      if (visible('pair-wait')) $('pair-wait-cancel').click();
      else $('pair-cancel').click();
      return;
    }
    if (visible('screen-lockdown')) { $('lockdown-close').click(); return; }
    const app = plugin('App');
    if (app) (app.minimizeApp || app.exitApp).call(app);
  }
  if (plugin('App')) plugin('App').addListener('backButton', onBack);

  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('native-app');
    const button = $('use-another');
    if (button) button.textContent = 'Add Computer';
    const hint = document.querySelector('#empty-home p:not(.big)');
    if (hint) hint.textContent = 'Tap Add Computer, then scan the code JConnect shows on your computer under Settings → Use this computer from a phone.';
  });

  window.JCNative = { platform: 'android', addComputer, parseAddress, targetFromCode, onBack };
})();
