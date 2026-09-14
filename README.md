# JConnect — Just Connect

**Open. Connect. Work.**

JConnect is a remote-device app built around one idea: remote access should be as easy as using a computer normally. There are no IP addresses, ports or VPN settings to learn, and no required account. Install it, pair once, and press **Connect**.

## Install on Windows

Run `dist\JConnect-Setup-<version>.exe`. It installs for the current user without admin rights, adds Start menu and desktop shortcuts, and starts JConnect. `dist\JConnect-<version>-Portable.exe` runs without installing.

The build isn't code-signed, so Windows SmartScreen may say "Windows protected your PC". Choose **More info → Run anyway**. The first time JConnect starts, Windows Firewall asks whether to allow it on your network. Allow it on private networks so your other devices can reach this computer.

## Install on macOS

Open `JConnect-<version>-arm64.dmg` on a Mac with Apple silicon, or `JConnect-<version>-x64.dmg` on an Intel Mac, and drag JConnect into Applications. JConnect needs macOS 13 or later.

The build isn't signed with an Apple Developer ID or notarized, so the first time you open it macOS says it can't verify JConnect. Open **System Settings → Privacy & Security**, scroll down and choose **Open Anyway**. On macOS 14 and earlier you can also Control-click JConnect in Applications and choose **Open**. Then allow what JConnect asks for:

- **Local Network**, so your other devices can find and reach this Mac.
- **Screen Recording** and **Accessibility**, so paired devices can see and control this Mac. JConnect lists both under **Settings → Mac permissions**. You don't need them to use other computers from this Mac.

## Install on Android

Install `JConnect-<version>.apk` on a phone, tablet or TV running Android 8.0 or later. Android asks you to allow installing apps from your browser or file manager the first time.

Tap **Add Computer**, then choose a computer JConnect found on the network, scan the code JConnect shows on your computer under **Settings → Use this computer from a phone**, or type the computer's address. The phone needs to be on the same network as the computer, or on the same private network such as Tailscale.

**Android TV and Google TV:** the same APK installs on TVs and appears on the TV's home screen. Install it with an app such as Downloader, or with `adb install`. On a TV, JConnect has a layout you move around with the remote:
- **Add Computer** lists the computers on the network, so there's no address to type.
- In a session, the arrows move the pointer and **OK** clicks. Hold **OK** to right-click, or hold it while moving to drag.
- **Back** shows the session controls. There you can switch the arrows to scrolling or to arrow keys, or open the on-screen keyboard.

The Android app connects to your computers. It doesn't share the phone's or TV's own screen.

## Install on Linux

JConnect runs on 64-bit Intel and AMD PCs.

- **Ubuntu, Debian, Linux Mint and other Debian-based systems:** run `sudo apt install ./JConnect-<version>-amd64.deb`, then open JConnect from your apps.
- **Other distributions:** run `chmod +x JConnect-<version>-x86_64.AppImage`, then open the AppImage.

Paired devices can see and control a Linux computer in an X11 session, such as Linux Mint, Xfce, or **Ubuntu on Xorg** on Ubuntu 24.04. Wayland sessions aren't supported yet: paired devices can't control the computer, and screen sharing hasn't been tested. JConnect starts when you sign in, through `~/.config/autostart`, unless you turn that off in Settings.

## Using it

1. Install JConnect on both computers.
2. On the computer you're using, open **Add Computer**. Nearby JConnect computers appear automatically.
3. Press **Pair**. Then either type the 6-digit code shown at the bottom of JConnect on the other computer, or choose **Ask for permission**. Someone at that computer checks that both screens show the same verification code and presses **Allow**.
4. Press **Connect**. The remote computer fills the window. Move the pointer to the top edge, or press **Ctrl+Alt+Home**, to reveal **← Home PC · Display · Devices · ⋯**.

**From a phone, tablet or TV:** on the computer, open **Settings → Use this computer from a phone** and scan the QR code. The phone opens JConnect in its browser, with nothing to install.

Closing the window keeps the computer available; JConnect stays in the system tray (the menu bar on macOS).

To stop everything, press **⏻** at the top of the window, or use the tray menu. **Terminate JConnect** ends every connection and task, stops all of JConnect's background services and closes it. **Shut Down Computer** turns the computer off. Both ask first.

