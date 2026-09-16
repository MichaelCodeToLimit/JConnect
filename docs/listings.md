# Directory listings — ready-to-paste copy

Everything below is written and ready. **Nothing has been submitted**: each of these needs an account in your name, and publishing under your identity is your call, not mine. Paste and send when you want them live.

Ordered by what is worth doing first.

---

## 1. AlternativeTo — do this one first

The highest-value listing available to you today. It accepts proprietary freeware, it ranks well for "TeamViewer alternative" searches, and journalists genuinely browse it when writing roundups. A listing here is also the kind of thing that later helps a Wikipedia reviewer believe the software exists, even though it is not itself a valid source.

Submit at <https://alternativeto.net/manage/app/new/>. Requires a free account.

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

**Suggest as an alternative to**: TeamViewer, AnyDesk, Chrome Remote Desktop, RustDesk, Parsec, Splashtop, NoMachine

**Screenshots**: upload `jconnect-website/public/media/desktop.jpg`, `jvpn.jpg`, `sync.jpg`.

> Disclose that you are the developer in the submission notes. AlternativeTo allows developer submissions; concealing it and being caught is worse than saying so.

---

## 2. Wikidata — possible, and much easier than Wikipedia

Wikidata's bar is *structural identifiability*, not notability-by-coverage: an item needs to be a "clearly identifiable conceptual entity" described by at least one serious, publicly available reference. Software with a real website, real releases and real checksums usually qualifies. It is still deleted sometimes, so treat it as low-cost and low-stakes.

A Wikidata item also gives you a stable identifier that other databases consume. It does **not** create any entitlement to a Wikipedia article.

Create at <https://www.wikidata.org/wiki/Special:NewItem>.

| Field | Value |
| --- | --- |
| Label (en) | JConnect |
| Description (en) | remote desktop software |
| Aliases (en) | JConnect — Just Connect |

**Statements**

```
instance of (P31)            → software (Q7397)
instance of (P31)            → remote desktop software (Q1155404)
official website (P856)      → https://jconnect-1dsx.onrender.com
developer (P178)             → Michael Davies   [only if you have a Wikidata item; otherwise skip]
inception (P571)             → September 2026
software version identifier (P348) → 0.1.0 beta
    qualifier: publication date (P577) → September 2026
operating system (P306)      → Microsoft Windows (Q1406)
operating system (P306)      → macOS (Q14116)
operating system (P306)      → Linux (Q388)
operating system (P306)      → Android (Q94)
programmed in (P277)         → JavaScript (Q2005)
programmed in (P277)         → Swift (Q17118377)
programmed in (P277)         → C (Q15777)
copyright license (P275)     → proprietary license (Q6944932)
platform (P400)              → Electron (Q23763986)
```

Add `reference URL (P854)` pointing at the About page for anything not self-evident.

> Do not add `described at URL` chains of your own pages to pad it. A sparse honest item survives; a padded one draws attention.

---

## 3. Show HN — the single highest-upside action on this list

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
both warn on first launch. Linux control is X11 only — no Wayland. Android is a dev-signed
APK off the site, not Play. No camera sharing. Source isn't open.

Happy to answer anything about the protocol or the relay design.
```

**Timing**: weekday, 08:00–10:00 US Eastern. Do not ask anyone to upvote — HN detects voting rings and it will kill the post and the domain.

---

## 4. Product Hunt

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

## 5. Software directories that accept submissions

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

## What to do with the Android APK

`JConnect-Android.apk` is currently dev-signed and distributed from the website and as a GitHub pre-release. Two things worth knowing:

- **Google Play** needs a one-time $25 developer registration, a release-signed APK (a new upload key — you cannot switch later without Play App Signing), a privacy policy URL, and a store listing. Given JConnect handles device pairing and screen content, expect scrutiny of the permissions declaration. Worth doing before any Product Hunt launch.
- **Uptodown and APKMirror** accept third-party APKs and are how many Android TV users sideload. APKMirror requires a verifiable upload identity.

Either way: keep signing with the same key forever. Android refuses an update signed with a different one, and there is no recovery from losing it.

---

## Where this leads

None of these listings is a Wikipedia source — the "Before you submit" section of `docs/wikipedia-draft.md` explains why. What they do is make JConnect *findable*, which is the precondition for someone writing about it, which is the precondition for the article. Order matters: AlternativeTo and Show HN first, Product Hunt at a signed release, Wikipedia much later, if ever.

## Related

- `jconnect-website/public/press/index.html` — press kit, for approaching writers directly
- `jconnect-website/public/about/index.html` — the neutral description these listings condense
- `docs/wikipedia-draft.md` — the parked article and its notability gate
