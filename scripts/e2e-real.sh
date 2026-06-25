#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.local/go/bin:$PATH"

if [ -z "${E2E_AUTH_SECRET:-}" ] && [ -f /tmp/cf-socks-e2e-secret ]; then
  export E2E_AUTH_SECRET="$(cat /tmp/cf-socks-e2e-secret)"
fi

if [ -z "${E2E_WORKER_URL:-}" ]; then
  log=/tmp/cf-socks-deploy.log
  if [ -f "$log" ]; then
    url="$(sed -n 's#.*https://#https://#p' "$log" | tail -n 1 | tr -d '[:space:]')"
    if [ -n "$url" ]; then
      export E2E_WORKER_URL="${url/https:/wss:}/tcp"
    fi
  fi
fi

if [ -z "${E2E_WORKER_URL:-}" ] || [ -z "${E2E_AUTH_SECRET:-}" ]; then
  echo "E2E_WORKER_URL and E2E_AUTH_SECRET are required" >&2
  exit 2
fi

GOPATH="${GOPATH:-/tmp/cf-socks-go}" \
GOMODCACHE="${GOMODCACHE:-/tmp/cf-socks-go-mod-cache}" \
GOCACHE="${GOCACHE:-/tmp/cf-socks-go-build-cache}" \
go test ./tests/e2e -v -count=1 "$@"
