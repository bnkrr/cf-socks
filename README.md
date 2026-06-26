<div align="center">

# cf-socks

Expose Cloudflare Workers' outbound TCP `connect()` capability to local clients.

[![CI](https://github.com/bnkrr/cf-socks/actions/workflows/ci.yml/badge.svg)](https://github.com/bnkrr/cf-socks/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/bnkrr/cf-socks)](https://github.com/bnkrr/cf-socks/releases)
[![Go](https://img.shields.io/badge/go-1.24%2B-00ADD8)](https://go.dev/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020)](https://workers.cloudflare.com/)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

```text
application -> local SOCKS5 agent -> WSS Dial -> Cloudflare Worker -> TCP target
```

It currently provides a local SOCKS5 endpoint because most applications already support SOCKS proxies. It also exposes a Go SDK with WSS `Dial` for interactive TCP and H2 `Do` for bounded payload exchanges.

## How It Works

Cloudflare Workers can create outbound TCP connections, but they cannot listen for inbound raw TCP. `cf-socks` keeps the SOCKS5 server on your machine and uses the Worker as a remote TCP dialer.

For each proxied TCP connection:

1. The application connects to the local SOCKS5 agent.
2. The agent opens a secure WebSocket to the Worker with an encrypted bearer token.
3. The Worker authenticates before accepting the WebSocket upgrade.
4. The Worker connects to the requested target host and port.
5. The agent and Worker relay bytes in both directions.

HTTPS is handled by the original client inside the SOCKS tunnel. The Worker does not terminate or inspect target TLS traffic.

For custom clients, `Client.Do` uses HTTP/2 for bounded payloads:

```text
payload -> H2 POST -> Cloudflare Worker -> TCP target -> response body
```

H2 mode is useful for many short client-first exchanges, but it is not a `net.Conn` transport. A single H2 request stream is not a reliable open-ended full-duplex TCP tunnel, so interactive connections use WSS.

## Requirements

- Go, to build and run the local agent.
- A Cloudflare account for the Worker.
- Node.js and npm only if you want to deploy with Wrangler instead of copying the Worker in the Cloudflare dashboard.

Install project dependencies:

```bash
go mod download
```

## Deploy The Worker

Generate a shared secret:

```bash
export CF_SOCKS_AUTH_SECRET="$(openssl rand -hex 32)"
```

### Option A: Cloudflare Dashboard

Create a Worker in the Cloudflare dashboard, copy [worker/single-file.js](worker/single-file.js) into the online editor, and set these environment variables:

```text
AUTH_SECRET=<your generated secret>
AUTH_WINDOW_SECONDS=120
```

Deploy the Worker from the dashboard. No local Node.js, npm, or Wrangler setup is required for this path.

The dashboard file is generated from the same Worker source used by Wrangler. Do not edit it by hand. To regenerate it after changing Worker source code:

```bash
npm install
npm run worker:bundle-dashboard
```

CI checks that [worker/single-file.js](worker/single-file.js) stays in sync with `worker/src/`.

### Option B: Wrangler

Install Node dependencies:

```bash
npm install
```

For a quick temporary deployment:

```bash
npx wrangler deploy --temporary \
  --var "AUTH_SECRET:$CF_SOCKS_AUTH_SECRET" \
  --var "AUTH_WINDOW_SECONDS:120"
```

For a persistent deployment, configure the same values in your Cloudflare Worker environment and deploy:

```bash
npx wrangler deploy
```

Use the Worker base URL as the endpoint:

```text
https://<your-worker-host>
```

## Run The Agent

Run the local SOCKS5 agent from source:

```bash
go run ./cmd/cf-socks-agent \
  -listen 127.0.0.1:1080 \
  -worker-url https://<your-worker-host> \
  -auth-secret "$CF_SOCKS_AUTH_SECRET"
```

Or build a local binary:

```bash
go build -o cf-socks-agent ./cmd/cf-socks-agent
./cf-socks-agent \
  -listen 127.0.0.1:1080 \
  -worker-url https://<your-worker-host> \
  -auth-secret "$CF_SOCKS_AUTH_SECRET"
```

Then configure applications to use:

```text
socks5h://127.0.0.1:1080
```

The agent closes idle proxied connections after 5 minutes by default. Use `-idle-timeout -1` to disable the idle timeout.

## Verify

Test HTTP through the proxy:

```bash
curl --socks5-hostname 127.0.0.1:1080 http://httpforever.com/
```

Test HTTPS through the proxy:

```bash
curl --socks5-hostname 127.0.0.1:1080 https://www.google.com/
```

Check the observed outbound IP through the proxy:

```bash
curl --socks5-hostname 127.0.0.1:1080 https://ifconfig.me/ip
```

## Go SDK

Import the Go client SDK from `github.com/bnkrr/cf-socks/sdk/go`.

Use WSS `Dial` when you need an interactive TCP stream:

```go
import cfsocks "github.com/bnkrr/cf-socks/sdk/go"

client := cfsocks.Client{
    Endpoint:  "https://<your-worker-host>",
    Secret:    os.Getenv("CF_SOCKS_AUTH_SECRET"),
    Transport: cfsocks.TransportWSS,
}
conn, err := client.Dial(ctx, "tcp", "httpforever.com:80")
```

Use H2 `Do` when you have a bounded payload:

```go
import cfsocks "github.com/bnkrr/cf-socks/sdk/go"

client := cfsocks.Client{
    Endpoint:  "https://<your-worker-host>",
    Secret:    os.Getenv("CF_SOCKS_AUTH_SECRET"),
    Transport: cfsocks.TransportH2,
}
resp, err := client.Do(ctx, "tcp", "httpforever.com:80", strings.NewReader(
    "GET / HTTP/1.1\r\nHost: httpforever.com\r\nConnection: close\r\n\r\n",
))
```

`Do(ctx, "tcp", "github.com:22", nil)` sends an empty payload and can read server-first banners such as SSH. It is still not an interactive connection.

WSS `Dial` returns a `net.Conn`. Read deadlines are recoverable local wait timeouts. Write deadlines are checked before a WebSocket message write begins; once a write has started, use `Close()` to abandon the connection. Closing WSS also closes the Worker-side target TCP connection, so the same TCP session cannot be resumed by reconnecting.

## Security

The Worker is not an open proxy. Clients authenticate with an encrypted bearer token derived from `AUTH_SECRET` before the Worker opens any outbound TCP connection.

Do not commit real secrets. Use Wrangler secrets, Cloudflare environment variables, or local shell environment variables.

## Limitations

- Worker outbound TCP cannot connect to Cloudflare IP ranges.
- SOCKS5 UDP ASSOCIATE and BIND are not implemented.
- Each proxied TCP connection uses one WebSocket to the Worker.
- H2 mode is bounded-payload only; it is not a SOCKS or `net.Conn` transport.

## Related Projects

These projects overlap with parts of `cf-socks`, but use different product boundaries or data paths.

| Project | Similarity | Difference |
| --- | --- | --- |
| [serverless-proxy](https://github.com/serverless-proxy/serverless-proxy) | Worker dials TCP targets. | Custom WebSocket/HTTP2 entrypoint, not local SOCKS5. |
| [ClassicUO gate](https://github.com/ClassicUO/gate) | Worker bridges WebSocket to TCP. | Fixed game-server target, not a general dialer. |
| [zizifn/edgetunnel](https://github.com/zizifn/edgetunnel) | Worker dials TCP targets. | VLESS-oriented proxy stack. |
| [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) | Worker dials TCP targets. | Broader edge proxy configuration ecosystem. |
| [EDtunnel](https://github.com/6Kmfi6HP/EDtunnel) | Worker dials TCP targets. | Multi-protocol VLESS/Trojan/SOCKS-style proxy node. |
| [linksocks](https://github.com/linksocks/linksocks) | SOCKS-over-WebSocket tunnel platform. | Worker mode is connector/provider relay oriented. |
| [linksocks.js](https://github.com/linksocks/linksocks.js) | Runs on Cloudflare Workers. | Relays connector and provider peers instead of dialing targets directly. |
| [socksflareprox](https://github.com/quippy-dev/socksflareprox) | Local SOCKS with Cloudflare in the path. | Uses Worker HTTP endpoints and a Python client. |
| [cf-fetch-socks](https://github.com/oxcl/cf-fetch-socks) | Combines Workers and SOCKS concepts. | Worker uses an upstream SOCKS proxy; traffic direction is opposite. |
