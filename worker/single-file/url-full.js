// Generated from worker/src/profiles/url-full.ts (url-full profile). Do not edit by hand.

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
var MAX_WRITE_CLOSE_AFTER_MS = 6e5;
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
  return Number.isSafeInteger(ms) && ms <= MAX_WRITE_CLOSE_AFTER_MS ? ms : null;
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

// worker/src/shared/types.ts
function notFound() {
  return new Response(null, { status: 404 });
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

// worker/src/profiles/url-full.ts
var routes = [
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
  }
];
var url_full_default = createWorker({ routes });
export {
  url_full_default as default
};
