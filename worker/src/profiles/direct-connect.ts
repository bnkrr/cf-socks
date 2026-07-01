import { resolveDirectPathRoute, isDirectPathRequest } from "../ingress/direct-path";
import { createWorker } from "./runtime";
import { runPayloadExchange } from "../response/payload-stream";
import { notFound } from "../shared/types";
import type { RouteModule } from "../shared/types";

const routes: RouteModule[] = [
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
];

export default createWorker({ routes });
