import { connect } from "cloudflare:sockets";
import { NonceCache, verifyBearerToken } from "./token";

export interface Env {
  AUTH_SECRET?: string;
  AUTH_WINDOW_SECONDS?: string;
}

const nonceCache = new NonceCache();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // See docs/protocol.md for the endpoint and TCP binding model.
    const url = new URL(request.url);
    if (url.pathname === "/wss") {
      return handleWSS(request, env, ctx);
    }
    if (url.pathname === "/h2" || url.pathname === "/h3") {
      return handlePayload(request, env, ctx);
    }
    return notFound();
  },
};

async function handleWSS(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const claims = await verifyRequest(request, env, "dial");
  if (!claims) {
    return notFound();
  }
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("upgrade required\n", { status: 426 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  server.binaryType = "arraybuffer";
  ctx.waitUntil(handleTunnel(server, claims.host, claims.port));
  return new Response(null, { status: 101, webSocket: client });
}

async function handlePayload(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") {
    return notFound();
  }
  const claims = await verifyRequest(request, env, "payload");
  if (!claims) {
    return notFound();
  }
  let socket: ReturnType<typeof connect>;
  try {
    socket = connect({ hostname: claims.host, port: claims.port }, { secureTransport: "off", allowHalfOpen: true });
    await socket.opened;
  } catch {
    return new Response(null, { status: 502 });
  }

  ctx.waitUntil(
    pipeRequestToSocket(request, socket).catch(() => {
      void socket.close().catch(() => undefined);
    }),
  );
  return new Response(socket.readable, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}

async function verifyRequest(request: Request, env: Env, expectedOp: "dial" | "payload") {
  if (!env.AUTH_SECRET) {
    return null;
  }
  const url = new URL(request.url);
  return verifyBearerToken(request.headers.get("Authorization"), {
    secret: env.AUTH_SECRET,
    method: request.method,
    path: url.pathname,
    expectedOp,
    windowSeconds: parseWindowSeconds(env.AUTH_WINDOW_SECONDS),
    nonceCache,
  });
}

async function handleTunnel(ws: WebSocket, host: string, port: number): Promise<void> {
  let socket: ReturnType<typeof connect>;
  try {
    socket = connect({ hostname: host, port });
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

async function relay(ws: WebSocket, socket: ReturnType<typeof connect>): Promise<void> {
  const writer = socket.writable.getWriter();
  let writeChain = Promise.resolve();
  let closed = false;

  const closeBoth = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      ws.close(1000);
    } catch {
      // Already closed.
    }
    void writer.close().catch(() => undefined);
    void socket.close().catch(() => undefined);
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
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        safeSend(ws, value);
      }
    }
    await writeChain.catch(() => undefined);
  } catch {
    // Let closeBoth normalize both sides.
  } finally {
    closeBoth();
  }
}

async function binaryMessageBytes(data: unknown): Promise<Uint8Array> {
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

function parseWindowSeconds(value: string | undefined): number {
  if (!value) {
    return 120;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
}

async function pipeRequestToSocket(request: Request, socket: ReturnType<typeof connect>): Promise<void> {
  if (!request.body) {
    return;
  }
  const reader = request.body.getReader();
  const writer = socket.writable.getWriter();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      if (value) {
        await writer.write(value);
      }
    }
  } finally {
    // Do not close socket.writable here. On Workers connect(), closing the writable side
    // also ends the readable response path in practice, which breaks Do response streaming.
    writer.releaseLock();
    reader.releaseLock();
  }
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

function safeSend(ws: WebSocket, data: string | Uint8Array): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  } catch {
    // Peer closed; relay cleanup will follow.
  }
}
