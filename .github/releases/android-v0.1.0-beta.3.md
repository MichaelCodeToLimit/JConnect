**Early beta.** This is the third test build of the JConnect app for Android.

## Uninstall beta 1 or 2 first

From this beta on, JConnect for Android is signed with its own release key instead of a development key. Android only installs an update signed with the same key as the app it replaces, so beta 3 can't install over beta 1 or 2. Uninstall the earlier beta, then install this one. You'll need to add your computers again.

This is the key JConnect will be signed with from now on. It's also the key that ties the app to its developer for Google's developer verification, which Android is starting to require for apps installed from outside Google Play.

## What's new in beta 3

- **Android TV and Google TV.** The app installs on TVs and appears on the TV's home screen. On a TV, **Add Computer** lists the computers on the network, so there's no address to type. In a session, the arrows move the pointer and **OK** clicks. Hold **OK** to right-click, or hold it while moving to drag. **Back** shows the session controls.
- **Updates.** JConnect checks JConnect's website for a new version, and the home screen shows **Update** when there is one. The first time, Android asks you to allow JConnect to install apps.
- **Security fixes** from the security sweep that also went into the desktop betas.
- The app is built for release: it can't be debugged over USB, and it's smaller.

## Download

- **JConnect-0.1.0-beta.3.apk**: Android 8.0 or later, phones, tablets and TVs, 31 MB
- SHA-256: `58936f5f1f5f1b97bc86ee8edf7227564e8d65e6c7a174015111249631823f8b`
- Signing certificate SHA-256: `8F:0C:D5:EC:9A:70:31:76:7F:1E:AB:86:1E:07:2B:FD:85:55:A3:C1:A2:B8:5C:C2:7B:39:42:1B:14:37:F6:CD`

It's the same file the JConnect website offers.

## Install

1. Uninstall beta 1 or 2 if you have it.
2. Open the APK on your phone or tablet. The first time, Android asks you to allow installing apps from your browser or file manager. On a TV, install it with an app such as Downloader, or with `adb install`.
3. Open JConnect and tap **Add Computer**.

The phone or TV needs to be on the same network as the computer, or on the same private network such as Tailscale.

## Known limits

- It connects to your computers. It doesn't share the phone's or TV's own screen.
- The TV layout has been tested in a window the size of a TV screen, not yet on a real TV.
- It isn't on Google Play yet.
