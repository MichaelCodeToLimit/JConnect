#!/usr/bin/env bash
# Creates and boots an Android emulator on a Linux CI runner, logging every step so failures are visible.
# Usage: bash mobile/scripts/emulator-boot.sh [api level]
set -eu

api="${1:-34}"
image="system-images;android-${api};google_apis;x86_64"
sdk="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
bin="$sdk/cmdline-tools/latest/bin"
adb="$sdk/platform-tools/adb"

echo "== KVM"
ls -l /dev/kvm || echo "no /dev/kvm, so the emulator will be very slow or won't start"

echo "== installing $image"
yes | "$bin/sdkmanager" --install "$image" "emulator" "platform-tools" > sdkmanager.log 2>&1 || { tail -30 sdkmanager.log; exit 1; }
tail -3 sdkmanager.log

echo "== creating the emulator"
echo no | "$bin/avdmanager" create avd --force -n ci -k "$image" -d pixel_6

echo "== starting it"
nohup "$sdk/emulator/emulator" -avd ci -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim -no-snapshot -camera-back none > emulator.log 2>&1 &
"$adb" wait-for-device
booted=""
for i in $(seq 1 150); do
  if [ "$("$adb" shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" = "1" ]; then
    booted=1
    echo "booted after about $((i * 2)) seconds"
    break
  fi
  sleep 2
done
if [ -z "$booted" ]; then
  echo "::error::The emulator didn't finish booting"
  tail -60 emulator.log
  exit 1
fi
"$adb" shell input keyevent 82 || true
"$adb" shell settings put global window_animation_scale 0 || true
"$adb" shell settings put global transition_animation_scale 0 || true
"$adb" shell settings put global animator_duration_scale 0 || true
