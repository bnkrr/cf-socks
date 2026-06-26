#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi

secret="$(openssl rand -hex 32)"
printf '%s' "$secret" > /tmp/cf-socks-e2e-secret

log=/tmp/cf-socks-deploy.log
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/tmp/cf-socks-config}" \
npm_config_cache="${npm_config_cache:-/tmp/cf-socks-npm-cache}" \
npx wrangler deploy --temporary \
  --var "AUTH_SECRET:$secret" \
  --var "AUTH_WINDOW_SECONDS:${AUTH_WINDOW_SECONDS:-120}" 2>&1 | tee "$log"

url="$(sed -n 's#.*https://#https://#p' "$log" | grep -E '^https://[^[:space:]]+\.workers\.dev$' | tail -n 1 | tr -d '[:space:]')"
if [ -n "$url" ]; then
  echo "E2E_WORKER_URL=$url"
fi
echo "E2E_AUTH_SECRET_FILE=/tmp/cf-socks-e2e-secret"
