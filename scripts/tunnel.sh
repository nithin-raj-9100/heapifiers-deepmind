#!/usr/bin/env bash
# Expose the local Parley server on a public HTTPS URL for a quick demo (no account needed).
# Prefers a Cloudflare quick tunnel (no interstitial page, WebSockets work); falls back to localtunnel.
#   npm start &
#   scripts/tunnel.sh
set -euo pipefail
PORT="${PORT:-8080}"
if command -v cloudflared >/dev/null 2>&1; then
  exec cloudflared tunnel --url "http://localhost:${PORT}"
fi
echo "cloudflared not found. For a steadier tunnel: brew install cloudflared (macOS) or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
echo "Falling back to localtunnel; visitors must click through its confirmation page once."
exec npx --yes localtunnel --port "${PORT}"
