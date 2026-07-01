import { NonceCache, verifyBearerToken } from "../token";
import type { Claims } from "../token";
import type { Env, PayloadOptions, RouteDecision, RouteTransport } from "../shared/types";

const nonceCache = new NonceCache();

export async function resolveBearerClaimsRoute(
  request: Request,
  env: Env,
  transport: RouteTransport,
): Promise<RouteDecision | null> {
  const url = new URL(request.url);
  const expectedOp = transport === "wss" ? "dial" : "payload";

  if (transport === "wss" && url.pathname !== "/wss") {
    return null;
  }
  if (transport === "payload" && url.pathname !== "/h2" && url.pathname !== "/h3") {
    return null;
  }
  if (transport === "payload" && request.method !== "POST") {
    return null;
  }
  if (!env.AUTH_SECRET) {
    return null;
  }

  const claims = await verifyBearerToken(request.headers.get("Authorization"), {
    secret: env.AUTH_SECRET,
    method: request.method,
    path: url.pathname,
    expectedOp,
    windowSeconds: parseWindowSeconds(env.AUTH_WINDOW_SECONDS),
    nonceCache,
  });
  if (!claims) {
    return null;
  }

  return {
    op: claims.op,
    target: { host: claims.host, port: claims.port },
    transport,
    path: url.pathname,
    payloadOptions: optionsFromClaims(transport, claims),
  };
}

function optionsFromClaims(transport: RouteTransport, claims: Claims): PayloadOptions | undefined {
  const options: PayloadOptions = {};
  if (claims.secure_transport !== undefined) {
    options.secureTransport = claims.secure_transport;
  }
  if (transport === "payload" && claims.write_close_after_ms !== undefined) {
    options.writeCloseAfterMs = claims.write_close_after_ms;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function parseWindowSeconds(value: string | undefined): number {
  if (!value) {
    return 120;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
}
