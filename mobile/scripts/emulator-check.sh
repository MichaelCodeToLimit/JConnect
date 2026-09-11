#!/usr/bin/env bash
# Runs on a booted Android emulator: installs the APK, starts JConnect and checks that it runs,
# that its web app loaded without JavaScript errors, and that the home screen shows.
# Usage: bash mobile/scripts/emulator-check.sh <apk> [folder for logs and screenshots]
set -uo pipefail

apk="$1"
out="${2:-ci-logs}"
mkdir -p "$out"
package=app.jconnect.android
status=0

adb install -r "$apk" 2>&1 | tee "$out/5-install.log"
adb logcat -c
adb shell am start -W -n "$package/.MainActivity" 2>&1 | tee "$out/6-start.log"
sleep 20

adb exec-out screencap -p > "$out/android-home.png"
adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 && adb pull /sdcard/ui.xml "$out/ui.xml" > /dev/null 2>&1
adb logcat -d > "$out/logcat.txt"

if adb shell pidof "$package" > /dev/null; then
  echo "JConnect is running"
else
  echo "::error::JConnect isn't running"
  status=1
fi
if grep -E "FATAL EXCEPTION" -A 12 "$out/logcat.txt" | grep -q "$package"; then
  echo "::error::JConnect crashed"
  grep -E "FATAL EXCEPTION" -A 12 "$out/logcat.txt"
  status=1
fi
grep -E "Capacitor/Console|Capacitor:|chromium" "$out/logcat.txt" > "$out/7-web-console.log" || true
if grep -q -E "Uncaught|ReferenceError|TypeError|SyntaxError" "$out/7-web-console.log"; then
  echo "::error::The web app reported a JavaScript error"
  grep -E "Uncaught|ReferenceError|TypeError|SyntaxError" "$out/7-web-console.log"
  status=1
fi
if [ -f "$out/ui.xml" ] && grep -q "Add Computer" "$out/ui.xml"; then
  echo "Home screen shows Add Computer"
else
  echo "::warning::Couldn't find Add Computer on screen. Check android-home.png."
fi

exit $status