## Security

Every connection uses JConnect protocol v2, whichever network carries it (LAN, JVPN, Tailscale or another VPN):

- **Encrypted end to end.** Each connection runs an ephemeral X25519 key exchange. Messages, remote-control input, SSH and Remote Desktop data are then sealed with XSalsa20-Poly1305. Frames are numbered, so altered, replayed or reordered data closes the connection. Screen and sound travel over WebRTC, which is DTLS-SRTP encrypted, and its keys are signed inside the channel.
- **Both sides prove who they are.** Every device has an Ed25519 identity key, and its ID is derived from that key. The computer signs each connection's transcript, and the other device checks it against the key it paired with. The connecting device signs the same transcript, so a stolen or replayed message can't be reused.
- **Secrets never cross the network.** Pairing codes and passwords are turned into scrypt proofs bound to that one connection. The code isn't sent, and an eavesdropper can't replay the proof. "Ask for permission" pairing shows a matching verification code on both screens.
- **Stored safely.** Device keys, API keys, account tokens and SSH keys are encrypted with the operating system's key store (DPAPI on Windows, the Keychain on macOS).
- **Least exposure.** Discovery announces only a name and public key, and you can turn that off. Windows get only the permissions they need. The packaged app has Electron fuses set: no Node mode, no inspector, and asar integrity checked.
- **Travel Mode and Emergency Lockdown** still apply to every path, JVPN included.

## JVPN — JConnect's own network

JVPN is on by default, so you don't need another VPN:

- **At home**, devices connect directly over the local network.
- **Away from home**, sign in to your JConnect account. Each computer then keeps an outbound, signed connection to JConnect Cloud's relay, and your other devices reach it through that relay. The relay only passes encrypted bytes: it can't read, change or impersonate anything. Only devices registered to your account can see or dial each other, and every dial uses a one-minute ticket.
- **What it carries**: remote desktop, SSH and Remote Desktop (RDP) to your JConnect computers. Turn these on in **Settings → Share through JVPN**.

JVPN is built into JConnect. It doesn't install a system-wide network adapter, so other apps don't see it as a VPN.

## Account and sync (optional)

Click the person icon at the top of JConnect to sign in or create an account.

- Your password stays on the device. It's turned into two keys: one the server checks, and one that encrypts your data before upload.
- Computers, SSH hosts and your list of devices sync between your devices, stored on the server only as ciphertext.
- Two-step sign-in with an authenticator app is available under **Account**.
- **Trust my account's devices** (off by default) lets your own signed-in devices connect without pairing.

## Networks and VPNs

Open **Add Computer → Import from a network**, or click a network chip on the home screen.

| Network | Status and start | Import machines |
| --- | --- | --- |
| JVPN | Built in | Devices signed in to your account |
| Tailscale | Starts the service and brings Tailscale up (sign-in opens your browser) | Every machine on your tailnet |
| Twingate | Starts the client | Resources, using a read-only API key |
| ZeroTier | Starts the service and joins your networks | Members, using a Central API token |
| WireGuard | Connects a tunnel file you add | Peers listed in the tunnel file |
| FortiClient | Connects a saved VPN connection. On Windows and macOS it opens FortiClient so you can sign in | — |
| Windows VPN | Dials connections from Windows Settings | — |

When JConnect imports machines, it checks what each one offers (JConnect, SSH, Remote Desktop) and adds your choices to **My Computers**. **Connect using…** on any computer picks the network JConnect should use. When you press Connect, JConnect starts that VPN, asking for administrator permission only when the VPN needs it, then connects. JConnect never changes a VPN's own settings.

## SSH

- **Add SSH host**, or import every named host from `~/.ssh/config`.
- **Open SSH terminal** on a JConnect computer to reach its SSH server through JVPN.
- Sign-in tries your SSH agent, then this device's own JConnect SSH key (**Copy my SSH key**), then asks for a password.
- A host's key is remembered the first time you connect. If it later changes, JConnect stops and says so.

## JConnect Cloud (self-hosted)

```bash
cd server/cloud
npm install
npm start          # listens on port 47900
```

