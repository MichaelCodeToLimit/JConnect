# Launch drafts

Drafts for listings and posts. Nothing here has been submitted or posted. Check every claim against the current build before posting, and post from your own accounts.

Links used below:
- Site: https://jconnect-1dsx.onrender.com
- Downloads: https://github.com/MichaelCodeToLimit/JConnect-releases/releases
- winget: `winget install MichaelDavies.JConnect` (only after the pull request microsoft/winget-pkgs#487463 merges)

## AlternativeTo

- **Name:** JConnect
- **Tagline (under 80 characters):** Remote desktop for your own computers, with no port forwarding or account
- **Description:** JConnect lets you control your own computers from anywhere. Computers on your network find each other, you pair them once with a six-digit code, and every session is end-to-end encrypted. There are no IP addresses to remember and no port forwarding to set up, and you don't need an account. It works with Tailscale, Twingate, ZeroTier, WireGuard and Windows VPN connections, and has its own built-in network, JVPN. It also includes an SSH terminal, RDP files and Wake-on-LAN.
- **Platforms:** Windows, Mac, Linux, Android, Android TV
- **License:** Free, proprietary (not open source)
- **Alternatives to list:** AnyDesk, TeamViewer, Chrome Remote Desktop, RustDesk, Parsec
- **Tags:** remote desktop, remote control, encryption, VPN, Wake-on-LAN, SSH

## Product Hunt

- **Name:** JConnect
- **Tagline (under 60 characters):** Remote desktop with no port forwarding or accounts
- **Description:** Pair your computers once with a six-digit code, then connect from anywhere. End-to-end encrypted, works with the VPN you already use.
- **First comment:** I built JConnect because I wanted to reach my own computers without opening ports or signing up for someone else's cloud. Nearby computers find each other, you pair with a code, and sessions are end-to-end encrypted. It's an early beta for Windows, Mac, Linux and Android. I'd like to hear what breaks.

## Reddit (r/selfhosted or r/sysadmin: read each community's self-promotion rules first)

**Title:** I made a remote desktop app that needs no port forwarding or account (early beta)

**Body:**
I wanted to reach my own computers without opening ports or trusting a third-party cloud, so I built JConnect.

- Computers on your network find each other, and you pair once with a six-digit code.
- Every session is end-to-end encrypted.
- It works alongside Tailscale, Twingate, ZeroTier, WireGuard and Windows VPN connections, and has its own network, JVPN.
- It has an SSH terminal, RDP files and Wake-on-LAN.
- Windows, Mac, Linux and Android are covered. An account is optional.

It's an early beta, it isn't code-signed yet, and the source isn't public. Downloads and checksums are on GitHub: https://github.com/MichaelCodeToLimit/JConnect-releases/releases

I'd value bug reports and honest criticism, especially on the security design.

## Show HN

**Title:** Show HN: JConnect, remote desktop with no port forwarding or accounts

**Text:** Same as the Reddit body, shorter. Hacker News readers will ask about the threat model and why the source is closed, so have answers ready: say how pairing works, what the relay sees, and why you chose not to publish the source.

## Before any of these

- The Windows and Mac builds are unsigned, so people will see a warning. Say so up front, as above.
- Expect questions about open source. The release notes should answer them.
- Do not post to several communities on the same day. Give each its own reply time.
