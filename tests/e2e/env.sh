#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ROOT
export PATH="$HOME/.local/go/bin:$PATH"

if [ -z "${E2E_AUTH_SECRET:-}" ] && [ -f /tmp/cf-socks-e2e-secret ]; then
  export E2E_AUTH_SECRET="$(cat /tmp/cf-socks-e2e-secret)"
fi

if [ -z "${E2E_DIRECT_BEARER:-}" ] && [ -f /tmp/cf-socks-e2e-direct-bearer ]; then
  export E2E_DIRECT_BEARER="$(cat /tmp/cf-socks-e2e-direct-bearer)"
fi

if [ -z "${E2E_WORKER_URL:-}" ]; then
  log=/tmp/cf-socks-deploy.log
  if [ -f "$log" ]; then
    url="$(sed -n 's#.*https://#https://#p' "$log" | grep -E '^https://[^[:space:]]+\.workers\.dev$' | tail -n 1 | tr -d '[:space:]')"
    if [ -n "$url" ]; then
      export E2E_WORKER_URL="$url"
    fi
  fi
fi
