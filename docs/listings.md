# Directory listings — ready-to-paste copy

Everything below is written and ready. **Nothing has been submitted**: each of these needs an account in your name, and publishing under your identity is your call, not mine. Paste and send when you want them live.

Ordered by what is worth doing first. Section 7 covers app stores and the other package managers: which ones JConnect can go on today, and what each still needs. Last checked 26 September 2026.

---

## 1. winget (Windows Package Manager) — ready to submit

winget comes with Windows 10 and 11, so this puts `winget install jconnect` on every recent Windows PC. It's the only listing here that also installs the app, it accepts free unsigned installers, and it needs nothing but your GitHub account.

The manifests are generated and pass `winget validate`:

```
node scripts/winget-manifest.js jconnect-website/public/download/JConnect-Setup.exe 0.1.0-beta.1 --display-version 0.1.0 --release-date 2026-09-11
```

This writes three files to `dist/winget/manifests/m/MichaelDavies/JConnect/0.1.0-beta.1/`, in the same layout as the winget repository. They describe the installer the website serves today (SHA-256 `b4b5eb13…34c76e1`), which Microsoft Defender scanned clean on 26 September 2026. winget has no JConnect package yet, so the ID `MichaelDavies.JConnect` is free.

The installer link is the file's release in the public repository `MichaelCodeToLimit/JConnect-releases` (section 7), whose file names include the version. So that repository has to exist, with its `windows-v0.1.0-beta.1` release, before the pull request goes in.

To submit:

1. Fork <https://github.com/microsoft/winget-pkgs>.
2. In a new branch, add the three files under `manifests/m/MichaelDavies/JConnect/0.1.0-beta.1/`, and open a pull request titled `New package: MichaelDavies.JConnect version 0.1.0-beta.1`.
3. When Microsoft's bot asks, agree to the Contributor License Agreement by commenting `@microsoft-github-policy-service agree`.

Microsoft's pipeline then installs the package in a virtual machine and checks it, and a moderator merges it, usually within a few days.

- **Every Windows release needs a new manifest.** Run the script with the new version once its release is in JConnect-releases, and submit it as `Update: MichaelDavies.JConnect version <version>`. Older manifests keep working, because their links never change.
- `--display-version 0.1.0` is only for beta 1, which reports 0.1.0 to Windows. Builds made with their release version need no flag.
- Beta 1 has no updater, so winget users stay on it until the next Windows release reaches winget.

---

## 2. AlternativeTo

The highest-value directory listing available to you today. It accepts proprietary freeware, it ranks well for "TeamViewer alternative" searches, and journalists genuinely browse it when writing roundups. A listing here is also the kind of thing that later helps a Wikipedia reviewer believe the software exists, even though it is not itself a valid source.

Sign up at <https://alternativeto.net/signup>, then add the app from your account. Adding an app is only available after signing in. (Checked 16 September 2026: no existing JConnect listing, so the name is free.)

**Name**
```
JConnect
```

**Tagline** (max ~100 chars)
```
Remote desktop with no IP addresses, no port forwarding and no account needed.
```

**Description**
```
JConnect is a remote-device app for Windows, macOS, Linux and Android built on one rule:
remote access should be as easy as using a computer normally.

Computers on the same network find each other automatically. You pair them once with a
six-digit code, then press Connect — there are no IP addresses to look up, no ports to
forward, no VPN profile to fill in and no account to create. Devices are identified by
key rather than address, so a paired machine keeps working when it moves network.

Every session is end-to-end encrypted: an ephemeral X25519 key exchange, XSalsa20-Poly1305
sealing, Ed25519 device identities, and pairing codes that never cross the network. Screen
and sound travel over WebRTC.

Away from home, JVPN carries the session over a relay that can only pass encrypted bytes —
it can't read, alter or impersonate anything, and only devices on your own account can dial
each other. JVPN installs no network adapter, so other apps don't see a VPN and it needs no
administrator rights. If you already use Tailscale, Twingate, ZeroTier, WireGuard, FortiClient
or a Windows VPN, JConnect can start it and import the machines on it instead.

Also included: an SSH client with agent and key support, Remote Desktop (RDP) routing,
optional encrypted sync of your device list, Travel Mode and Emergency Lockdown, and an
Android app that works on phones, tablets and — with a layout built for a directional
remote — Android TV and Google TV. Phones and tablets can also connect from a browser with
nothing installed.

The account server, relay and sync store are a single Node.js application you can host
yourself against SQLite or PostgreSQL.

Currently an early beta, free to use. The Windows and macOS builds are not yet code-signed,
so both systems warn on first run.
```

