**Early beta.** This is the second test build of JConnect for Linux.

## What's new in beta 2

- **Terminate JConnect and Shut Down.** Press **⏻** at the top of the JConnect window, or use the tray menu. **Terminate JConnect** ends every connection and task, stops all of JConnect's background services and closes it. **Shut Down Computer** turns the computer off. Both ask first.
- **Security fixes.** JConnect now runs on Electron 44. Web pages from other websites can't reach JConnect's connection anymore, and computer names can't add commands to desktop shortcuts. Connections that flood a computer with data before signing in are cut off.

## Download

- **JConnect-0.1.0-beta.2-amd64.deb**: for Ubuntu, Debian, Linux Mint and other Debian-based systems. It's also on the download page of the JConnect website.
- **JConnect-0.1.0-beta.2-x86_64.AppImage**: for other distributions
- **SHA256SUMS.txt**: checksums for both

Both are for 64-bit Intel and AMD PCs. The .deb installs over beta 1.

## Install

- **.deb:** run `sudo apt install ./JConnect-0.1.0-beta.2-amd64.deb`, then open JConnect from your apps. It also sets up JConnect's security sandbox and adds a `jconnect` command.
- **AppImage:** run `chmod +x JConnect-0.1.0-beta.2-x86_64.AppImage`, then open it.

JConnect starts when you sign in. You can turn that off in Settings.

## What's checked

Every build is installed and started on Ubuntu 24.04, with Ubuntu's restrictions on app sandboxes both on and off. The checks confirm that:

- Both packages start and accept connections.
- Remote control works in a window: the pointer, all five mouse buttons, scrolling, 130 keys, and typing, including characters the keyboard layout doesn't have.
- A JConnect viewer pairs with the computer using its code and receives its screen.

## Known limits

- Wayland sessions aren't supported yet. Paired devices can't control the computer there, and screen sharing hasn't been tested. Choose an X11 session when you sign in, such as **Ubuntu on Xorg** on Ubuntu 24.04.
- The computer's sound isn't shared yet.
- ARM computers, including Raspberry Pi, aren't supported yet.
- The packages aren't signed, and there are no automatic updates yet.
