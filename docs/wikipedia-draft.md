# Parked Wikipedia draft — JConnect

**Status: not submittable.** This draft is complete in structure and prose, and blocked on one thing only: independent sources. Do not paste it into Wikipedia yet. Read "Before you submit" first.

---

## Before you submit

Wikipedia keeps an article only when the subject has **significant coverage in reliable sources independent of it** ([WP:GNG](https://en.wikipedia.org/wiki/Wikipedia:Notability), [WP:NSOFT](https://en.wikipedia.org/wiki/Wikipedia:Notability_(software))). As of the last update to this file, JConnect has none.

**What does not count**, no matter how many of them there are:

- the JConnect website, this repository, the docs, release notes, the press kit
- GitHub stars, download counts, Play Store or directory listings
- Reddit, Hacker News, X, Discord, forum posts, YouTube reviews by individuals
- press releases, sponsored posts, or articles that merely reprint the press kit
- "best remote desktop tools" listicles that give the product one line

**What counts**: an article *about* JConnect, written by someone with no connection to the project, in a publication with editorial oversight and a reputation for fact-checking. Realistically: Ars Technica, The Register, Heise, LWN, TechRadar, XDA, Golem, a national newspaper's tech section, or a book chapter. Two such sources is the working minimum; three is comfortable.

**Conflict of interest.** Michael Davies is the developer, so submitting this is a [WP:COI](https://en.wikipedia.org/wiki/Wikipedia:Conflict_of_interest) edit. That is permitted but regulated:

1. Do **not** create the article directly. Use [Articles for Creation](https://en.wikipedia.org/wiki/Wikipedia:Articles_for_creation) — save it as `Draft:JConnect` and submit for review.
2. Declare the conflict on your user page and on the draft's talk page. Paste this on your user page:
   > `{{UserboxCOI|1=JConnect}}` — I am the developer of JConnect and have a conflict of interest regarding that topic. I use Articles for Creation rather than editing the article directly.
3. If JConnect ever becomes paid work for anyone else, the stricter [WP:PAID](https://en.wikipedia.org/wiki/Wikipedia:Paid-contribution_disclosure) disclosure applies and is mandatory.

**Title.** `JConnect` is likely to be contested — unrelated organisations and apps use the name. Expect to end up at `JConnect (software)` or `JConnect (remote desktop software)`, with a hatnote.

**The realistic sequence**: ship publicly → get code signing and notarization sorted (reviewers notice) → pitch writers using the press kit → wait for two or three real articles → *then* submit this. That is quarters, not weeks.

---

## Checklist before submitting

- [ ] Two or more independent, reliable sources with substantial coverage exist
- [ ] Every `{{citation needed}}` and `SOURCE NEEDED` marker below is resolved or the sentence is deleted
- [ ] Every remaining claim is attributed, and nothing is sourced only to the project
- [ ] Promotional language removed — no "seamless", "effortless", "revolutionary", no second person
- [ ] COI declared on user page and draft talk page
- [ ] Saved as `Draft:JConnect` and submitted via AfC, not published directly

---

## The draft (wikitext)

Paste everything between the rules into the Wikipedia editor.

---

```wikitext
{{AfC submission|||ts=|u=|ns=118}}
{{COI|date=}}

{{Infobox software
| name                   = JConnect
| logo                   = 
| screenshot             = 
| caption                = 
| developer              = Michael Davies
| released               = {{Start date and age|2026|09}}
| latest release version = 0.1.0 beta
| latest release date    = {{Start date and age|2026|09}}
| programming language   = [[JavaScript]], [[Swift (programming language)|Swift]], [[C (programming language)|C]]
| operating system       = [[Microsoft Windows|Windows]], [[macOS]], [[Linux]], [[Android (operating system)|Android]]
| platform               = [[Electron (software framework)|Electron]]
| genre                  = [[Remote desktop software]]
| license                = [[Proprietary software|Proprietary]]
| website                = 
}}

'''JConnect''' is [[remote desktop software]] for [[Microsoft Windows|Windows]], [[macOS]], [[Linux]] and [[Android (operating system)|Android]], developed by Michael Davies and first released in beta in September 2026.<!-- SOURCE NEEDED: independent coverage establishing existence and release --> It is designed to operate without manual network configuration: devices on a local network discover one another automatically, are paired once using a six-digit code, and thereafter connect without the user supplying an [[IP address]], configuring [[port forwarding]] or creating an account.<!-- SOURCE NEEDED -->

In addition to screen sharing and remote control, the software includes an [[Secure Shell|SSH]] client, routing for [[Remote Desktop Protocol]] connections, optional [[end-to-end encryption|end-to-end encrypted]] synchronisation of device lists between a user's machines, and a built-in relay network, marketed as JVPN, for connections outside a local network.<!-- SOURCE NEEDED -->

== History ==

Development began in September 2026.<!-- SOURCE NEEDED: only the repository records this; needs independent corroboration or removal --> Initial builds supported Windows, followed by macOS, Linux and Android releases in the same month. The first public version, 0.1.0 beta, was distributed directly from the project's website rather than through application stores.<!-- SOURCE NEEDED -->

<!-- Expand this section once coverage exists. A history section built only from the developer's own changelog is a deletion argument, not an asset. -->

== Design ==

=== Pairing and discovery ===

Computers running JConnect announce a name and a [[public key]] on the local network; the announcement can be disabled. Pairing is performed once per device, either by entering a six-digit code displayed on the target machine or by confirming a matching verification code on both screens. Devices are subsequently identified by [[Curve25519|Ed25519]] key rather than by network address.<!-- SOURCE NEEDED -->

=== Connectivity ===

Connections on a local network are direct. For connections between networks, the software maintains an outbound connection from each machine to a relay server, through which other devices registered to the same account can reach it. The relay handles only encrypted traffic and does not have access to session contents.<!-- SOURCE NEEDED: this is a vendor claim and must be attributed or independently verified -->

The software can also start and use third-party virtual private network software installed on the same machine, including [[Tailscale]], [[ZeroTier]], [[WireGuard]] and FortiClient, importing the machines reachable on those networks.<!-- SOURCE NEEDED -->

=== Security ===

According to its developer, each session performs an ephemeral [[Curve25519|X25519]] key exchange and encrypts messages with [[Salsa20|XSalsa20]]-[[Poly1305]], with device identities based on Ed25519 keys and pairing codes exchanged as [[scrypt]] proofs bound to a single session. Screen and audio data are carried over [[WebRTC]].<!-- SOURCE NEEDED: currently sourced to the vendor only; either find an independent security review or keep the in-text attribution -->

== Platforms ==

JConnect runs on Windows 10 and 11, macOS 13 and later, 64-bit Linux distributions, and Android 8.0 and later, including [[Android TV]] devices, on which it provides an interface operated with a directional remote control. Devices without a native client can connect through a web browser served by a machine running the software.<!-- SOURCE NEEDED -->

== Reception ==

<!-- This section is the article. Without it there is no article. Do not submit with this section empty or filled from the project's own materials. -->

== See also ==

* [[Comparison of remote desktop software]]
* [[Remote desktop software]]
* [[Virtual Network Computing]]

== References ==

{{Reflist}}

<!--
Add sources in this form as they appear:

<ref>{{cite web |last= |first= |date= |title= |url= |work= |access-date=}}</ref>
<ref>{{cite magazine |last= |first= |date= |title= |url= |magazine= |access-date=}}</ref>

At least two must be substantial, independent and reliable. Listings, download mirrors
and the project's own site do not satisfy this and should not pad the list — reviewers
read the reference section first and discount self-published entries immediately.
-->

== External links ==

* {{Official website}}
```

---

## If it gets declined

An AfC decline is normal and is not a verdict on the software. Read the reviewer's reason:

- **"Not enough independent sources"** — the expected outcome today. Nothing to fix in the prose; wait for coverage.
- **"Reads like an advertisement"** — strip adjectives, remove feature lists, attribute every capability claim.
- **"Submitted by a connected contributor"** — confirm the COI declaration is in place, and never move the draft into article space yourself.

Do not resubmit unchanged, and do not create the article directly after a decline. Repeated attempts get the title salted, which is much harder to undo than waiting.

## Related

- Marketing-neutral project description: `jconnect-website/public/about/index.html`
- Press kit for approaching writers: `jconnect-website/public/press/index.html`
- Directory and database listings that accept self-submission: `docs/listings.md`
