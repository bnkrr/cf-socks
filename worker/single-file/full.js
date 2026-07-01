// Generated from worker/src/profiles/full.ts (full profile). Do not edit by hand.

// worker/src/egress/fetch.ts
var HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
];
async function runFetchExchange(request, targetUrl) {
  try {
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: targetRequestHeaders(request.headers),
      body: requestBodyForFetch(request),
      redirect: "manual"
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: targetResponseHeaders(response.headers)
    });
  } catch {
    return null;
  }
}
function targetRequestHeaders(headers) {
  const next = new Headers(headers);
  deleteConnectionHeaders(next, headers);
  next.delete("authorization");
  next.delete("host");
  return next;
}
function targetResponseHeaders(headers) {
  const next = new Headers(headers);
  deleteConnectionHeaders(next, headers);
  return next;
}
function deleteConnectionHeaders(target, source) {
  for (const name of connectionHeaderNames(source)) {
    target.delete(name);
  }
  for (const name of HOP_BY_HOP_HEADERS) {
    target.delete(name);
  }
}
function connectionHeaderNames(headers) {
  const value = headers.get("connection");
  if (!value) {
    return [];
  }
  return value.split(",").map((name) => name.trim()).filter(Boolean);
}
function requestBodyForFetch(request) {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  return request.body;
}

