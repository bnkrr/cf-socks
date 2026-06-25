# cf-socks

`cf-socks` runs a local SOCKS5 proxy backed by a Cloudflare Worker.

```text
application -> local SOCKS5 agent -> WSS -> Cloudflare Worker -> TCP target
```

Use it when you want applications to connect through a local SOCKS5 endpoint while the outbound TCP connection is made from a Cloudflare Worker.

## How It Works

Cloudflare Workers can create outbound TCP connections, but they cannot listen for inbound raw TCP. `cf-socks` keeps the SOCKS5 server on your machine and uses the Worker as a remote TCP dialer.

For each proxied TCP connection:

1. The application connects to the local SOCKS5 agent.
2. The agent opens a secure WebSocket to the Worker.
3. The Worker authenticates the agent.
4. The Worker connects to the requested target host and port.
5. The agent and Worker relay bytes in both directions.

HTTPS is handled by the original client inside the SOCKS tunnel. The Worker does not terminate or inspect target TLS traffic.

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

The Worker WebSocket endpoint is:

```text
wss://<your-worker-host>/tcp
```

## Run The Agent

Run the local SOCKS5 agent from source:

```bash
go run ./cmd/cf-socks-agent \
  -listen 127.0.0.1:1080 \
  -worker-url wss://<your-worker-host>/tcp \
  -auth-secret "$CF_SOCKS_AUTH_SECRET"
```

Or build a local binary:

```bash
go build -o cf-socks-agent ./cmd/cf-socks-agent
./cf-socks-agent \
  -listen 127.0.0.1:1080 \
  -worker-url wss://<your-worker-host>/tcp \
  -auth-secret "$CF_SOCKS_AUTH_SECRET"
```

Then configure applications to use:

```text
socks5h://127.0.0.1:1080
```

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

## Security

The Worker is not an open proxy. The local agent must authenticate with a shared secret before the Worker opens any outbound TCP connection.

Do not commit real secrets. Use Wrangler secrets, Cloudflare environment variables, or local shell environment variables.

## Limitations

- Worker outbound TCP cannot connect to Cloudflare IP ranges.
- SOCKS5 UDP ASSOCIATE and BIND are not implemented.
- Each proxied TCP connection uses one WebSocket to the Worker.
