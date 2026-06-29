# Benchmarks

This page records reproducible benchmark commands and the current directional
results for `cf-socks`. Treat the numbers as path-specific: Cloudflare edge
placement, the target service, account limits, and local network conditions all
matter.

## Tool

Build the benchmark CLI:

```bash
go build -o .local/bin/cfsbench ./cmd/cfsbench
```

The CLI supports four modes:

- `wss-dial`: SDK `Client.Dial` over WSS.
- `socks-wss`: local SOCKS5 agent over WSS.
- `h2-do`: SDK `Do` over HTTP/2.
- `h3-do`: SDK `Do` over HTTP/3.

Common payloads:

- `http`: raw HTTP/1.1 GET, validates the status line.
- `dns`: DNS-over-TCP root `NS` query, validates the DNS response.
- `banner`: nil payload, reads one server-first line.
- `echo`: fixed echo payload.
- `none`: connect/request then close without reading target data.

`-target` accepts a comma-separated target pool. Requests are distributed in
round-robin order.

## DNS-over-TCP Example

DNS-over-TCP is useful for bounded short-request benchmarking because payloads
are small, structured, and easy to validate.

```bash
.local/bin/cfsbench \
  -mode h3-do \
  -endpoint "$CF_SOCKS_WORKER_URL" \
  -secret "$CF_SOCKS_AUTH_SECRET" \
  -target '8.8.8.8:53,8.8.4.4:53,9.9.9.9:53,149.112.112.112:53' \
  -payload dns \
  -requests 1000 \
  -concurrency 100 \
  -pool-size 4
```

`-pool-size 0` is the default and uses a single client. Set `-pool-size` above
zero to enable pooled H2/H3 `Do` with that many independent transport slots.

Use conservative settings for public resolvers. For sustained tests, use targets
you control.

## Current Directional Results

Environment:

- Date: 2026-06-26
- Worker endpoint: temporary Workers deployment
- Payload: DNS-over-TCP root `NS`
- Target pool: public DNS resolvers over TCP/53

Single H3 transport, 16 resolver targets:

| Mode | Targets | Requests | Concurrency | Success | Failed | Rate | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| h3-do | 16 | 1000 | 100 | 1000 | 0 | 130.08/s | 646.5ms | 1351.3ms |
| h3-do | 16 | 1000 | 200 | 1000 | 0 | 131.71/s | 1328.7ms | 1769.1ms |

WSS direct over the same resolver pool:

| Mode | Targets | Requests | Concurrency | Success | Failed | Rate | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| wss-dial | 16 | 500 | 50 | 500 | 0 | 32.73/s | 1410.3ms | 2038.3ms |
| wss-dial | 16 | 1000 | 100 | 1000 | 0 | 67.24/s | 1340.2ms | 2001.8ms |
| wss-dial | 16 | 1000 | 200 | 989 | 11 | 121.71/s | 1431.8ms | 1934.7ms |

Observed with multiple independent H3 transports:

- Two concurrent H3 benchmark processes reached about 218 req/s combined with no failures.
- Four concurrent H3 benchmark processes reached about 370-390 req/s combined with no failures.

## Interpretation

WSS scales by opening many independent WebSocket connections. That is required
for interactive TCP, but each short operation pays a full WSS setup cost.

H2/H3 `Do` is better for bounded short exchanges because it reuses the
client-to-Cloudflare HTTP transport. A single H3 transport showed a clear
per-connection plateau in these tests; multiple independent H3 transports raised
throughput. Use `ClientPool` for H2 and `sdk/go/h3.Pool` for H3 when high
bounded-request throughput matters.
