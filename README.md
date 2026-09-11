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
