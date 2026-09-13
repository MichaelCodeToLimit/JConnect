**Early beta.** This is the first test build of JConnect for Mac.

## Download

- **JConnect-0.1.0-beta.1-arm64.dmg**: for Macs with Apple silicon (M1 or later)
- **JConnect-0.1.0-beta.1-x64.dmg**: for Macs with an Intel processor
- **SHA256SUMS.txt**: checksums for both

Not sure which Mac you have? Open the Apple menu → **About This Mac**. It shows **Chip** on Apple silicon Macs and **Processor** on Intel Macs. Both DMGs are also on the download page of the JConnect website.

Both need macOS 13 Ventura or later.

## Install

1. Open the DMG and drag **JConnect** into **Applications**.
2. Open JConnect from Applications. This build isn't notarized by Apple yet, so macOS says it can't check it for malicious software. Close that message, then open **System Settings → Privacy & Security**, scroll down and choose **Open Anyway** next to JConnect.
3. To let your paired devices see and control this Mac, open JConnect's **Settings → Mac permissions** and turn on **Screen Recording** and **Accessibility** when macOS asks.

JConnect starts when you sign in. You can turn that off in Settings.

## What's checked

Every build is checked before it's published:

- Both DMGs open, hold a correctly signed JConnect app with its input helper, and include the Applications shortcut.
- The Apple silicon app starts on macOS 26, answers connections and starts its input helper.
- The Intel app starts on an Intel Mac, answers connections and starts its input helper.

## Known limits

- The app is signed without an Apple Developer ID and isn't notarized, so macOS asks you to confirm it the first time.
- The Mac's sound isn't shared yet.
- The app is in English only.
- There are no automatic updates yet.
