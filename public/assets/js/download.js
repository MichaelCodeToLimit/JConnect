(() => {
  'use strict';

  // Point each visitor at their own platform. Nav, reveals, checksums and download labels live in home.js.
  const rows = [...document.querySelectorAll('[data-platform]')];
  if (!rows.length) return;

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

  // [button label, where it goes, note under it, whether it downloads] for visitors not on Windows
  const RECOMMEND = {
    mac: ['Download for Mac', '/download/JConnect-Mac-AppleSilicon.dmg', 'Version 0.1.0 beta, Apple silicon Macs, macOS 13 or later, 86 MB. For an Intel Mac, choose Intel below.', true],
    linux: ['Download for Linux', '/download/JConnect-Linux.deb', 'Version 0.1.0 beta, .deb for Ubuntu, Debian and Linux Mint, 96 MB', true],
    'raspberry-pi': ['Raspberry Pi is coming soon', '#raspberry-pi', '64-bit Raspberry Pi OS. Windows and Linux are available now.'],
    android: ['Download for Android', '/download/JConnect-Android.apk', 'Version 0.1.0 beta 3, Android 8.0 or later, 31 MB', true],
    ios: ['Open JConnect in Safari', '#how', 'Nothing to install on iPhone or iPad, and an app is coming soon. Set up JConnect on your computer first.'],
    tv: ['Open JConnect in the TV’s browser', '#how', 'Type the address your JConnect computer shows.'],
    'apple-tv': ['Apple TV is coming soon', '#apple-tv', 'Apple TV has no web browser, so it needs its own app.'],
  };

  const current = detect();
  const row = rows.find((el) => el.dataset.platform === current);
  if (row) {
    row.classList.add('is-current');
    const badge = document.createElement('span');
    badge.className = 'you';
    badge.textContent = 'Your device';
    row.querySelector('h3').before(badge);
    document.querySelectorAll('.dl-chips a[href="#' + row.id + '"]').forEach((a) => a.classList.add('is-current'));
  }

  const button = document.querySelector('[data-recommend-button]');
  const note = document.querySelector('[data-recommend-note]');
  const pick = RECOMMEND[current];
  if (button && note && pick) {
    const [label, href, text, downloads] = pick;
    if (!downloads) {
      button.removeAttribute('download');
      delete button.dataset.download;
    }
    button.textContent = label;
    button.setAttribute('href', href);
    note.textContent = text;
    // Every Mac browser says "Intel" in its user agent. Chromium browsers can tell the real chip.
    if (current === 'mac' && navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      navigator.userAgentData.getHighEntropyValues(['architecture']).then(({ architecture }) => {
        if (architecture !== 'x86') return;
        button.textContent = 'Download for Intel Mac';
        button.setAttribute('href', '/download/JConnect-Mac-Intel.dmg');
        note.textContent = 'Version 0.1.0 beta, Intel Macs, macOS 13 or later, 97 MB';
      }).catch(() => {});
    }
  }
})();
