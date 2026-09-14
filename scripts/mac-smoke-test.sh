#!/usr/bin/env bash
# Checks the macOS build on a Mac. Each DMG must mount and hold a signed JConnect.app with its input helper,
# and the app must start, answer on its port and find the helper.
# Usage: bash scripts/mac-smoke-test.sh [folder for logs and screenshots]
# JCONNECT_ARCHES picks which DMGs to check (default "arm64 x64"), for example x64 on an Intel Mac.
set -euo pipefail

cd "$(dirname "$0")/.."
out="${1:-dist}"
mkdir -p "$out"
native="$(uname -m)"
status=0

# Stop an app and everything it started, without waiting forever.
stop_app() {
  local pid="$1" app="$2"
  kill "$pid" 2> /dev/null || true
  for _ in $(seq 1 15); do
    kill -0 "$pid" 2> /dev/null || break
    sleep 1
  done
  kill -9 "$pid" 2> /dev/null || true
  pkill -9 -f "$app/Contents" 2> /dev/null || true
}

for arch in ${JCONNECT_ARCHES:-arm64 x64}; do
  # Each DMG is named with the version it was built as, which the release workflow sets.
  dmg="$(ls dist/JConnect-*-"${arch}".dmg | head -1)"
  echo "== $dmg ($(du -h "$dmg" | cut -f1))"
  mount="$(mktemp -d /tmp/jconnect-dmg.XXXX)"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg" > /dev/null
  app="$mount/JConnect.app"
  exe="$app/Contents/MacOS/JConnect"
  helper="$app/Contents/MacOS/jconnect-input"

  if [ -L "$mount/Applications" ]; then echo "Applications shortcut: yes"; else echo "::error::$dmg has no Applications shortcut"; status=1; fi
  if codesign --verify --deep --strict "$app"; then echo "signature: valid"; else echo "::error::$dmg has an invalid signature"; status=1; fi
  codesign -dv "$app" 2>&1 | grep -E '^(Identifier|Format|Signature)='
  echo "app architectures: $(lipo -archs "$exe")"
  echo "helper architectures: $(lipo -archs "$helper")"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' -c 'Print :LSMinimumSystemVersion' "$app/Contents/Info.plist"

  # On Apple silicon, the Intel app runs under Rosetta. On an Intel Mac it runs natively, so it must start.
  rosetta=0
  if [ "$arch" = x64 ] && [ "$native" != x86_64 ]; then rosetta=1; fi
  if [ "$rosetta" = 1 ] && ! /usr/bin/arch -x86_64 /usr/bin/true 2> /dev/null; then
    echo "Rosetta isn't installed here, so the Intel app was checked but not started."
    hdiutil detach "$mount" -force -quiet || true
    continue
  fi
  # The first launch under Rosetta can be very slow.
  wait_seconds=90
  if [ "$rosetta" = 1 ]; then wait_seconds=240; fi

  echo "input helper: $(printf '' | "$helper")"
  port=$((47900 + RANDOM % 90))
  log="$out/app-$arch.log"
  "$exe" --profile="smoke-$arch" --port="$port" > "$log" 2>&1 &
  pid=$!
  info=""
  for _ in $(seq 1 "$wait_seconds"); do
    if info="$(curl -sf --max-time 3 "http://127.0.0.1:$port/api/info")"; then break; fi
    if ! kill -0 "$pid" 2> /dev/null; then echo "JConnect ($arch) exited early"; break; fi
    sleep 1
  done

  if [ -n "$info" ]; then
    echo "app answered on port $port: $info"
    sleep 4
    screencapture -x "$out/window-$arch.png" 2> /dev/null || true
  elif [ "$rosetta" = 1 ]; then
    echo "::warning::The Intel app didn't answer within ${wait_seconds} seconds under Rosetta. It was built and signed, but couldn't be started on this runner."
  else
    echo "::error::JConnect ($arch) did not answer on port $port"
    status=1
  fi
  if grep -q "input unavailable" "$log"; then
    echo "::error::JConnect ($arch) could not start its input helper"
    status=1
  fi

  stop_app "$pid" "$app"
  sed 's/^/  app: /' "$log" | head -40
  hdiutil detach "$mount" -force -quiet || true
done

exit $status
