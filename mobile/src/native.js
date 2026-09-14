// JConnect for Android, on phones, tablets and TVs. Adds what a web page can't do by itself: finding the computers on
// the network, scanning the code a computer shows, adding a computer by its address, and the Android Back button.
// Loads before the web client scripts.
(function () {
  const plugin = (name) => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;
  const DEFAULT_PORT = 47801;
  const QR_CODE = 0;
  const LISTEN_MS = 4500;
  const $ = (id) => document.getElementById(id);
  // The app's native side (DevicePlugin) marks TVs in the user agent, so this is known before anything draws.
  const television = /\bJConnectTV\b/.test(navigator.userAgent);

  const PHONE_HINT = 'On the computer, open JConnect and go to <strong>Settings → Use this computer from a phone</strong>.';
  const TV_HINT = 'Choose a computer on this network, or type the address JConnect shows on the computer under <strong>Settings → Use this computer from a phone</strong>.';

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

  // JConnect computers announce themselves on the local network every few seconds. Anything on the network can send
  // an announcement, so each one is checked here, and pairing then proves the computer holds the key it announced.
  function parseAnnouncement(text, address) {
    let msg;
    try { msg = JSON.parse(String(text)); } catch { return null; }
    if (!msg || msg.app !== 'jconnect' || typeof msg.id !== 'string' || typeof msg.publicKey !== 'string') return null;
    try {
      if (window.JCSecure.deviceIdFromKey(msg.publicKey) !== msg.id) return null;
    } catch {
      return null;
    }
    if (!Number.isInteger(msg.port) || msg.port < 1 || msg.port > 65535) return null;
    if (typeof address !== 'string' || !/^[0-9a-f.:]{2,45}$/i.test(address)) return null;
    const clean = (value, max) => String(value || '').replace(/\p{Cc}/gu, '').trim().slice(0, max);
    return { id: msg.id, publicKey: msg.publicKey, name: clean(msg.name, 64) || 'Computer', os: clean(msg.os, 32), host: address, port: msg.port };
  }

  // The computers heard on the network in the next few seconds, or null when this device can't listen.
  async function listenNearby() {
    const device = plugin('JConnectDevice');
    if (!device) return null;
    try {
      const result = await device.listen({ ms: LISTEN_MS });
      return ((result && result.messages) || []).map((m) => parseAnnouncement(m.text, m.address)).filter(Boolean);
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
        <p id="add-hint" class="muted native-hint"></p>
        <div class="stack">
          <div class="nearby">
            <p id="add-nearby-status" class="muted nearby-status" role="status"></p>
            <div id="add-nearby-list" class="nearby-list"></div>
          </div>
          <button type="button" id="add-scan" class="primary">Scan the code</button>
          <label class="native-field">
            <span class="muted">Or type the computer’s address</span>
            <input id="add-address" type="text" inputmode="url" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="192.168.1.20" enterkeyhint="next">
          </label>
          <label class="native-field">
            <span class="muted">Pairing code, from the bottom of the JConnect window (optional)</span>
            <input id="add-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000-000" enterkeyhint="go">
          </label>
          <button type="button" id="add-by-address" class="secondary">Pair with this computer</button>
          <button type="button" id="add-cancel" class="link">Cancel</button>
        </div>
        <p id="add-error" class="error" role="alert" hidden></p>
      </form>`;
    document.body.append(dialog);
    return dialog;
  }

  // Lists the computers heard on the network for as long as the dialog stays open.
  let search = 0;
  async function findNearby(d, beginPairing) {
    const run = ++search;
    const status = $('add-nearby-status');
    const list = $('add-nearby-list');
    const buttons = new Map();
    list.replaceChildren();
    status.textContent = 'Looking for computers on this network…';
    status.hidden = false;
    while (d.open && run === search) {
      const found = await listenNearby();
      if (!d.open || run !== search) return;
      if (found === null) {
        status.hidden = true;
        return;
      }
      for (const c of found) {
        let button = buttons.get(c.id);
        if (!button) {
          button = document.createElement('button');
          button.type = 'button';
          button.className = 'nearby-item';
          const name = document.createElement('span');
          name.className = 'nearby-name';
          const meta = document.createElement('span');
          meta.className = 'nearby-meta';
          button.append(name, meta);
          list.append(button);
          buttons.set(c.id, button);
        }
        const added = window.JCComputers && window.JCComputers.get(c.id);
        button.firstChild.textContent = c.name;
        button.lastChild.textContent = [added ? 'Added' : '', c.os, c.host].filter(Boolean).join(' · ');
        button.onclick = () => {
          d.close();
          beginPairing({ host: c.host, port: c.port, id: c.id, publicKey: c.publicKey, code: '' });
        };
      }
      status.textContent = 'No computers found yet. Check that JConnect is open on the computer and that it’s on the same network, or type its address below.';
      status.hidden = buttons.size > 0;
    }
  }

  function addComputer(beginPairing) {
    const d = addDialog();
    const error = $('add-error');
    const address = $('add-address');
    const code = $('add-code');
    const showError = (text) => {
      error.textContent = text;
      error.hidden = false;
      if (!d.open) d.showModal();
    };
    error.hidden = true;
    address.value = '';
    code.value = '';
    $('add-hint').innerHTML = television ? TV_HINT : PHONE_HINT;
    // TVs have no camera to scan with.
    $('add-scan').hidden = television;

    $('add-scan').onclick = async () => {
      d.close();
      const result = await scanCode();
      if (result.error) return showError(result.error);
      if (!result.text) return undefined;
      const target = targetFromCode(result.text);
      if (!target) return showError('That isn’t a JConnect code. Scan the code shown in JConnect on the computer.');
      return beginPairing(target);
    };
    // With a code, Allow pairs straight away. Without one, someone at the computer is asked to allow this device.
    const useAddress = () => {
      const target = parseAddress(address.value);
      if (!target) return showError('Type the computer’s address, for example 192.168.1.20.');
      const digits = code.value.replace(/\D/g, '');
      if (digits && digits.length !== 6) return showError('The pairing code has 6 digits.');
      d.close();
      return beginPairing({ ...target, code: digits, id: '', publicKey: '' });
    };
    $('add-by-address').onclick = useAddress;
    address.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); code.focus(); } };
    code.oninput = () => {
      const digits = code.value.replace(/\D/g, '').slice(0, 6);
      code.value = digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
    };
    code.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); useAddress(); } };
    $('add-cancel').onclick = () => d.close();
    d.showModal();
    findNearby(d, beginPairing);
  }

  // ---------- updates ----------
  // The app's native side (DevicePlugin) checks JConnect's website for a newer APK, downloads it, checks its SHA-256
  // and hands it to Android's installer, which only installs it over this app if it has the same signature.
  const UPDATE_EVERY_MS = 12 * 60 * 60 * 1000;
  let updateInfo = null;
  let updating = false;

  function updateBanner() {
    if ($('update-banner')) return $('update-banner');
    const header = document.querySelector('#screen-home header');
    if (!header) return null;
    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.className = 'update-banner';
    banner.hidden = true;
    banner.innerHTML = '<div class="update-text"><strong>Update available</strong><span id="update-detail"></span></div><button type="button" id="update-now" class="primary">Update</button>';
    header.after(banner);
    $('update-now').addEventListener('click', installUpdate);
    return banner;
  }

  async function checkForUpdate() {
    const device = plugin('JConnectDevice');
    if (!device || updating) return;
    try {
      const result = await device.checkUpdate();
      updateInfo = result && result.available ? result : null;
    } catch {
      return; // offline, or the website has no update information yet
    }
    const banner = updateBanner();
    if (!banner) return;
    banner.hidden = !updateInfo;
    if (updateInfo) $('update-detail').textContent = `JConnect ${updateInfo.version} · ${Math.max(1, Math.round(updateInfo.size / 1048576))} MB`;
  }

  async function installUpdate() {
    const device = plugin('JConnectDevice');
    if (!device || !updateInfo || updating) return;
    updating = true;
    const button = $('update-now');
    const detail = $('update-detail');
    button.disabled = true;
    const progress = await device.addListener('updateProgress', (e) => {
      detail.textContent = `Downloading… ${Math.round((e.progress || 0) * 100)}%`;
    });
    try {
      await device.downloadUpdate();
      detail.textContent = 'Opening the installer…';
      const result = await device.installUpdate();
      detail.textContent = result && result.needsPermission
        ? 'Allow JConnect to install apps, then press Update again.'
        : `JConnect ${updateInfo.version} · finish in Android’s installer.`;
    } catch (err) {
      detail.textContent = /match/i.test(String(err && err.message))
        ? 'The download didn’t match JConnect’s website, so it wasn’t installed.'
        : 'The update couldn’t be downloaded. Try again later.';
    } finally {
      progress.remove();
      button.disabled = false;
      updating = false;
    }
  }

  // Back closes what's on top: a dialog, then the session controls, then the session or pairing screen.
  function onBack() {
    const open = document.querySelector('dialog[open]');
    if (open) { open.close(); return; }
    // On a TV, Back shows and hides the session controls instead (tv.js).
    if (window.JCTV && window.JCTV.back()) return;
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
    if (hint) {
      hint.textContent = television
        ? 'Press Add Computer to find the computers on this network. JConnect needs to be open on them.'
        : 'Tap Add Computer, then scan the code JConnect shows on your computer under Settings → Use this computer from a phone.';
    }
    setTimeout(checkForUpdate, 15000);
    setInterval(checkForUpdate, UPDATE_EVERY_MS);
  });

  window.JCNative = { platform: 'android', television, addComputer, parseAddress, parseAnnouncement, targetFromCode, onBack };
})();
