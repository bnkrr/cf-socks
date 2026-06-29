# Protocol Model

This document describes the wire model between cf-socks clients and the
Cloudflare Worker. It is not tied to the Go SDK. Other client implementations
should be able to follow this model.

## Overview

cf-socks exposes Cloudflare Workers' outbound TCP `connect()` capability to a
client:

```text
client or local agent -> HTTPS/WSS Worker endpoint -> Worker connect() -> TCP target
```

There are two transport shapes:

- **WSS Dial**: interactive TCP. One client TCP session maps to one WebSocket and
  one Worker-side TCP socket.
- **H2/H3 Do**: bounded payload exchange. One HTTP request body is copied to one
  Worker-side TCP socket, and the target readable stream is returned as the HTTP
  response body.
- **Direct HTTP payload**: curl-friendly bounded payload exchange. Target host
  and port are read from the URL and a static bearer token authorizes access.

The split exists because the Cloudflare Workers inbound implementations for
WebSocket and HTTP requests expose different stream semantics to Worker code.
WebSocket upgrade gives the Worker an open-ended bidirectional channel that can
represent an interactive TCP session. The Workers HTTP request path, even when
the client uses HTTP/2 or HTTP/3, is exposed to Worker code as one request body
and one response body. In testing, response headers/body did not reliably reach
the client while the inbound request body remained open, so this project treats
H2/H3 as a bounded request/response transport rather than an open-ended
full-duplex TCP tunnel.

## Endpoints

### `GET /wss`

Creates an interactive TCP tunnel.

- Requires a WebSocket upgrade.
- Requires token claim `op = "dial"`.
- Target `host` and `port` are read from encrypted token claims.
- On target connection success, Worker sends text `OK\n`.
- After `OK\n`, binary WebSocket messages are raw TCP bytes.
- Text messages after setup are protocol errors.

### `POST /h2`

Creates one bounded payload exchange over HTTP/2.

- Requires token claim `op = "payload"`.
- Target `host` and `port` are read from encrypted token claims.
- Request body bytes are copied to target writable.
- Target readable bytes are streamed as response body.
- Optional encrypted claim `write_close_after_ms` closes the target writable
  side after request-body EOF and the configured delay. Valid range is
  `0..600000` milliseconds.

### `POST /h3`

Same protocol model as `/h2`, but the client expects HTTP/3 transport.

The Worker route is intentionally the same implementation shape as `/h2`; the
client-selected HTTP version is a transport property, not a different TCP relay
protocol.

### `POST /direct/:host/:port`

Creates one bounded payload exchange over the client's selected HTTP transport.

- Requires `DIRECT_BEARER` to be configured on the Worker.
- Requires `Authorization: Bearer <DIRECT_BEARER>`.
- Target `host` and `port` are read from the URL path.
- Request body bytes are copied to target writable.
- Target readable bytes are streamed as response body.
- Optional query `write_close_after=0|none|<N>ms|<N>s|<N>m` closes the target
  writable side after request-body EOF and the configured delay. `none` is the
  same as omitting the query. Maximum delay is `600s`/`10m`; use the default
  disabled behavior for longer-lived responses.
- This endpoint is not used by the Go SDK or local SOCKS agent.

### `GET /__meta`

Returns authenticated Worker metadata for smoke tests and deployment checks.

- Requires `DIRECT_BEARER` to be configured on the Worker.
- Requires `Authorization: Bearer <DIRECT_BEARER>`.
- Does not open any target TCP connection.
- Returns empty `404` on missing or invalid auth.

Example response:

```json
{
  "name": "cf-socks",
  "version": "0.5.0",
  "protocol": 2,
  "capabilities": ["wss", "h2", "h3", "direct", "write_close_after"]
}
```

## Authentication Token

Clients authenticate with:

```http
Authorization: Bearer <base64url(binary-token)>
```

Binary token:

```text
version(0x02) || aes_gcm_nonce(12 bytes) || ciphertext_and_tag
```

The nonce is public. It is not a secret field and does not hide target metadata
by itself. It has two jobs:

- it is the AES-GCM IV required to decrypt the ciphertext; and
- after successful decrypt, it is reused as the replay-cache key.

The nonce is outside the ciphertext because AES-GCM needs it before decryption
can start.

Plaintext claims:

```json
{
  "op": "dial",
  "host": "example.com",
  "port": 443,
  "ts": 1234567890,
  "write_close_after_ms": 200
}
```

Currently, `op` is `"dial"` for `/wss` and `"payload"` for `/h2` and `/h3`.
`write_close_after_ms` is optional and only meaningful for payload exchanges.
The field must be absent to disable write close; if present, it must be an
integer in `0..600000`.

Key derivation:

```text
SHA-256("cf-socks auth v2\n" + AUTH_SECRET)
```

AEAD additional authenticated data:

```text
METHOD + "\n" + PATH
```

Examples:

```text
GET\n/wss
POST\n/h2
POST\n/h3
```

