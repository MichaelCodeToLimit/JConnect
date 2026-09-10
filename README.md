# JConnect — Just Connect

**Open. Connect. Work.**

JConnect is a remote-device app built around one idea: remote access should be as easy as using a computer normally. No IP addresses, ports, VPN setup, or accounts. Install it, pair once, press **Connect**.

## Install on Windows

Run `dist\JConnect-Setup-<version>.exe`. It installs for the current user without admin rights, adds Start menu and desktop shortcuts, and starts JConnect. `dist\JConnect-<version>-Portable.exe` runs without installing.

The build isn't code-signed, so Windows SmartScreen may say "Windows protected your PC". Choose **More info → Run anyway**. The first time JConnect starts, Windows Firewall asks whether to allow it on your network. Allow it on private networks so other devices can reach this computer.

## Using it

1. Install JConnect on both computers.
2. On the computer you're using, open **Add Computer**. Nearby JConnect computers appear automatically.
3. Press **Pair**, then either type the 6-digit code shown at the bottom of JConnect on the other computer, or choose **Ask for permission** so someone there can press **Allow**.
4. Press **Connect**. The remote computer fills the window. Move the pointer to the top edge, or press **Ctrl+Alt+Home**, to reveal **← Home PC · Display · Devices · ⋯**.

**From a phone, tablet, or TV:** on the computer, open **Settings → Use this computer from a phone** and scan the QR code. The phone opens JConnect in its browser. Nothing needs to be installed.

Closing the window keeps the computer available; JConnect stays in the system tray.

## What's included

| Area | What it does |
| --- | --- |
| Connections | Direct device-to-device over LAN, Tailscale or other private networks, with no cloud required. Every known path is tried at once and the best one wins. |
| Discovery | LAN broadcast discovery and Tailscale peer detection, with friendly device names. |
| Pairing | Per-device Ed25519 keys and a 6-digit code, QR code, or an on-screen "Allow" prompt. The computer proves its identity on every connection, and offers and answers are signed. |
| Session | WebRTC screen and sound streaming, mouse, keyboard, wheel and touch control, multiple displays, and switching between computers. |
| Recovery | Automatic reconnection, plain-language messages, Wake-on-LAN, and sleep and shutdown awareness. |
| Owner controls | See who is connected, disconnect people, remove devices, view-only permission, an optional password, and trusted people groups. |
| Travel Mode | Only your own devices may connect, pairing is off, and streaming is lighter. Security levels run from low (log and block) through medium (pause pairing and notify) to high (Emergency Lockdown). Optional emergency shutdown. |
| Resource protection | Lowers streaming quality when CPU, thermal state, or battery calls for it. JConnect never closes your apps. |
| Extras | Import `.rdp` files (opens them with Remote Desktop) and desktop shortcuts that connect with a double-click. |
| Relay (optional) | `server/relay` reaches computers across the internet when there is no direct path. |

## Development

```bash
npm install
npm start                    # run JConnect
npm run start:b              # a second copy with its own identity, for testing on one PC
npm run dist:win             # build dist/JConnect-Setup-*.exe and the portable exe
node --test src/web/test/connection.test.js server/relay/test/relay.test.js
```

Project layout:

- `src/main` — Electron main process: host agent (`host.js`), discovery, pairing store, security and Travel Mode, input injection, tray, and windows
- `src/renderer` — the desktop window, the remote session window, and the hidden screen-capture page
- `src/shared` — the handshake protocol and viewer shared by desktop windows
- `src/web` — the browser client served to phones, tablets and TVs
- `server/relay` — the optional relay server

## Known limits

- Windows can't be controlled while it shows the secure desktop (UAC prompts, Ctrl+Alt+Del, lock screen). Windows running as administrator ignore input from JConnect unless JConnect also runs as administrator.
- Remote control on macOS and Linux hosts needs `npm install @nut-tree-fork/nut-js` before building. macOS also asks for Screen Recording and Accessibility permission.
- Camera sharing is described in the product vision as a future feature and isn't built yet.
