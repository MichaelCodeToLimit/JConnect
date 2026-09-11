**Early beta.** This is the second test build of the JConnect app for Android.

## What's new in beta 2

- **Pair with a code.** Add Computer takes the computer's address and the 6-digit pairing code shown at the bottom of the JConnect window, so you can pair without scanning anything. The "Use this computer?" screen also has **Enter a pairing code instead**.
- While pairing with a code, JConnect shows "Pairing with …" instead of waiting for someone at the computer.

## Download

- **JConnect-0.1.0-beta.2.apk**: Android 8.0 or later, 34 MB
- SHA-256: `400a33016fec52b6ec9e7e061122b82e4ad0cbf89a1f44d9a3497d1898119075`

It installs over beta 1, and it's the same file the JConnect website offers.

## Install

1. Open the APK on your phone or tablet. The first time, Android asks you to allow installing apps from your browser or file manager.
2. Open JConnect and tap **Add Computer**.
3. Scan the code shown on the computer under **Settings → Use this computer from a phone**. Or type the computer's address and its pairing code.

The phone needs to be on the same network as the computer, or on the same private network such as Tailscale.

## Known limits

- It connects to your computers. It doesn't share the phone's own screen.
- Accounts, sync and JVPN aren't in the Android app yet.
- The APK is signed with a development key and isn't on Google Play. There are no automatic updates yet.