Binding method and path into AAD prevents a valid token for one endpoint from
being replayed against another endpoint. The AES-GCM nonce must be random per
token under the same key.

The Worker rejects missing, malformed, expired, replayed, wrong-op, or
wrong-path tokens before opening any outbound TCP connection.

Verification order:

1. Parse `Authorization: Bearer ...`.
2. Base64url-decode the binary token.
3. Check version `0x02` and split out the 12-byte AES-GCM nonce.
4. Derive the AES-GCM key from `AUTH_SECRET`.
5. Decrypt `ciphertext_and_tag` with nonce and AAD `METHOD + "\n" + PATH`.
6. Parse JSON claims and validate `op`, `host`, `port`, and `ts`.
7. Check the timestamp window.
8. Consume the nonce in the Worker-local replay cache.

The replay cache is deliberately checked after successful decrypt. This avoids
storing arbitrary unauthenticated bytes from invalid requests and makes the
cache key correspond to a token that was valid under the configured secret.

## Direct Bearer

The Direct endpoint uses a separate static bearer:

```http
Authorization: Bearer <DIRECT_BEARER>
```

This is intentionally simpler than the encrypted SDK token so tools like `curl`
can verify the Worker without installing a client. It is a long-lived API key:
anyone who has it can use `/direct/:host/:port` until the Worker environment
variable is changed or removed.

## Worker TCP Binding

The Worker always authenticates first, then opens a target TCP socket with
Cloudflare's `connect()` API.

### WSS Binding

Conceptually:

```ts
const pair = new WebSocketPair();
server.accept();
socket = connect({ hostname: claims.host, port: claims.port });
await socket.opened;
server.send("OK\n");

// WebSocket binary messages -> socket.writable
// socket.readable -> WebSocket binary messages
```

The WebSocket is the client-facing bidirectional channel. The Worker serializes
incoming WebSocket binary messages into the target socket writer, and sends
target readable chunks back as binary WebSocket messages.

Closing either side closes both sides. Reconnecting creates a new Worker request
and a new target TCP socket; it cannot resume the previous target connection.

### H2/H3 Binding

Conceptually:

```ts
socket = connect(
  { hostname: claims.host, port: claims.port },
  { secureTransport: "off", allowHalfOpen: true },
);
await socket.opened;

ctx.waitUntil(copy(request.body, socket.writable, route.payloadOptions));
return new Response(socket.readable);
```

The request body is the only client-to-target byte source. The response body is
the target-to-client byte stream.

The limitation is not that HTTP/2 or HTTP/3 cannot multiplex streams in general.
The limitation is the Cloudflare Workers inbound request abstraction available to
Worker code: one inbound HTTP request maps to one request body stream and one
response body stream, and this path did not behave like a reliable
simultaneously-open, full-duplex TCP socket in our Workers tests. A WebSocket
upgrade exposes a different Worker API and did behave like the needed
bidirectional channel.

By default, the Worker does not close `socket.writable` after the request body
is consumed, because immediate writable close can terminate the readable
response path in practice and break response streaming. For one-shot exchanges,
the client may request `write_close_after_ms` so the Worker waits for that delay
after request-body EOF and then closes the target writable side while continuing
to stream `socket.readable`.

This is why H2/H3 is modeled as `Do`, not `Dial`: it is good for bounded payloads
and server-first reads, but it is not a general interactive TCP connection.

## Failure Behavior

- Unknown path: empty `404`.
- Invalid auth, expired token, replayed nonce, wrong op, wrong method/path:
  empty `404`.
- `/direct/:host/:port` when `DIRECT_BEARER` is missing, wrong, or target is
  malformed: empty `404`.
- `/wss` without WebSocket upgrade after valid auth: `426`.
- `/wss` target connect failure after upgrade: text `ERR connect_failed\n`, then
  WebSocket close `1011`.
- `/h2` or `/h3` target connect failure: empty `502`.
- `/h2` or `/h3` success: `200` with `content-type:
  application/octet-stream` and `cache-control: no-store`.

## Security Properties

- Target `host` and `port` are encrypted in the bearer token. They are not
  placed in the URL or readable headers.
- Direct endpoint targets are intentionally placed in the URL for curl
  usability. Use the encrypted SDK endpoints when target metadata should not be
  visible in paths or logs.
- Worker TLS is provided by HTTPS/WSS/H3 and must be verified by clients.
- The target TCP connection is raw TCP. cf-socks does not validate or terminate
  target TLS; applications can run TLS inside the TCP stream if they need it.
- Replay protection is intentionally simple and local to a Worker isolate's
  nonce cache. It reduces accidental or opportunistic replay within the token
  time window, but it is not a distributed session system.

## Compatibility

The current token version is `0x02`. The old first-frame WSS auth model is not
supported.

Future protocol changes should add a new token version or endpoint behavior
without changing the meaning of existing version `0x02` tokens.
