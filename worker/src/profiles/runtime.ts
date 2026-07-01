import { notFound } from "../shared/types";
import type { Env, WorkerProfile } from "../shared/types";

export function createWorker(profile: WorkerProfile) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      for (const route of profile.routes) {
        if (route.matches(request)) {
          return route.handle(request, env, ctx);
        }
      }
      return notFound();
    },
  };
}