**Licence**: Freeware (proprietary)
**Platforms**: Windows, macOS, Linux, Android, Android TV, Web
**Website**: `https://jconnect-1dsx.onrender.com`

**Tags**
```
remote-desktop, remote-access, remote-control, ssh, vpn, screen-sharing,
end-to-end-encryption, self-hosted, rdp, android-tv
```

**Features to tick** (each one is in the builds on the download page today):

| Feature | Where it is |
| --- | --- |
| Ad-free | No ads anywhere |
| Screen Sharing, Desktop Sharing | Every session |
| Unattended Access | Paired devices connect without anyone at the computer; JConnect starts with the computer |
| Wake on LAN | **Wake** on a computer, and Connect wakes a sleeping one |
| Support for Multiple Monitors | **Display** in a session switches between the remote computer's displays |
| Dark Mode | Follows the system's light or dark mode |

**Tick later.** These aren't in anything a visitor can download yet (checked 26 September 2026), so add them when they are:

| Feature | Waiting for |
| --- | --- |
| Real time collaboration | The release with several devices on one computer. It isn't in any published build. |
| User Session Recording | The release with **⋯ → Record session**. It isn't in any published build. |
| Portable | The portable `.exe` or the AppImage on the download page. Both are built, but the website only offers the installer and the `.deb`. |

The **Settings → Appearance** choice arrives with the same release as recording.

Leave **Lightweight** unticked. JConnect is an Electron app, and its installer is about 95 MB, while AnyDesk's is a few megabytes. Claiming it would be the first thing a reviewer or commenter disproves.

**Suggest as an alternative to**: TeamViewer, AnyDesk, Chrome Remote Desktop, RustDesk, Parsec, Splashtop, NoMachine

**Screenshots**: upload `jconnect-website/public/media/desktop.jpg`, `jvpn.jpg`, `sync.jpg`.

> Disclose that you are the developer in the submission notes. AlternativeTo allows developer submissions; concealing it and being caught is worse than saying so.

---

## 3. Wikidata — after winget and AlternativeTo

Wikidata's bar is *structural identifiability*, not notability-by-coverage: an item needs to be a "clearly identifiable conceptual or material entity" described by serious, publicly available references. Today every reference would be JConnect's own website, which is exactly the kind of item that gets proposed for deletion. It stands on firmer ground once it can also carry identifiers from outside databases, so create it after the winget package is merged and the AlternativeTo listing is live, and include both IDs from the start.

A Wikidata item gives you a stable identifier that other databases consume. It does **not** create any entitlement to a Wikipedia article.

**Your account.** QuickStatements, the batch tool, only works for autoconfirmed accounts: at least 50 edits, with the first edit at least four days old. A new account enters the item by hand at <https://www.wikidata.org/wiki/Special:NewItem>, and Wikidata may ask it to solve a CAPTCHA each time it adds a web address. Allow about 15 minutes.

| Field | Value |
| --- | --- |
| Label (en) | JConnect |
| Description (en) | remote desktop software |
| Aliases (en) | JConnect — Just Connect |

**Statements.** Every ID was looked up on Wikidata on 26 September 2026, and they follow how AnyDesk and RustDesk are described there. An earlier draft of this list had three wrong IDs, which pointed at a vector graphics editor, a 2005 film and a hill in the Dominican Republic, so look up any ID you add yourself.

| Property | Value | Reference URL (P854) |
| --- | --- | --- |
| instance of (P31) | remote desktop software (Q1200186) | About |
| official website (P856) | `https://jconnect-1dsx.onrender.com/` | none needed |
| inception (P571) | 10 September 2026 | About |
| publication date (P577) | September 2026 (month precision) | About |
| operating system (P306) | Microsoft Windows (Q1406), macOS (Q14116), Linux (Q388), Android (Q94), Android TV (Q17298682) | About |
| programmed in (P277) | JavaScript (Q2005), Swift (Q17118377), C (Q15777) | About |
| depends on software (P1547) | Electron (Q21614124) | About |
| copyright license (P275) | proprietary license (Q3238057) | About |
| software version identifier (P348) | `0.1.0`, with qualifiers version type (P548) = beta version (Q3295609) and publication date (P577) = September 2026 | Download |
| developer (P178) | *unknown value*, with qualifier object named as (P1932) = `Michael Davies`. Optional: leave it out if you'd rather not have your name on Wikidata. | About |
| Windows Package Manager Community package ID (P12025) | `MichaelDavies.JConnect` | none needed |
| AlternativeTo ID (P9618) | The last part of the listing's address, e.g. `jconnect` | none needed |

