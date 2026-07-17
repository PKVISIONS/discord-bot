#!/bin/bash
# One-time macOS setup: PM2 daemon + auto-start on login + health check after sleep.
#
# Usage: ./scripts/setup-macos-daemon.sh
# Then run the sudo command it prints (PM2 launchd startup).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(whoami)"
HOME_DIR="$HOME"
PLIST_LABEL="com.emblem.discord-bot.healthcheck"
PLIST_PATH="$HOME_DIR/Library/LaunchAgents/${PLIST_LABEL}.plist"
HEALTHCHECK="$ROOT/scripts/macos-healthcheck.sh"
LOG_DIR="$ROOT/logs"
INTERVAL="${DAEMON_HEALTHCHECK_INTERVAL_SEC:-120}"

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

echo "== Emblem Discord bot — macOS always-on setup =="
echo "Project: $ROOT"
echo ""

chmod +x "$HEALTHCHECK"

mkdir -p "$LOG_DIR"

echo "→ Starting bot with PM2…"
cd "$ROOT"
npm run daemon:start
npm run daemon:save

echo ""
echo "→ Installing health-check LaunchAgent (every ${INTERVAL}s)…"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${HEALTHCHECK}</string>
  </array>
  <key>StartInterval</key>
  <integer>${INTERVAL}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/healthcheck.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/healthcheck.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/${PLIST_LABEL}"
launchctl kickstart -k "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true

echo "   Installed: $PLIST_PATH"

echo ""
echo "→ Optional: faster recovery after sleep (recommended)"
if command -v brew >/dev/null 2>&1; then
  if ! command -v sleepwatcher >/dev/null 2>&1; then
    echo "   Install sleepwatcher: brew install sleepwatcher"
  else
    WAKE_HOOK="$HOME_DIR/.emblem-discord-bot-wakeup"
    cat > "$WAKE_HOOK" <<WAKEEOF
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
"$HEALTHCHECK"
WAKEEOF
    chmod +x "$WAKE_HOOK"
    ln -sf "$WAKE_HOOK" "$HOME_DIR/.wakeup" 2>/dev/null || cp "$WAKE_HOOK" "$HOME_DIR/.wakeup"
    chmod +x "$HOME_DIR/.wakeup"
    echo "   sleepwatcher wake hook: ~/.wakeup"
    brew services start sleepwatcher 2>/dev/null || echo "   Run: brew services start sleepwatcher"
  fi
else
  echo "   (Install Homebrew + sleepwatcher for instant wake recovery)"
fi

echo ""
echo "=============================================="
echo "IMPORTANT — run this ONCE with sudo (Mac boot):"
echo ""
npx pm2 startup launchd -u "$USER_NAME" --hp "$HOME_DIR" 2>/dev/null | grep -E '^sudo' || \
  npx pm2 startup launchd -u "$USER_NAME" --hp "$HOME_DIR"
echo ""
echo "Then run:  npm run daemon:save"
echo "=============================================="
echo ""
echo "Done. Bot stays online unless the Mac sleeps or reboots."
echo "  npm run daemon:status  — check bot"
echo "  npm run daemon:logs    — view logs"
echo "  logs/healthcheck.log   — auto-recovery log"
