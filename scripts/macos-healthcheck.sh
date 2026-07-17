#!/bin/bash
# Restart discord-linear-bot via PM2 if it is not online.
# Used by the macOS LaunchAgent health check (after sleep / network blips).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="discord-linear-bot"
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

cd "$ROOT"

if ! command -v npx >/dev/null 2>&1; then
  echo "[healthcheck] npx not found"
  exit 0
fi

PM2_JSON="$(npx pm2 jlist 2>/dev/null || echo '[]')"
STATUS="$(node -e "
  const list = JSON.parse(process.argv[1] || '[]');
  const app = list.find((a) => a.name === process.argv[2]);
  if (!app) { console.log('missing'); process.exit(0); }
  console.log(app.pm2_env?.status || 'unknown');
" "$PM2_JSON" "$APP")"

if [ "$STATUS" = "online" ]; then
  exit 0
fi

echo "[healthcheck] $APP status=$STATUS — restarting $(date -Iseconds)"
if npx pm2 describe "$APP" >/dev/null 2>&1; then
  npx pm2 restart "$APP" --update-env
else
  npx pm2 start "$ROOT/ecosystem.config.cjs" --update-env
fi
npx pm2 save >/dev/null 2>&1 || true