About is `https://jconnect-1dsx.onrender.com/about/` and Download is `https://jconnect-1dsx.onrender.com/download/`. Give each reference retrieved (P813) = the day you add it too.

For an autoconfirmed account, the same item as a QuickStatements batch. Paste it at <https://quickstatements.toolforge.org/#/batch>, where `|` stands for a tab, then change the retrieved dates and add the two IDs:

```
CREATE
LAST|Len|"JConnect"
LAST|Den|"remote desktop software"
LAST|Aen|"JConnect — Just Connect"
LAST|P31|Q1200186|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P856|"https://jconnect-1dsx.onrender.com/"
LAST|P571|+2026-09-10T00:00:00Z/11|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P577|+2026-09-00T00:00:00Z/10|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P306|Q1406|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P306|Q14116|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P306|Q388|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P306|Q94|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P306|Q17298682|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P277|Q2005|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P277|Q17118377|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P277|Q15777|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P1547|Q21614124|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P275|Q3238057|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
LAST|P348|"0.1.0"|P548|Q3295609|P577|+2026-09-00T00:00:00Z/10|S854|"https://jconnect-1dsx.onrender.com/download/"|S813|+2026-09-26T00:00:00Z/11
LAST|P178|somevalue|P1932|"Michael Davies"|S854|"https://jconnect-1dsx.onrender.com/about/"|S813|+2026-09-26T00:00:00Z/11
```

> Do not add `described at URL` chains of your own pages to pad it. A sparse honest item survives; a padded one draws attention.

---

## 4. Show HN — the single highest-upside action on this list

Hacker News is not a directory, but a Show HN that lands is the most realistic route from "no coverage" to "coverage", because tech journalists read it. It is also unforgiving of marketing language and rewards the honest-limits framing you already use.

Post at <https://news.ycombinator.com/submit> with a title beginning `Show HN:`.

**Title** (80 char limit — these both fit)
```
Show HN: JConnect – remote desktop with no IP addresses, ports or account
```
```
Show HN: I built remote desktop software you pair once with a 6-digit code
```

**First comment** — post this yourself immediately after submitting:

```
I got tired of talking family through IP addresses and port forwarding, so I spent the
last while building the remote-desktop app I wanted: install on two machines, they find
each other, type the six-digit code once, press Connect. Devices are identified by an
Ed25519 key rather than an address, so pairing survives a machine changing network.

Sessions are end-to-end encrypted — ephemeral X25519, XSalsa20-Poly1305, and the pairing
code never crosses the wire (it becomes a scrypt proof bound to that one connection).
Screen and audio go over WebRTC with the keys signed inside the encrypted channel.

For connections outside the LAN there's a built-in relay that only passes encrypted bytes,
gated on one-minute tickets, restricted to devices on the same account. It isn't a system
VPN — no network adapter, no admin rights, and it carries only JConnect/SSH/RDP traffic to
your own machines. If you already run Tailscale, ZeroTier, WireGuard, Twingate or FortiClient,
it'll start those and import the machines instead. The account/relay/sync server is one Node
app you can self-host on SQLite or Postgres.

The Android build also runs on Android TV with a layout for a directional remote, which was
much more fun to build than it sounds.

Honest state of it: early beta. Windows isn't code-signed and macOS isn't notarized yet, so
both warn on first launch. Linux control is X11 only — no Wayland. Android is an APK off
the site, not Play. No camera sharing. Source isn't open.

Happy to answer anything about the protocol or the relay design.
```

**Timing**: weekday, 08:00–10:00 US Eastern. Do not ask anyone to upvote — HN detects voting rings and it will kill the post and the domain.

---

## 5. Product Hunt

Worth one shot, but **spend it on a milestone**, not on the current beta — you get one meaningful launch per product. Save it for the release where Windows is code-signed and macOS is notarized, since "SmartScreen warned me" is the top comment you would otherwise get.

Copy when you are ready:

**Tagline** (60 chars)
```
Remote desktop that needs no IP, no ports, and no account
```

**Description**
```
Install JConnect on two computers and they find each other. Pair once with a six-digit
code, press Connect. No IP addresses, no port forwarding, no VPN setup, no sign-up.

End-to-end encrypted every time, on any network. A built-in relay reaches your machines
away from home without installing a VPN adapter — and it can only ever pass encrypted
bytes. SSH and RDP included. Runs on Windows, macOS, Linux, Android, and your TV.
```

