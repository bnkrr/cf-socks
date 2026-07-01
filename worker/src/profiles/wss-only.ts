import { resolveBearerClaimsRoute } from "../auth/bearer-claims";
import { createWorker } from "./runtime";
import { runWssTunnel } from "../response/wss-tunnel";
import { notFound } from "../shared/types";
import type { RouteModule } from "../shared/types";

const routes: RouteModule[] = [
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
    },
  },
];

export default createWorker({ routes });
