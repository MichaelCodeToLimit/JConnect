# JConnect website

Static marketing site for JConnect. Everything that is served lives in `public/`.

- Preview locally: `python -m http.server 5180 --directory public`
- Animations in `public/media/` were generated with Higgsfield and compressed with ffmpeg.
- Deployed on Render as a static site (publish directory `public`).

## Updating the download

Every Download button points at `public/download/JConnect-Setup.exe`. To ship a new build:

1. Copy the new installer from the app repo (`dist/JConnect-Setup-<version>.exe`) to `public/download/JConnect-Setup.exe`.
2. Regenerate the checksum: `sha256sum JConnect-Setup.exe > JConnect-Setup.exe.sha256` (run inside `public/download/`).
3. Update the version and size shown in the `#download` section of `public/index.html`.

GitHub rejects files over 100 MB. If the installer grows past that, host it on a GitHub Release and point the buttons at the release URL instead.

## Updating the Android app

The download page offers `public/download/JConnect-Android.apk`. To ship a new build:

1. In the app repo, build the APK (`cd mobile && npm run sync && cd android && ./gradlew assembleDebug`) and copy `app/build/outputs/apk/debug/app-debug.apk` to `public/download/JConnect-Android.apk`.
2. Regenerate `JConnect-Android.apk.sha256` the same way as the installer's.
3. Update the version and size on the Android card in `public/download/index.html`, and in the Android entry of `RECOMMEND` in `public/assets/js/site.js`.

Build every Android release on the same computer. Android only installs an update that is signed with the same key as the app already on the phone.

## GitHub releases

`.github/workflows/release-android.yml` publishes the APK this site serves as a GitHub pre-release, after checking its SHA-256. To publish a new build, update the values under `env` in that file, add release notes in `.github/releases/<tag>.md`, and push to `main`.