**First comment**: the maker's story — the family-tech-support origin, why identity-by-key removes the setup step, and the honest limits. Same voice as the Show HN post.

---

## 6. Software directories that accept submissions

Low effort, low individual value, useful in aggregate for search visibility. Submit the same short description and the icon from the press kit.

| Directory | Submit at | Notes |
| --- | --- | --- |
| Softpedia | softpedia.com/get/submit.shtml | Editors test the app; unsigned builds may be flagged |
| MajorGeeks | majorgeeks.com/content/page/submit_software.html | Windows focus |
| FileHorse | filehorse.com/submit-software/ | Accepts freeware |
| Uptodown | uptodown.com — developer console | Good for the Android APK |
| SourceForge | sourceforge.net (Software Directory) | Accepts proprietary listings, not only hosted projects |
| Slant | slant.co | Comparison-question format; answer existing questions rather than creating pages |
| Awesome-Selfhosted | GitHub PR | **Requires an open-source licence — JConnect does not qualify** |
| F-Droid | — | **Requires FOSS source. Not possible while proprietary** |

**Short description for these** (most cap around 500 characters):
```
JConnect is a remote-device app for Windows, macOS, Linux and Android. Computers on your
network find each other, you pair them once with a six-digit code, and connect — no IP
addresses, no port forwarding, no VPN setup and no account. Every session is end-to-end
encrypted, and a built-in relay reaches your machines away from home without installing a
VPN adapter. Includes SSH, Remote Desktop routing, encrypted device sync, and an Android
app that works on TVs. Free during the beta.
```

---

## 7. App stores and other package managers

Checked 26 September 2026. Every app store also asks for a privacy policy URL: use <https://jconnect-1dsx.onrender.com/privacy/>.

| Where | Open to JConnect today? | What it takes |
| --- | --- | --- |
| winget | **Yes**, ready | Your GitHub account. See section 1. |
| Microsoft Store | **Yes**, package ready | A free Partner Center account, with an ID check. The Store only takes an `.exe` signed by a trusted certificate authority, and JConnect's isn't, so JConnect goes in as an MSIX package, which Microsoft signs itself. That makes the Store the free way to a Windows build SmartScreen trusts. See "Microsoft Store" below. |
| Google Play | **Yes** | $25 once, government ID, the release signing key (done, see below), the Data safety form, and a closed test first. A personal account made after 13 November 2023 needs at least 12 testers opted in for 14 days in a row, and since 2026 Google checks that they really used the app. |
| Amazon Appstore | **Fire TV and Fire tablets only** | A free account. The Appstore closed on other Android devices on 20 August 2025. The TV layout has never run on a real TV, so try it on a Fire TV first. |
| Apple App Store and TestFlight | **Yes** | The Apple Developer Program, $99 a year. `ios.yml` uploads to TestFlight once its secrets exist. The same membership lets the Mac app be notarized. |
| Snap Store | **Yes** | A free Snapcraft account and a registered snap name. electron-builder can build the snap in the Linux workflow. Strict confinement allows X11 input and networking, but not running Tailscale, ZeroTier or WireGuard, so those integrations wouldn't work in the snap. |
| Flathub, AUR, Chocolatey, Scoop, AppImageHub | **Yes**, all take proprietary apps | A download link for each release whose file never changes. The public repository `MichaelCodeToLimit/JConnect-releases` gives every release one, as Obsidian does with `obsidianmd/obsidian-releases` (see below). AUR and Chocolatey each need their own account. AppImageHub also needs the AppImage, which the website doesn't offer. Flathub reviews the sandbox, and the VPN integrations would struggle there. |
| Homebrew (Mac) | **No** | Since 1 September 2026, Homebrew's main cask repository disables apps that fail Gatekeeper, and the Mac app isn't notarized. It needs notarization first. |
| F-Droid, IzzyOnDroid | **No** | Open-source apps only. |

### Public releases repository

`jconnect-releases/` (ignored by this repository, like the website) is the public repository `MichaelCodeToLimit/JConnect-releases`. It holds no source code. A workflow publishes each download from the website as a GitHub release under a versioned name, such as `windows-v0.1.0-beta.1/JConnect-Setup-0.1.0-beta.1.exe`, and only when its size and SHA-256 match what the website says.

- The first releases are defined in `releases/*.json`, with notes in `notes/`.
- After that it needs nothing. Every six hours it reads each download's `<download>.json`, the file JConnect's updater reads, and publishes any version it hasn't yet. So it follows every release that writes its `.json`.
- To create it, make an empty public repository named `JConnect-releases` on GitHub, then push `jconnect-releases` to it.