- **TLS:** set `TLS_CERT` and `TLS_KEY`, or put it behind a reverse proxy. JConnect only accepts `http://` cloud addresses on private networks.
- **TURN:** set `TURN_PUBLIC_HOST` (and optionally `TURN_PORT`) to relay remote-desktop media when two networks block direct connections.
- **Data:** stored in an SQLite database at `server/cloud/data/cloud.db`. Set `JCONNECT_CLOUD_DB` to keep it elsewhere. It needs Node.js 22.13 or later.
  - Accounts from an older `cloud.json` are imported the first time it starts, and the file is kept as `cloud.json.imported`.
  - `server/cloud/supabase/migrations` has the same tables for Postgres (Supabase).

## Development

```bash
npm install
npm start                    # run JConnect
npm run start:b              # a second copy with its own identity, for testing on one PC
npm run dist:win             # build dist/JConnect-Setup-*.exe and the portable exe
npm run dist:mac             # on a Mac: build dist/JConnect-*-arm64.dmg and dist/JConnect-*-x64.dmg
npm run dist:linux           # on Linux: build dist/JConnect-*-x86_64.AppImage and dist/JConnect-*-amd64.deb
cd mobile && npm install && npm run sync && cd android && ./gradlew assembleDebug   # Android APK (needs JDK 17–21)
node --test test/*.test.js src/web/test/connection.test.js server/relay/test/relay.test.js server/cloud/test/cloud.test.js
```

DMGs can only be built on a Mac, because they need Apple's tools. `.github/workflows/mac.yml` builds and checks both DMGs on a GitHub-hosted Mac whenever the `app` branch is pushed. Download them from the run's **Artifacts**.

The Linux packages include an input helper written in C, which needs a compiler and the X11 and XTest headers (`sudo apt install build-essential libx11-dev libxtst-dev`). `.github/workflows/linux.yml` builds both packages whenever the `app` or `linux` branch is pushed. It builds the helper on Ubuntu 20.04 so it also runs on older distributions, then installs and checks the packages on Ubuntu under Xvfb, including remote control (`scripts/linux-input-check.js`) and screen sharing. On `app`, a build that passes is published as the release named in the workflow.

The Mac app icon is an Icon Composer document, `build/JConnect.icon`, so macOS 26 and later show it in Liquid Glass. Open it in [Icon Composer](https://developer.apple.com/icon-composer/) to change it. Compiling it needs Xcode 26 or later running on macOS 26 or later. Anywhere else, `npm run dist:mac` uses the flat `assets/icon-mac.png` instead.

Project layout:

- `src/main`: Electron main process
  - host agent (`host.js`)
  - JVPN (`jvpn.js`)
  - account and sync (`account.js`)
  - networks and VPNs (`vpn/`)
  - routes (`routes.js`)
  - SSH (`ssh.js`)
  - security, input, tray and windows
- `src/shared`: the v2 secure channel, the client protocol, and the remote-desktop viewer
- `src/renderer`: the main window, remote session, SSH terminal, and hidden screen-capture page
- `src/web`: the browser client for phones, tablets and TVs
- `server/cloud`: JConnect Cloud (accounts, sync, relay, TURN)
- `server/relay`: the standalone relay
- `native`: the input helpers for macOS (Swift) and Linux (C)
- `mobile`: the Android app for phones, tablets and TVs. It's a Capacitor wrapper around the browser client in `src/web`, adding QR scanning, finding computers on the network, adding computers by address, TV detection and the back button.

## Known limits

- Windows can't be controlled on the secure desktop (UAC prompts, Ctrl+Alt+Del, the lock screen). Apps running as administrator ignore input from JConnect unless JConnect also runs as administrator.
- SSH to a JConnect computer needs an SSH server running on it (for example Windows OpenSSH Server).
- The phone web page is served over plain http on your local network. The connection itself is still end-to-end encrypted, but use the desktop app on networks you don't trust.
- Linux computers can be controlled only in X11 sessions. On Wayland, paired devices can't control them yet, and screen sharing hasn't been tested there.
- A Mac can't be controlled at its lock screen or login window, and its sound isn't shared yet. ⌘Tab, ⌘Space and other system shortcuts stay on the Mac you're using.
- Camera sharing is described in the product vision as a future feature and isn't built yet.
