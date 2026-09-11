#!/usr/bin/env bash
# Checks the Linux build on Ubuntu, under Xvfb:
# - the .deb installs with its dependencies, and the installed app and the AppImage start and answer on their ports,
#   also with unprivileged user namespaces restricted the way Ubuntu 24.04 desktops restrict them
# - remote control: input sent the way viewers send it moves the pointer, clicks, scrolls and types in a window
# - screen sharing: a JConnect viewer pairs with a JConnect host using its code and receives the host's screen
# Needs xvfb, x11-utils and imagemagick, and sudo to install the .deb.
# Usage: bash scripts/linux-smoke-test.sh [folder for logs and screenshots]
set -uo pipefail

cd "$(dirname "$0")/.."
out="${1:-dist}"
mkdir -p "$out"
status=0
fail() {
  echo "::error::$*"
  status=1
}

deb="$(ls dist/*.deb | head -1)"
appimage="$PWD/$(ls dist/*.AppImage | head -1)"

export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp > "$out/xvfb.log" 2>&1 &
xvfb=$!
for _ in $(seq 1 40); do
  xdpyinfo > /dev/null 2>&1 && break
  sleep 0.25
done
echo "display: $(xdpyinfo | grep -o 'dimensions: *[0-9x]*')"

restrict=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
restrict_original="$(cat "$restrict" 2> /dev/null || echo none)"
echo "apparmor_restrict_unprivileged_userns: $restrict_original"
restrict_userns() {
  if [ -f "$restrict" ]; then echo "$1" | sudo tee "$restrict" > /dev/null; fi
}

# Starts JConnect, waits until it answers on its port, takes a screenshot and stops it.
# Usage: check_app name port command [arguments]
check_app() {
  local name="$1" port="$2"
  shift 2
  local log="$out/app-$name.log" info=""
  "$@" --port="$port" > "$log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 60); do
    if info="$(curl -sf --max-time 3 "http://127.0.0.1:$port/api/info")"; then break; fi
    if ! kill -0 "$pid" 2> /dev/null; then
      echo "JConnect ($name) exited early"
      break
    fi
    sleep 1
  done
  if [ -n "$info" ]; then
    echo "JConnect ($name) answered on port $port: $info"
    sleep 4
    import -window root "$out/screen-$name.png" 2> /dev/null || true
  else
    fail "JConnect ($name) did not answer on port $port"
  fi
  if grep -q -E 'input unavailable|input helper:' "$log"; then fail "JConnect ($name) could not use its input helper"; fi
  kill "$pid" 2> /dev/null || true
  pkill -f -- "--port=$port" 2> /dev/null || true
  for _ in $(seq 1 10); do
    pgrep -f -- "--port=$port" > /dev/null || break
    sleep 1
  done
  pkill -9 -f -- "--port=$port" 2> /dev/null || true
  sed 's/^/  app: /' "$log" | head -30
}

autostart="$HOME/.config/autostart/jconnect.desktop"
check_autostart() {
  if grep -q -F "Exec=\"$1\" --hidden" "$autostart" 2> /dev/null; then
    echo "start at login: $(grep '^Exec=' "$autostart")"
  else
    fail "JConnect didn't set itself to start at login with $1 ($(grep '^Exec=' "$autostart" 2> /dev/null || echo "no $autostart"))"
  fi
}

echo "== $deb"
dpkg-deb --field "$deb" Package Version Architecture Maintainer Installed-Size Depends
dpkg-deb --contents "$deb" | awk '{print $1, $6}' | grep -E '/opt/JConnect/(jconnect|jconnect-input|chrome-sandbox)$'
if sudo apt-get install -y "./$deb" > "$out/deb-install.log" 2>&1; then
  tail -2 "$out/deb-install.log"
else
  fail "the .deb didn't install"
  tail -20 "$out/deb-install.log"
fi
helper=/opt/JConnect/jconnect-input
if [ -x "$helper" ]; then
  echo "input helper: $(printf '' | "$helper")"
  echo "input helper needs $(objdump -T "$helper" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1) or later"
else
  fail "the .deb has no runnable input helper"
fi
ls -l /usr/bin/jconnect /opt/JConnect/chrome-sandbox
ls /etc/apparmor.d | grep -i jconnect | sed 's/^/AppArmor profile: /' || echo "no AppArmor profile was installed"

restrict_userns 0
check_app deb 47901 /usr/bin/jconnect
check_autostart /opt/JConnect/jconnect
if [ -f "$restrict" ]; then
  echo "== the .deb app with user namespaces restricted"
  restrict_userns 1
  check_app deb-restricted 47902 /usr/bin/jconnect --profile=smoke-deb-restricted
fi

echo "== $appimage ($(du -h "$appimage" | cut -f1))"
chmod +x "$appimage"
restrict_userns 0
check_app appimage 47903 "$appimage"
check_autostart "$appimage"
if [ -f "$restrict" ]; then
  echo "== the AppImage with user namespaces restricted"
  restrict_userns 1
  check_app appimage-restricted 47904 "$appimage" --profile=smoke-appimage-restricted
fi
# The checks below run Electron from node_modules, which has no AppArmor profile of its own.
restrict_userns 0

echo "== remote control"
if ! JCONNECT_CHECK_SCREENSHOT="$PWD/$out/input-check.png" timeout 150 npx electron --no-sandbox scripts/linux-input-check.js > "$out/input-check.log" 2>&1; then
  fail "the remote control check failed"
fi
grep '^\[input-check\]' "$out/input-check.log" || tail -30 "$out/input-check.log"

echo "== screen sharing"
npx electron --no-sandbox . --profile=smoke-host --port=47911 --hidden > "$out/stream-host.log" 2>&1 &
code=""
for _ in $(seq 1 60); do
  code="$(grep -o -m1 'pairing code [0-9]*' "$out/stream-host.log" | grep -o '[0-9]*$')"
  [ -n "$code" ] && break
  sleep 1
done
if [ -z "$code" ]; then
  fail "the JConnect host didn't start"
else
  JCONNECT_SELFTEST_OUT="$PWD/$out/stream.png" JCONNECT_SELFTEST_EXIT=1 timeout 180 \
    npx electron --no-sandbox . --profile=smoke-viewer --port=47912 "--selftest=ws://127.0.0.1:47911/ws|$code" > "$out/stream-viewer.log" 2>&1
  grep '\[selftest\]' "$out/stream-viewer.log" | cut -c1-240 | grep -v '^\[selftest\] stats' | head -10
  grep '\[selftest\] stats' "$out/stream-viewer.log" | tail -1 | cut -c1-400
  grep -q '\[selftest\] screenshot' "$out/stream-viewer.log" || fail "the viewer didn't receive the host's screen"
fi
pkill -f -- '--port=4791[12]' 2> /dev/null || true
grep -v 'pairing code' "$out/stream-host.log" | sed 's/^/  host: /' | head -20

kill "$xvfb" 2> /dev/null || true
exit $status