### Microsoft Store

`npm run dist:store -- <version>` builds `dist/JConnect-<version>-Store.appx`. The package version has four numbers that grow with each submission: 0.1.0-beta.3 is 0.1.3.0, and 0.1.0 will be 0.1.99.0.

- The Store copy doesn't use JConnect's updater, and Windows starts it at sign-in through the package's startup task.
- `store.yml` (branch `store`) builds it with a test identity, installs it on a Windows runner, starts it, and runs Microsoft's Windows App Certification Kit. It passed on 26 September 2026. The one failed test, "Blocked executables", is optional, and it flags every Electron app for strings inside Chromium's own files.
- To submit:
  1. Create the free Partner Center account at <https://storedeveloper.microsoft.com>, and reserve the name JConnect.
  2. Copy **Package/Identity/Name** and **Package/Identity/Publisher** from the app's Product identity page into `build.appx.identityName` and `build.appx.publisher` in `package.json`.
  3. Build without `--test` and upload the `.appx`.
  4. Partner Center asks why the app needs `runFullTrust`: it's a desktop app that shares the screen and controls the keyboard and mouse for paired devices.

### Windows code signing

`npm run dist:win:signed` signs the app, installer and uninstaller with the certificate for "Michael Davies" in the Windows certificate store, using SHA-256 and a timestamp. Without that certificate it stops and says so, and `npm run dist:win` still builds unsigned.

- **Which certificate.**
  - Microsoft's own service, Azure Artifact Signing ($9.99 a month), only takes individuals in the US and Canada.
  - Elsewhere, Certum's **Standard Code Signing** set is issued to a person and costs $189 a year from <https://certum.store>. It comes with a card and reader to keep the key on. Certum's cloud version is sold to organisations only.
  - Certum checks your identity, automatically or with photos of your ID, plus a utility bill. Choose a certificate with your name as a natural person, so it matches "Michael Davies".
- **What it changes.** Windows shows "Michael Davies" as the publisher instead of "Unknown publisher". SmartScreen still warns at first: since 2024 even EV certificates only build reputation through downloads. The Microsoft Store copy never gets the warning.

---

## What to do with the Android APK

Since beta 3, `JConnect-Android.apk` is signed with JConnect's release key.

- The key is kept outside this repository, in `%USERPROFILE%\.jconnect-signing`: `android-release.p12`, and its password in `android-release.properties`. **Back up both files somewhere safe. Without them JConnect for Android can never be updated again.**
- `scripts/sign-android.js` signs the unsigned release APK that the Android workflow publishes on the `ci/android` branch, and checks it against `mobile/android/release-certificate.pem`.
- The certificate's SHA-256 is `8F:0C:D5:EC:9A:70:31:76:7F:1E:AB:86:1E:07:2B:FD:85:55:A3:C1:A2:B8:5C:C2:7B:39:42:1B:14:37:F6:CD`.

- **Android developer verification starts on 30 September 2026.** From then, certified Android devices in Brazil, Indonesia, Singapore and Thailand won't install apps from developers who haven't registered with Google, and that includes APKs downloaded from a website. The rest of the world follows in 2027. People can still install over adb, or through a deliberately slow "advanced flow". Register in the Android Developer Console. Full distribution costs $25 and needs government ID; limited distribution is free and allows up to 20 devices. To register `app.jconnect.android`, verify your identity first, then add the key by pasting `mobile/android/release-certificate.pem`. If Google has seen the package before, it asks you to prove it's yours instead. It gives you a snippet for `mobile/android/app/src/main/assets/adi-registration.properties`. Commit that file, sign the next CI release APK with `scripts/sign-android.js`, and upload it.
- **Uptodown and APKMirror** accept third-party APKs and are how many Android TV users sideload. APKMirror requires a verifiable upload identity.

Keep signing with this key forever. Android refuses an update signed with a different one, and there is no recovery from losing it.

---

## Where this leads

None of these listings is a Wikipedia source — the "Before you submit" section of `docs/wikipedia-draft.md` explains why. What they do is make JConnect *findable*, which is the precondition for someone writing about it, which is the precondition for the article. Order matters: winget and AlternativeTo first, then Wikidata and Show HN, Product Hunt at a signed release, Wikipedia much later, if ever.

## Related

- `jconnect-website/public/press/index.html` — press kit, for approaching writers directly
- `jconnect-website/public/about/index.html` — the neutral description these listings condense
- `docs/wikipedia-draft.md` — the parked article and its notability gate
