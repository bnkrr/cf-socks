#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=tests/e2e/env.sh
. "$ROOT/tests/e2e/env.sh"

case_name="${1:-all}"

if [ -z "${E2E_WORKER_URL:-}" ] || [ -z "${E2E_DIRECT_BEARER:-}" ]; then
  echo "E2E_WORKER_URL and E2E_DIRECT_BEARER are required for Direct E2E" >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for Direct E2E" >&2
  exit 2
fi

target_value() {
  key="$1"
  fallback="$2"
  value="${!key:-}"
  if [ -z "$value" ]; then
    value="$fallback"
  fi
  printf '%s' "$value"
}

target_host() {
  value="$1"
  host="${value%:*}"
  host="${host#[}"
  host="${host%]}"
  printf '%s' "$host"
}

target_port() {
  value="$1"
  printf '%s' "${value##*:}"
}

url_encode_path_segment() {
  input="$1"
  output=""
  LC_ALL=C
  for ((i = 0; i < ${#input}; i += 1)); do
    char="${input:i:1}"
    case "$char" in
      [a-zA-Z0-9.~_-])
        output+="$char"
        ;;
      :)
        output+="$char"
        ;;
      *)
        printf -v encoded '%%%02X' "'$char"
        output+="$encoded"
        ;;
    esac
  done
  printf '%s' "$output"
}

direct_url() {
  host="$1"
  port="$2"
  encoded_host="$(url_encode_path_segment "$host")"
  printf '%s/direct/%s/%s' "${E2E_WORKER_URL%/}" "$encoded_host" "$port"
}

require_h3() {
  if [[ "$E2E_WORKER_URL" != https://* ]]; then
    echo "skip $case_name: HTTP/3 Direct E2E requires https:// E2E_WORKER_URL"
    exit 0
  fi
  if ! curl --version | grep -q 'HTTP3'; then
    echo "skip $case_name: curl does not support HTTP/3"
    exit 0
  fi
}

case_http() {
  target="$(target_value E2E_HTTP_TARGET httpforever.com:80)"
  host="$(target_host "$target")"
  port="$(target_port "$target")"
  curl_args=()
  if [[ "$E2E_WORKER_URL" == https://* ]]; then
    curl_args+=(--http2)
  fi
  out="$(
    printf 'GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n' "$host" \
      | curl "${curl_args[@]}" --fail --silent --show-error --no-buffer \
      -X POST \
      -H "Authorization: Bearer $E2E_DIRECT_BEARER" \
      --data-binary @- \
      "$(direct_url "$host" "$port")"
  )"
  first_line="$(printf '%s' "$out" | sed -n '1p')"
  case "$first_line" in
    HTTP/*) ;;
    *) echo "unexpected Direct HTTP status line: $first_line" >&2; return 1 ;;
  esac
}

case_ssh() {
  target="$(target_value E2E_TCP_BANNER_TARGET github.com:22)"
  host="$(target_host "$target")"
  port="$(target_port "$target")"
  curl_args=()
  if [[ "$E2E_WORKER_URL" == https://* ]]; then
    curl_args+=(--http2)
  fi
  out="$(
    curl "${curl_args[@]}" --silent --show-error --no-buffer --max-time 10 \
      -X POST \
      -H "Authorization: Bearer $E2E_DIRECT_BEARER" \
      "$(direct_url "$host" "$port")" 2>&1 || true
  )"
  if ! printf '%s' "$out" | grep -q 'SSH-'; then
    echo "Direct SSH banner did not contain SSH-:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
}

case_h3_http() {
  require_h3
  target="$(target_value E2E_HTTP_TARGET httpforever.com:80)"
  host="$(target_host "$target")"
  port="$(target_port "$target")"
  out="$(
    printf 'GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n' "$host" \
      | curl --http3 --fail --silent --show-error --no-buffer \
      -X POST \
      -H "Authorization: Bearer $E2E_DIRECT_BEARER" \
      --data-binary @- \
      "$(direct_url "$host" "$port")"
  )"
  first_line="$(printf '%s' "$out" | sed -n '1p')"
  case "$first_line" in
    HTTP/*) ;;
    *) echo "unexpected Direct H3 HTTP status line: $first_line" >&2; return 1 ;;
  esac
}

case_h3_ssh() {
  require_h3
  target="$(target_value E2E_TCP_BANNER_TARGET github.com:22)"
  host="$(target_host "$target")"
  port="$(target_port "$target")"
  out="$(
    curl --http3 --silent --show-error --no-buffer --max-time 10 \
      -X POST \
      -H "Authorization: Bearer $E2E_DIRECT_BEARER" \
      "$(direct_url "$host" "$port")" 2>&1 || true
  )"
  if ! printf '%s' "$out" | grep -q 'SSH-'; then
    echo "Direct H3 SSH banner did not contain SSH-:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
}

run_case() {
  name="$1"
  echo "=== direct $name"
  case "$name" in
    http) case_http ;;
    ssh) case_ssh ;;
    h3-http) case_h3_http ;;
    h3-ssh) case_h3_ssh ;;
    *) echo "unknown Direct E2E case: $name" >&2; exit 2 ;;
  esac
}

if [ "$case_name" = "all" ]; then
  run_case http
  run_case ssh
  run_case h3-http
  run_case h3-ssh
else
  run_case "$case_name"
fi
