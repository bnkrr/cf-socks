import { connectTarget } from "../egress/connect";
import type { WorkerSocket } from "../egress/connect";
import type { PayloadOptions, Target } from "../shared/types";

interface WebSocketByteSession {
  send(data: string | Uint8Array): void;
  close(code?: number): void;
  onBinary(handler: (bytes: Uint8Array) => Promise<void>): void;
  onClose(handler: () => void): void;
}

export async function runWssTunnel(ws: WebSocket, target: Target, options: PayloadOptions = {}): Promise<void> {
  let socket: WorkerSocket;
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

function createWebSocketByteSession(ws: WebSocket): WebSocketByteSession {
  return {
    send(data: string | Uint8Array) {
      safeSend(ws, data);
    },
    close(code = 1000) {
      try {
        ws.close(code);
      } catch {
        // Already closed.
      }
    },
    onBinary(handler: (bytes: Uint8Array) => Promise<void>) {
      ws.addEventListener("message", (event) => {
        const data = event.data;
        if (typeof data === "string") {
          ws.close(1002);
          return;
        }
        void binaryMessageBytes(data).then(handler).catch(() => ws.close(1011));
      });
    },
    onClose(handler: () => void) {
      ws.addEventListener("close", handler);
      ws.addEventListener("error", handler);
    },
  };
}

async function relayWebSocketToSocket(session: WebSocketByteSession, socket: WorkerSocket): Promise<void> {
  const writer = socket.writable.getWriter();
  let writeChain = Promise.resolve();
  let closed = false;

  const closeBoth = () => {
    if (closed) {
      return;
    }
    closed = true;
    session.close(1000);
    void writer.close().catch(() => undefined);
    void socket.close().catch(() => undefined);
  };

  session.onBinary((bytes) => {
    writeChain = writeChain.then(() => writer.write(bytes)).catch(closeBoth);
    return writeChain;
  });
  session.onClose(closeBoth);

  try {
    const reader = socket.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        session.send(value);
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

function safeSend(ws: WebSocket, data: string | Uint8Array): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  } catch {
    // Peer closed; relay cleanup will follow.
  }
}
