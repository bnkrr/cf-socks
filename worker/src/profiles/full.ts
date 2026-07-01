import { runFetchExchange } from "../egress/fetch";
import { resolveBearerClaimsRoute } from "../auth/bearer-claims";
import { resolveDirectPathRoute, isDirectPathRequest } from "../ingress/direct-path";
import { isMetaRequest, resolveMetaRoute } from "../ingress/meta";
import { isTargetUrlRequest, resolveTargetUrlRoute } from "../ingress/target-url";
import { createWorker } from "./runtime";
import { runPayloadExchange } from "../response/payload-stream";
import { runWssTunnel } from "../response/wss-tunnel";
import { notFound } from "../shared/types";
import type { Env, RouteModule } from "../shared/types";

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
  {
    path: "/h2|/h3",
    matches(request) {
      const pathname = new URL(request.url).pathname;
      return pathname === "/h2" || pathname === "/h3";
    },
    async handle(request, env, ctx) {
      const route = await resolveBearerClaimsRoute(request, env, "payload");
      if (!route) {
        return notFound();
      }
      const response = await runPayloadExchange(request, route.target, ctx, route.payloadOptions);
      return response ?? new Response(null, { status: 502 });
    },
  },
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
    },
  },
  {
    path: "/direct-url",
    matches: isTargetUrlRequest,
    async handle(request, env, ctx) {
      const route = resolveTargetUrlRoute(request, env);
      if (!route) {
        return notFound();
      }
      if (route.egress === "connect") {
        const response = await runPayloadExchange(request, route.target, ctx, route.payloadOptions);
        return response ?? new Response(null, { status: 502 });
      }
      const response = await runFetchExchange(request, route.targetUrl);
      return response ?? new Response(null, { status: 502 });
    },
  },
  {
    path: "/__meta",
    matches: isMetaRequest,
    handle(request: Request, env: Env) {
      const meta = resolveMetaRoute(request, env);
      if (!meta) {
        return notFound();
      }
      return Response.json(meta, {
        headers: {
          "cache-control": "no-store",
        },
      });
    },
  },
];

export default createWorker({ routes });
