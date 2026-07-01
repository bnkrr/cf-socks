import { connect } from "cloudflare:sockets";
import type { PayloadOptions, Target } from "../shared/types";

export type WorkerSocket = ReturnType<typeof connect>;
export type ConnectMode = "wss" | "payload";

export async function connectTarget(target: Target, mode: ConnectMode, options: PayloadOptions = {}): Promise<WorkerSocket> {
  const secureTransport = options.secureTransport ?? "off";
  const socket =
    mode === "payload" || secureTransport !== "off"
      ? connect({ hostname: target.host, port: target.port }, { secureTransport, allowHalfOpen: true })
      : connect({ hostname: target.host, port: target.port });
  await socket.opened;
  return socket;
}
