import { runFetchExchange } from "../egress/fetch";
import { isTargetUrlRequest, resolveTargetUrlRoute } from "../ingress/target-url";
import { createWorker } from "./runtime";
import { runPayloadExchange } from "../response/payload-stream";
import { notFound } from "../shared/types";
import type { RouteModule } from "../shared/types";

const routes: RouteModule[] = [
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
];

export default createWorker({ routes });
