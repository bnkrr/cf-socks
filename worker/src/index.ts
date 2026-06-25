import { connect } from "cloudflare:sockets";
import { NonceCache, parseHandshake, verifyHandshake } from "./auth";

export interface Env {
  AUTH_SECRET?: string;
  AUTH_WINDOW_SECONDS?: string;
}

const nonceCache = new NonceCache();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
  },
};

async function handleTunnel(ws: WebSocket, env: Env): Promise<void> {
  const secret = env.AUTH_SECRET;
  if (!secret) {
    ws.close(1008);
    return;
  }

  const first = await readFirstMessage(ws, 10_000);
  const handshake = parseHandshake(first);
  const ok =
    handshake !== null &&
    (await verifyHandshake(handshake, {
      secret,
      windowSeconds: parseWindowSeconds(env.AUTH_WINDOW_SECONDS),
      nonceCache,
    }));

  if (!ok || handshake === null) {
    ws.close(1008);
    return;
  }

  let socket: ReturnType<typeof connect>;
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

function readFirstMessage(ws: WebSocket, timeoutMs: number): Promise<string | ArrayBuffer | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      cleanup();
      resolve(event.data as string | ArrayBuffer);
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

function safeSend(ws: WebSocket, data: string | Uint8Array): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  } catch {
    // Peer closed; relay cleanup will follow.
  }
}
