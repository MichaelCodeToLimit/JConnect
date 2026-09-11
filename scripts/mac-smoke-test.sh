#!/usr/bin/env bash
# Checks the macOS build on a Mac. Each DMG must mount and hold a signed JConnect.app with its input helper,
# and the app must start, answer on its port and find the helper.
# Usage: bash scripts/mac-smoke-test.sh [folder for logs and screenshots]
set -euo pipefail

cd "$(dirname "$0")/.."
out="${1:-dist}"
mkdir -p "$out"
version="$(node -p "require('./package.json').version")"
status=0

for arch in arm64 x64; do
  dmg="dist/JConnect-${version}-${arch}.dmg"
  echo "== $dmg ($(du -h "$dmg" | cut -f1))"
  mount="$(mktemp -d /tmp/jconnect-dmg.XXXX)"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg" > /dev/null
  app="$mount/JConnect.app"
  exe="$app/Contents/MacOS/JConnect"
  helper="$app/Contents/MacOS/jconnect-input"

  if [ -L "$mount/Applications" ]; then echo "Applications shortcut: yes"; else echo "::error::$dmg has no Applications shortcut"; status=1; fi
  codesign --verify --deep --strict --verbose=2 "$app"
  codesign -dv "$app" 2>&1 | grep -E '^(Identifier|Format|Signature)='
  echo "app architectures: $(lipo -archs "$exe")"
  echo "helper architectures: $(lipo -archs "$helper")"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' -c 'Print :LSMinimumSystemVersion' "$app/Contents/Info.plist"

  if [ "$arch" = x64 ] && ! /usr/bin/arch -x86_64 /usr/bin/true 2> /dev/null; then
    echo "Rosetta isn't installed here, so the Intel app was checked but not started."
    hdiutil detach "$mount" -quiet || hdiutil detach "$mount" -force -quiet
    continue
  fi

  echo "input helper: $(printf '' | "$helper")"
  port=$((47900 + RANDOM % 90))
  log="$out/app-$arch.log"
  "$exe" --profile="smoke-$arch" --port="$port" > "$log" 2>&1 &
  pid=$!
  info=""
  for _ in $(seq 1 90); do
    if info="$(curl -sf "http://127.0.0.1:$port/api/info")"; then break; fi
    if ! kill -0 "$pid" 2> /dev/null; then break; fi
    sleep 1
  done

  if [ -n "$info" ]; then
    echo "app answered on port $port: $info"
    sleep 4
    screencapture -x "$out/window-$arch.png" 2> /dev/null || true
  else
    echo "::error::JConnect ($arch) did not answer on port $port"
    status=1
  fi
  if grep -q "input unavailable" "$log"; then
    echo "::error::JConnect ($arch) could not start its input helper"
    status=1
  fi

  kill "$pid" 2> /dev/null || true
  wait "$pid" 2> /dev/null || true
  sed 's/^/  app: /' "$log" | head -40
  hdiutil detach "$mount" -quiet || hdiutil detach "$mount" -force -quiet
done

exit $status
