// Generated from worker/src/index.ts. Do not edit by hand.

// worker/src/index.ts
import { connect } from "cloudflare:sockets";

// worker/src/auth.ts
var HANDSHAKE_PREFIX = "cf-socks-v1";
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
function parseHandshake(input) {
  if (typeof input !== "string") {
    return null;
  }
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
  if (candidate.v !== 1 || typeof candidate.host !== "string" || !isValidHost(candidate.host) || typeof candidate.port !== "number" || !Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535 || typeof candidate.ts !== "number" || !Number.isInteger(candidate.ts) || typeof candidate.nonce !== "string" || !isReasonableToken(candidate.nonce) || typeof candidate.mac !== "string" || !isReasonableToken(candidate.mac)) {
    return null;
  }
  return {
    v: 1,
    host: candidate.host,
    port: candidate.port,
    ts: candidate.ts,
    nonce: candidate.nonce,
    mac: candidate.mac
  };
}
function handshakeMessage(handshake) {
  return `${HANDSHAKE_PREFIX}
${handshake.host}
${handshake.port}
${handshake.ts}
${handshake.nonce}`;
}
async function verifyHandshake(handshake, options) {
  const windowSeconds = options.windowSeconds ?? 120;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1e3);
  if (Math.abs(now - handshake.ts) > windowSeconds) {
    return false;
  }
  const actual = base64UrlDecode(handshake.mac);
  if (!actual) {
    return false;
  }
  const key = await hmacKey(options.secret, ["verify"]);
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(actual),
    new TextEncoder().encode(handshakeMessage(handshake))
  );
  if (!verified) {
    return false;
  }
  if (options.nonceCache && !options.nonceCache.consume(handshake.nonce, handshake.ts + windowSeconds, now)) {
    return false;
  }
  return true;
}
function isValidHost(host) {
  if (host.length < 1 || host.length > 253 || host.includes("\n") || host.includes("\r")) {
    return false;
  }
  return /^[A-Za-z0-9._:-]+$/.test(host);
}
function isReasonableToken(value) {
  return value.length >= 8 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}
async function hmacKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
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
function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// worker/src/index.ts
var nonceCache = new NonceCache();
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/tcp") {
      return new Response("not found\n", { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("upgrade required\n", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.binaryType = "arraybuffer";
    ctx.waitUntil(handleTunnel(server, env));
    return new Response(null, { status: 101, webSocket: client });
  }
};
async function handleTunnel(ws, env) {
  const secret = env.AUTH_SECRET;
  if (!secret) {
    ws.close(1008);
    return;
  }
  const first = await readFirstMessage(ws, 1e4);
  const handshake = parseHandshake(first);
  const ok = handshake !== null && await verifyHandshake(handshake, {
    secret,
    windowSeconds: parseWindowSeconds(env.AUTH_WINDOW_SECONDS),
    nonceCache
  });
  if (!ok || handshake === null) {
    ws.close(1008);
    return;
  }
  let socket;
  try {
    socket = connect({ hostname: handshake.host, port: handshake.port });
    await socket.opened;
  } catch {
    safeSend(ws, "ERR connect_failed\n");
    ws.close(1011);
    return;
  }
  const relayDone = relay(ws, socket);
  safeSend(ws, "OK\n");
  await relayDone;
}
function readFirstMessage(ws, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const onMessage = (event) => {
      cleanup();
      resolve(event.data);
    };
    const onClose = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onClose);
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onClose);
  });
}
async function relay(ws, socket) {
  const writer = socket.writable.getWriter();
  let writeChain = Promise.resolve();
  let closed = false;
  const closeBoth = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      ws.close(1e3);
    } catch {
    }
    void writer.close().catch(() => void 0);
    void socket.close().catch(() => void 0);
  };
  ws.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data === "string") {
      ws.close(1002);
      return;
    }
    writeChain = writeChain.then(async () => {
      const bytes = await binaryMessageBytes(data);
      await writer.write(bytes);
    }).catch(closeBoth);
  });
  ws.addEventListener("close", closeBoth);
  ws.addEventListener("error", closeBoth);
  try {
    const reader = socket.readable.getReader();
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        safeSend(ws, value);
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
function parseWindowSeconds(value) {
  if (!value) {
    return 120;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
}
function safeSend(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  } catch {
  }
}
export {
  index_default as default
};
