import { connectTarget } from "../egress/connect";
import type { PayloadOptions, Target } from "../shared/types";

export async function runPayloadExchange(
  request: Request,
  target: Target,
  ctx: ExecutionContext,
  options: PayloadOptions = {},
): Promise<Response | null> {
  let socket: Awaited<ReturnType<typeof connectTarget>>;
  try {
    socket = await connectTarget(target, "payload", options);
  } catch {
    return null;
  }

  ctx.waitUntil(
    pipeRequestToSocket(request, socket, options).catch(() => {
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

async function pipeRequestToSocket(
  request: Request,
  socket: Awaited<ReturnType<typeof connectTarget>>,
  options: PayloadOptions,
): Promise<void> {
  const writer = socket.writable.getWriter();
  try {
    if (request.body) {
      const reader = request.body.getReader();
      try {
        for (;;) {
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
    if (options.writeCloseAfterMs !== undefined) {
      if (options.writeCloseAfterMs > 0) {
        await sleep(options.writeCloseAfterMs);
      }
      await writer.close();
    }
  } finally {
    writer.releaseLock();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
