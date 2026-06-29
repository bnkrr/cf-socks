#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=tests/e2e/env.sh
. "$ROOT/tests/e2e/env.sh"
cd "$ROOT"

if [ -z "${E2E_WORKER_URL:-}" ] || [ -z "${E2E_AUTH_SECRET:-}" ]; then
  echo "E2E_WORKER_URL and E2E_AUTH_SECRET are required" >&2
  exit 2
fi

GOPATH="${GOPATH:-/tmp/cf-socks-go}" \
GOMODCACHE="${GOMODCACHE:-/tmp/cf-socks-go-mod-cache}" \
GOCACHE="${GOCACHE:-/tmp/cf-socks-go-build-cache}" \
go test ./tests/e2e/go -v -count=1 "$@"

"$ROOT/tests/e2e/direct/run.sh" all
