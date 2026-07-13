#!/bin/zsh
#
# install-xctest-sweep.sh — install (or remove) a per-user LaunchAgent that
# periodically reaps two kinds of leaked Xcode test cruft from the internal disk:
#   1. Leaked XCTest clone simulators in the shared device set
#      ~/Library/Developer/XCTestDevices  (xctest-clean.js).
#   2. Leaked Xcode DerivedData dirs left in /private/tmp by agent test builds
#      (tmp-derived-clean.js) — the recurring weekly-fill-up leak.
#
# Both reapers are concurrency-safe: they only remove idle artifacts not in use
# by a live build/clone (in ANY project), so cleanup in one project never
# disturbs another's in-flight test run. This is the backstop that bounds disk
# usage even for tests launched outside the dashboard (Xcode, a terminal, CI).
#
# Usage:
#   scripts/install-xctest-sweep.sh            # install (15-min interval)
#   scripts/install-xctest-sweep.sh --uninstall
#
set -euo pipefail

LABEL="com.build-studio.xctest-clean"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/xctest-clean.log"
GUARD_MINUTES=15       # skip clones modified within this window (active-run safety)
DD_GUARD_MINUTES=180   # skip DerivedData dirs built within this window (a WF run may
                       # reuse its dir across steps; 3h means only abandoned dirs go)
INTERVAL_SECONDS=900   # how often the sweep runs

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLEAN_SCRIPT="$REPO_ROOT/packages/project-server/lib/xctest-clean.js"
DERIVED_SCRIPT="$REPO_ROOT/packages/project-server/lib/tmp-derived-clean.js"
NODE_BIN="$(command -v node)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed LaunchAgent $LABEL"
  exit 0
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi
if [[ ! -f "$CLEAN_SCRIPT" ]]; then
  echo "error: reaper script not found at $CLEAN_SCRIPT" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# The sh wrapper exits 0 silently if the script is missing (e.g. the external
# project volume is unmounted), so launchd never logs a recurring failure.
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>[ -f "$CLEAN_SCRIPT" ] &amp;&amp; "$NODE_BIN" "$CLEAN_SCRIPT" --quiet --guard-minutes $GUARD_MINUTES; [ -f "$DERIVED_SCRIPT" ] &amp;&amp; "$NODE_BIN" "$DERIVED_SCRIPT" --quiet --guard-minutes $DD_GUARD_MINUTES; exit 0</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StartInterval</key>
    <integer>$INTERVAL_SECONDS</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
    <key>ProcessType</key>
    <string>Background</string>
    <key>LowPriorityIO</key>
    <true/>
</dict>
</plist>
PLISTEOF

# Reload idempotently.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "Installed LaunchAgent $LABEL"
echo "  clone reaper:       $NODE_BIN $CLEAN_SCRIPT --quiet --guard-minutes $GUARD_MINUTES"
echo "  DerivedData reaper: $NODE_BIN $DERIVED_SCRIPT --quiet --guard-minutes $DD_GUARD_MINUTES"
echo "  interval:           every ${INTERVAL_SECONDS}s (+ at load)"
echo "  log:                $LOG"
echo "  plist:              $PLIST"
