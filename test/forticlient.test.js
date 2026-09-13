// FortiClient: its saved connections and whether its VPN is up, as each system reports them.
const test = require('node:test');
const assert = require('node:assert');

const { parseWindows, parseMacProfiles, macConnected, parseLinuxStatus, parseLinuxList, parseLinuxProfile } = require('../src/main/vpn/forticlient');

test('reads connections and adapter state from FortiClient for Windows', () => {
  const report = {
    profiles: [
      { Name: 'Office', Server: 'vpn.example.com:443' },
      { Name: 'Office', Server: 'other.example.com' },
      { Name: 'Branch', Server: '' },
      null,
    ],
    adapters: [
      { InterfaceDescription: 'Fortinet Virtual Ethernet Adapter (NDIS 6.30)', Status: 'Disconnected' },
      { InterfaceDescription: 'Fortinet SSL VPN Virtual Ethernet Adapter', Status: 'Up' },
    ],
  };
  assert.deepStrictEqual(parseWindows(JSON.stringify(report)), {
    profiles: [{ name: 'Office', server: 'vpn.example.com:443' }, { name: 'Branch', server: null }],
    connected: true,
  });
  // PowerShell leaves out the brackets around a single item.
  assert.deepStrictEqual(parseWindows('{"profiles":{"Name":"Home","Server":"home.example.com:10443"},"adapters":{"Status":"Disconnected"}}'), {
    profiles: [{ name: 'Home', server: 'home.example.com:10443' }],
    connected: false,
  });
  for (const junk of ['', 'null', 'not json']) assert.deepStrictEqual(parseWindows(junk), { profiles: [], connected: false });
});

test('reads connections from FortiClient for macOS, and its tunnel from the system VPN list', () => {
  assert.deepStrictEqual(parseMacProfiles({ Profiles: { Office: { Server: 'vpn.example.com' }, '': {}, Lab: 'unexpected' } }), [
    { name: 'Office', server: 'vpn.example.com' },
    { name: 'Lab', server: null },
  ]);
  assert.deepStrictEqual(parseMacProfiles({ profiles: [{ Name: 'Home', ServerAddress: 'home.example.com' }, { other: 1 }] }), [
    { name: 'Home', server: 'home.example.com' },
  ]);
  assert.deepStrictEqual(parseMacProfiles(null), []);

  const services = [
    'Available network connection services in the current set (*=enabled):',
    '* (Connected)      6F2B1C3A-2D4E-4F10-9A7B-1E2D3C4B5A69 VPN (com.fortinet.forticlient.macos.vpn.nwextension) "VPN"   [VPN:com.fortinet.forticlient.macos.vpn]',
  ].join('\n');
  assert.strictEqual(macConnected(services), true);
  assert.strictEqual(macConnected(services.replace('(Connected)', '(Disconnected)')), false);
  assert.strictEqual(macConnected('* (Connected)      0A1B2C3D VPN (com.wireguard.macos) "Home" [VPN:com.wireguard.macos]'), false);
});

test('reads profiles, status and profile settings from FortiClient for Linux', () => {
  // Output recorded from FortiClient VPN 7.4.3 for Linux, with and without a terminal.
  assert.deepStrictEqual(parseLinuxList('VPNs:\n  (No VPN profile found)\n'), []);
  assert.deepStrictEqual(parseLinuxList('VPNs:\r\n  Personal VPNs:\r\n    probe\r\n    Second Office\r\n'), [
    { name: 'probe', server: null },
    { name: 'Second Office', server: null },
  ]);

  assert.deepStrictEqual(parseLinuxStatus('Status: Not Running\n'), { connected: false, name: null });
  assert.deepStrictEqual(parseLinuxStatus('Status: Connecting\r\n'), { connected: false, name: null });
  // No tunnel could be connected while recording. These labels come from the command's own text.
  assert.deepStrictEqual(parseLinuxStatus('\x1b[1mStatus:\x1b[0m Connected\n  VPN name: Second Office\n  Username: someone\n'), {
    connected: true,
    name: 'Second Office',
  });

  const view = [
    'VPN: probe',
    '  Remote Gateway: vpn.example.com',
    '  Client Certificate: None',
    '  Authentication: Prompt on login',
    '  Single Sign On (SSO) for VPN Tunnel: Disabled',
    '  Auto Connect: Disabled',
    '  Always Up: Disabled',
    '  Save Password: Disabled',
  ].join('\n');
  assert.deepStrictEqual(parseLinuxProfile(view), { server: 'vpn.example.com', asks: true });
  assert.deepStrictEqual(parseLinuxProfile(view.replace('Save Password: Disabled', 'Save Password: Enabled')), { server: 'vpn.example.com', asks: false });
  assert.strictEqual(parseLinuxProfile(view.replace('Prompt on login', 'Disabled').replace('(SSO) for VPN Tunnel: Disabled', '(SSO) for VPN Tunnel: Enabled')).asks, true);
  assert.deepStrictEqual(parseLinuxProfile(''), { server: null, asks: false });
});
