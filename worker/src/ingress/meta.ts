import { verifyStaticBearer } from "../auth/static-bearer";
import { WORKER_META } from "../shared/types";
import type { Env, WorkerMeta } from "../shared/types";

export { WORKER_META };

export function isMetaRequest(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === "GET" && url.pathname === "/__meta";
}

export function resolveMetaRoute(request: Request, env: Env): WorkerMeta | null {
  if (!isMetaRequest(request)) {
    return null;
  }
  if (!env.DIRECT_BEARER || !verifyStaticBearer(request.headers.get("Authorization"), env.DIRECT_BEARER)) {
    return null;
  }
  return WORKER_META;
}
