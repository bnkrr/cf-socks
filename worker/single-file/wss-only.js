// Generated from worker/src/profiles/wss-only.ts (wss-only profile). Do not edit by hand.

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

// worker/src/profiles/wss-only.ts
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
  }
];
var wss_only_default = createWorker({ routes });
export {
  wss_only_default as default
};
