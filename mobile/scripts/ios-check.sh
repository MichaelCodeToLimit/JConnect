#!/usr/bin/env bash
# Runs on a Mac: installs the Simulator build of the iOS app, starts a test JConnect computer (test-host.js), and starts
# the app with that computer's address and pairing code. The app pairs through its native sockets and reports each
# step on the console (runSelfTest in mobile/src/native.js).
# Usage: bash mobile/scripts/ios-check.sh <App.app> [folder for logs and screenshots]
set -uo pipefail

app="$1"
out="${2:-ci-logs}"
mkdir -p "$out"
bundle=app.jconnect.ios
port=47811
status=0

# The newest iPhone the Simulator offers.
udid="$(xcrun simctl list devices available --json | node -e '
  const all = JSON.parse(require("fs").readFileSync(0, "utf8")).devices;
  const phones = Object.entries(all)
    .filter(([runtime]) => /iOS/.test(runtime))
    .flatMap(([runtime, list]) => list.filter((d) => /^iPhone/.test(d.name)).map((d) => ({ ...d, runtime })))
    .sort((a, b) => a.runtime.localeCompare(b.runtime, undefined, { numeric: true }));
  const pick = phones.at(-1);
  if (pick) console.log(pick.udid);
')"
if [ -z "$udid" ]; then echo "::error::No iPhone simulator is available"; exit 1; fi
xcrun simctl list devices | grep "$udid" | tee "$out/5-simulator.log"
xcrun simctl boot "$udid" 2> /dev/null || true
xcrun simctl bootstatus "$udid" -b >> "$out/5-simulator.log" 2>&1
xcrun simctl install "$udid" "$app" 2>&1 | tee -a "$out/5-simulator.log"

node mobile/scripts/test-host.js "$port" > "$out/6-test-computer.log" 2>&1 &
host_pid=$!
code=""
for _ in $(seq 1 30); do
  code="$(sed -n 's/^code \([0-9]\{6\}\)$/\1/p' "$out/6-test-computer.log")"
  [ -n "$code" ] && break
  sleep 1
done
if [ -z "$code" ]; then echo "::error::The test computer didn't start"; cat "$out/6-test-computer.log"; exit 1; fi
echo "test computer on port $port"

xcrun simctl launch --console-pty --terminate-running-process "$udid" "$bundle" \
  -JConnectSelfTest "127.0.0.1:$port?code=$code" > "$out/7-app-console.log" 2>&1 &
launch_pid=$!

result=""
for _ in $(seq 1 90); do
  result="$(grep -o 'jconnect-self-test: \(passed\|failed.*\)' "$out/7-app-console.log" | tail -1)"
  [ -n "$result" ] && break
  sleep 1
done
sleep 3
xcrun simctl io "$udid" screenshot "$out/ios-home.png" > /dev/null 2>&1 || true

grep 'jconnect-self-test' "$out/7-app-console.log" || true
case "$result" in
  *passed) echo "The app paired with the test computer and reached it again" ;;
  "") echo "::error::The app didn't report its self-test within 90 seconds"; status=1 ;;
  *) echo "::error::The app's self-test $result"; status=1 ;;
esac
if grep -q '^paired ' "$out/6-test-computer.log"; then
  echo "The test computer trusts the app: $(grep '^paired ' "$out/6-test-computer.log")"
else
  echo "::error::The test computer never paired with the app"
  status=1
fi
if grep -E '\[error\]' "$out/7-app-console.log"; then
  echo "::error::The web app reported an error"
  status=1
fi
if xcrun simctl spawn "$udid" launchctl list 2> /dev/null | grep -q "$bundle"; then
  echo "JConnect is still running"
else
  echo "::error::JConnect isn't running anymore"
  status=1
fi

kill "$launch_pid" "$host_pid" 2> /dev/null || true
xcrun simctl terminate "$udid" "$bundle" 2> /dev/null || true
exit $status