// worker/src/token.ts
var VERSION = 2;
var KEY_PREFIX = "cf-socks auth v2\n";
var DEFAULT_WINDOW_SECONDS = 120;
var MAX_WRITE_CLOSE_AFTER_MS = 6e5;
var NonceCache = class {
  constructor(maxEntries = 4096) {
    this.maxEntries = maxEntries;
  }
  maxEntries;
  seen = /* @__PURE__ */ new Map();
  consume(nonce, expiresAt, now) {
    this.cleanup(now);
    if (this.seen.has(nonce)) {
      return false;
    }
    if (this.seen.size >= this.maxEntries) {
      const first = this.seen.keys().next().value;
      if (first !== void 0) {
        this.seen.delete(first);
      }
    }
    this.seen.set(nonce, expiresAt);
    return true;
  }
  cleanup(now) {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(nonce);
      }
    }
  }
};
async function verifyBearerToken(header, options) {
  const encoded = bearerToken(header);
  if (!encoded) {
    return null;
  }
  const raw = base64UrlDecode(encoded);
  if (!raw || raw.byteLength < 1 + 12 + 16 || raw[0] !== VERSION) {
    return null;
  }
  const nonce = raw.slice(1, 13);
  const ciphertext = raw.slice(13);
  let plaintext;
  try {
    const key = await aesKey(options.secret);
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: new TextEncoder().encode(`${options.method}
${options.path}`)
      },
      key,
      toArrayBuffer(ciphertext)
    );
  } catch {
    return null;
  }
  const claims = parseClaims(new TextDecoder().decode(plaintext));
  if (!claims || claims.op !== options.expectedOp) {
    return null;
  }
  const windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1e3);
  if (Math.abs(now - claims.ts) > windowSeconds) {
    return null;
  }
  if (options.nonceCache) {
    const nonceKey = base64UrlEncode(nonce);
    if (!options.nonceCache.consume(nonceKey, claims.ts + windowSeconds, now)) {
      return null;
    }
  }
  return claims;
}
function bearerToken(header) {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) {
    return null;
  }
  const value = header.slice(prefix.length);
  return value.length > 0 ? value : null;
}
function parseClaims(input) {
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value;
  if (candidate.op !== "dial" && candidate.op !== "payload" || typeof candidate.host !== "string" || !isValidHost(candidate.host) || typeof candidate.port !== "number" || !Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535 || typeof candidate.ts !== "number" || !Number.isInteger(candidate.ts)) {
    return null;
  }
  const claims = {
    op: candidate.op,
    host: candidate.host,
    port: candidate.port,
    ts: candidate.ts
  };
  if ("secure_transport" in candidate) {
    if (candidate.secure_transport !== "off" && candidate.secure_transport !== "on") {
      return null;
    }
    claims.secure_transport = candidate.secure_transport;
  }
  if ("write_close_after_ms" in candidate) {
    if (typeof candidate.write_close_after_ms !== "number" || !Number.isInteger(candidate.write_close_after_ms) || candidate.write_close_after_ms < 0 || candidate.write_close_after_ms > MAX_WRITE_CLOSE_AFTER_MS) {
      return null;
    }
    claims.write_close_after_ms = candidate.write_close_after_ms;
  }
  return claims;
}
function isValidHost(host) {
  return host.length > 0 && host.length <= 253 && !host.includes("\n") && !host.includes("\r");
}
async function aesKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(KEY_PREFIX + secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
}
function base64UrlDecode(value) {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}
function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// worker/src/auth/bearer-claims.ts
var nonceCache = new NonceCache();
async function resolveBearerClaimsRoute(request, env, transport) {
  const url = new URL(request.url);
  const expectedOp = transport === "wss" ? "dial" : "payload";
  if (transport === "wss" && url.pathname !== "/wss") {
    return null;
  }
  if (transport === "payload" && url.pathname !== "/h2" && url.pathname !== "/h3") {
    return null;
  }
  if (transport === "payload" && request.method !== "POST") {
    return null;
  }
  if (!env.AUTH_SECRET) {
    return null;
  }
  const claims = await verifyBearerToken(request.headers.get("Authorization"), {
    secret: env.AUTH_SECRET,
    method: request.method,
    path: url.pathname,
    expectedOp,
    windowSeconds: parseWindowSeconds(env.AUTH_WINDOW_SECONDS),
    nonceCache
  });
  if (!claims) {
    return null;
  }
  return {
    op: claims.op,
    target: { host: claims.host, port: claims.port },
    transport,
    path: url.pathname,
    payloadOptions: optionsFromClaims(transport, claims)
  };
}
function optionsFromClaims(transport, claims) {
  const options = {};
  if (claims.secure_transport !== void 0) {
    options.secureTransport = claims.secure_transport;
  }
  if (transport === "payload" && claims.write_close_after_ms !== void 0) {
    options.writeCloseAfterMs = claims.write_close_after_ms;
  }
  return Object.keys(options).length > 0 ? options : void 0;
}
function parseWindowSeconds(value) {
  if (!value) {
    return 120;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
}

// worker/src/auth/static-bearer.ts
function verifyStaticBearer(header, expected) {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) {
    return false;
  }
  const actual = header.slice(prefix.length);
  return actual.length === expected.length && constantTimeEqual(actual, expected);
}
function constantTimeEqual(a, b) {
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// worker/src/ingress/payload-options.ts
var MAX_WRITE_CLOSE_AFTER_MS2 = 6e5;
function parsePayloadOptions(url) {
  const secureTransport = parseSecureTransport(url.searchParams.get("tls"));
  if (secureTransport === null) {
    return null;
  }
  const value = url.searchParams.get("write_close_after");
  if (value === null || value === "none") {
    return secureTransport ? { secureTransport } : {};
  }
  const ms = parseDurationMs(value);
  if (ms === null) {
    return null;
  }
  return secureTransport ? { secureTransport, writeCloseAfterMs: ms } : { writeCloseAfterMs: ms };
}
function parseSecureTransport(value) {
  if (value === null || value === "" || value === "off") {
    return void 0;
  }
  if (value === "on") {
    return "on";
  }
  return null;
}
function parseDurationMs(value) {
  if (value === "0") {
    return 0;
  }
  const match = /^([1-9][0-9]*)(ms|s|m)$/.exec(value);
  if (!match) {
    return null;
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1e3 : 6e4;
  const ms = amount * multiplier;
  return Number.isSafeInteger(ms) && ms <= MAX_WRITE_CLOSE_AFTER_MS2 ? ms : null;
}

// worker/src/ingress/direct-path.ts
function isDirectPathRequest(request) {
  return new URL(request.url).pathname.startsWith("/direct/");
}
function resolveDirectPathRoute(request, env) {
  const url = new URL(request.url);
  if (request.method !== "POST" || !url.pathname.startsWith("/direct/")) {
    return null;
  }
  if (!env.DIRECT_BEARER || !verifyStaticBearer(request.headers.get("Authorization"), env.DIRECT_BEARER)) {
    return null;
  }
  const target = parseDirectTarget(url.pathname);
  if (!target) {
    return null;
  }
  const payloadOptions = parsePayloadOptions(url);
  if (!payloadOptions) {
    return null;
  }
  return {
    op: "payload",
    target,
    transport: "payload",
    path: url.pathname,
    payloadOptions
  };
}
function parseDirectTarget(pathname) {
  const parts = pathname.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "direct") {
    return null;
  }
  let host;
  try {
    host = decodeURIComponent(parts[2]);
  } catch {
    return null;
  }
  const port = Number.parseInt(parts[3], 10);
  if (!host || host.length > 253 || host.includes("/") || host.includes("\n") || host.includes("\r") || !Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== parts[3]) {
    return null;
  }
  return { host, port };
}

// worker/src/shared/types.ts
var WORKER_META = {
  name: "cf-socks",
  version: "0.7.0",
  protocol: 2,
  capabilities: ["wss", "h2", "h3", "direct", "direct_url", "fetch", "tls", "write_close_after"]
};
function notFound() {
  return new Response(null, { status: 404 });
}

// worker/src/ingress/meta.ts
function isMetaRequest(request) {
  const url = new URL(request.url);
  return request.method === "GET" && url.pathname === "/__meta";
}
function resolveMetaRoute(request, env) {
  if (!isMetaRequest(request)) {
    return null;
  }
  if (!env.DIRECT_BEARER || !verifyStaticBearer(request.headers.get("Authorization"), env.DIRECT_BEARER)) {
    return null;
  }
  return WORKER_META;
}

// worker/src/ingress/target-url.ts
function isTargetUrlRequest(request) {
  const url = new URL(request.url);
  return url.pathname === "/direct-url";
}
function resolveTargetUrlRoute(request, env) {
  const url = new URL(request.url);
  if (!isTargetUrlRequest(request)) {
    return null;
  }
  if (!env.DIRECT_BEARER || !verifyStaticBearer(request.headers.get("Authorization"), env.DIRECT_BEARER)) {
    return null;
  }
  const targetValue = url.searchParams.get("target");
  if (!targetValue) {
    return null;
  }
  let targetUrl;
  try {
    targetUrl = new URL(targetValue);
  } catch {
    return null;
  }
  switch (targetUrl.protocol) {
    case "tcp:":
      return resolveTcpTargetUrl(request, url, targetUrl);
    case "http:":
    case "https:":
      return resolveFetchTargetUrl(url, targetUrl);
    default:
      return null;
  }
}
function resolveTcpTargetUrl(request, requestUrl, targetUrl) {
  if (request.method !== "POST") {
    return null;
  }
  if (targetUrl.username || targetUrl.password || targetUrl.pathname || targetUrl.search || targetUrl.hash) {
    return null;
  }
  const host = unbracketIPv6Host(targetUrl.hostname);
  const port = Number.parseInt(targetUrl.port, 10);
  if (!host || host.length > 253 || host.includes("\n") || host.includes("\r") || !targetUrl.port || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  const payloadOptions = parsePayloadOptions(requestUrl);
  if (!payloadOptions) {
    return null;
  }
  return {
    egress: "connect",
    target: { host, port },
    payloadOptions
  };
}
function unbracketIPv6Host(host) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}
function resolveFetchTargetUrl(requestUrl, targetUrl) {
  if (requestUrl.searchParams.has("write_close_after") || requestUrl.searchParams.has("tls")) {
    return null;
  }
  if (targetUrl.username || targetUrl.password || targetUrl.hash) {
    return null;
  }
  return {
    egress: "fetch",
    targetUrl
  };
}

// worker/src/profiles/runtime.ts
function createWorker(profile) {
  return {
    async fetch(request, env, ctx) {
      for (const route of profile.routes) {
        if (route.matches(request)) {
          return route.handle(request, env, ctx);
        }
      }
      return notFound();
    }
  };
}

// worker/src/egress/connect.ts
import { connect } from "cloudflare:sockets";
async function connectTarget(target, mode, options = {}) {
  const secureTransport = options.secureTransport ?? "off";
  const socket = mode === "payload" || secureTransport !== "off" ? connect({ hostname: target.host, port: target.port }, { secureTransport, allowHalfOpen: true }) : connect({ hostname: target.host, port: target.port });
  await socket.opened;
  return socket;
}

// worker/src/response/payload-stream.ts
async function runPayloadExchange(request, target, ctx, options = {}) {
  let socket;
  try {
    socket = await connectTarget(target, "payload", options);
  } catch {
    return null;
  }
  ctx.waitUntil(
    pipeRequestToSocket(request, socket, options).catch(() => {
      void socket.close().catch(() => void 0);
    })
  );
  return new Response(socket.readable, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store"
    }
  });
}
async function pipeRequestToSocket(request, socket, options) {
  const writer = socket.writable.getWriter();
  try {
    if (request.body) {
      const reader = request.body.getReader();
      try {
        for (; ; ) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            await writer.write(value);
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    if (options.writeCloseAfterMs !== void 0) {
      if (options.writeCloseAfterMs > 0) {
        await sleep(options.writeCloseAfterMs);
      }
      await writer.close();
    }
  } finally {
    writer.releaseLock();
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// worker/src/response/wss-tunnel.ts
async function runWssTunnel(ws, target, options = {}) {
  let socket;
  try {
    socket = await connectTarget(target, "wss", options);
  } catch {
    safeSend(ws, "ERR connect_failed\n");
    ws.close(1011);
    return;
  }
  const session = createWebSocketByteSession(ws);
  const relayDone = relayWebSocketToSocket(session, socket);
  session.send("OK\n");
  await relayDone;
}
function createWebSocketByteSession(ws) {
  return {
    send(data) {
      safeSend(ws, data);
    },
    close(code = 1e3) {
      try {
        ws.close(code);
      } catch {
      }
    },
    onBinary(handler) {
      ws.addEventListener("message", (event) => {
        const data = event.data;
        if (typeof data === "string") {
          ws.close(1002);
          return;
        }
        void binaryMessageBytes(data).then(handler).catch(() => ws.close(1011));
      });
    },
    onClose(handler) {
      ws.addEventListener("close", handler);
      ws.addEventListener("error", handler);
    }
  };
}
async function relayWebSocketToSocket(session, socket) {
  const writer = socket.writable.getWriter();
  let writeChain = Promise.resolve();
  let closed = false;
  const closeBoth = () => {
    if (closed) {
      return;
    }
    closed = true;
    session.close(1e3);
    void writer.close().catch(() => void 0);
    void socket.close().catch(() => void 0);
  };
  session.onBinary((bytes) => {
    writeChain = writeChain.then(() => writer.write(bytes)).catch(closeBoth);
    return writeChain;
  });
  session.onClose(closeBoth);
  try {
    const reader = socket.readable.getReader();
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        session.send(value);
      }
    }
    await writeChain.catch(() => void 0);
  } catch {
  } finally {
    closeBoth();
  }
}
async function binaryMessageBytes(data) {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new TypeError("unsupported binary message");
}
function safeSend(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  } catch {
  }
}

// worker/src/profiles/full.ts
var routes = [
  {
    path: "/wss",
    matches(request) {
      return new URL(request.url).pathname === "/wss";
    },
    async handle(request, env, ctx) {
      const route = await resolveBearerClaimsRoute(request, env, "wss");
      if (!route) {
        return notFound();
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("upgrade required\n", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.binaryType = "arraybuffer";
      ctx.waitUntil(runWssTunnel(server, route.target, route.payloadOptions));
      return new Response(null, { status: 101, webSocket: client });
    }
  },
  {
    path: "/h2|/h3",
    matches(request) {
      const pathname = new URL(request.url).pathname;
      return pathname === "/h2" || pathname === "/h3";
    },
    async handle(request, env, ctx) {
      const route = await resolveBearerClaimsRoute(request, env, "payload");
      if (!route) {
        return notFound();
      }
      const response = await runPayloadExchange(request, route.target, ctx, route.payloadOptions);
      return response ?? new Response(null, { status: 502 });
    }
  },
  {
    path: "/direct/:host/:port",
    matches: isDirectPathRequest,
    async handle(request, env, ctx) {
      const route = resolveDirectPathRoute(request, env);
      if (!route) {
        return notFound();
      }
      const response = await runPayloadExchange(request, route.target, ctx, route.payloadOptions);
      return response ?? new Response(null, { status: 502 });
    }
  },
  {
    path: "/direct-url",
    matches: isTargetUrlRequest,
    async handle(request, env, ctx) {
      const route = resolveTargetUrlRoute(request, env);
      if (!route) {
        return notFound();
      }
      if (route.egress === "connect") {
        const response2 = await runPayloadExchange(request, route.target, ctx, route.payloadOptions);
        return response2 ?? new Response(null, { status: 502 });
      }
      const response = await runFetchExchange(request, route.targetUrl);
      return response ?? new Response(null, { status: 502 });
    }
  },
  {
    path: "/__meta",
    matches: isMetaRequest,
    handle(request, env) {
      const meta = resolveMetaRoute(request, env);
      if (!meta) {
        return notFound();
      }
      return Response.json(meta, {
        headers: {
          "cache-control": "no-store"
        }
      });
    }
  }
];
var full_default = createWorker({ routes });
export {
  full_default as default
};
