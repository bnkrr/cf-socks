// Generated from worker/src/profiles/direct-connect.ts (direct-connect profile). Do not edit by hand.

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

// worker/src/profiles/direct-connect.ts
var routes = [
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
  }
];
var direct_connect_default = createWorker({ routes });
export {
  direct_connect_default as default
};
