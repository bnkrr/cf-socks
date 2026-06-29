import { Claims, NonceCache, verifyBearerToken } from "./token";

export interface Env {
  AUTH_SECRET?: string;
  AUTH_WINDOW_SECONDS?: string;
  DIRECT_BEARER?: string;
}

export interface Target {
  host: string;
  port: number;
}

export type RouteTransport = "wss" | "payload";

export interface RouteDecision {
  op: Claims["op"];
  target: Target;
  transport: RouteTransport;
  path: string;
}

const nonceCache = new NonceCache();

export async function resolveRoute(
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
  };
}

export function resolveDirectRoute(request: Request, env: Env): RouteDecision | null {
  const url = new URL(request.url);
  if (request.method !== "POST" || !url.pathname.startsWith("/direct/")) {
    return null;
  }
  if (!env.DIRECT_BEARER || !verifyStaticBearer(request.headers.get("Authorization"), env.DIRECT_BEARER)) {
    return null;
  }

  const target = parseDirectTarget(url.pathname);
  if (!target) {
    return null;
  }
  return {
    op: "payload",
    target,
    transport: "payload",
    path: url.pathname,
  };
}

function parseDirectTarget(pathname: string): Target | null {
  const parts = pathname.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "direct") {
    return null;
  }
  let host: string;
  try {
    host = decodeURIComponent(parts[2]);
  } catch {
    return null;
  }
  const port = Number.parseInt(parts[3], 10);
  if (
    !host ||
    host.length > 253 ||
    host.includes("/") ||
    host.includes("\n") ||
    host.includes("\r") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    String(port) !== parts[3]
  ) {
    return null;
  }
  return { host, port };
}

function verifyStaticBearer(header: string | null, expected: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) {
    return false;
  }
  const actual = header.slice(prefix.length);
  return actual.length === expected.length && constantTimeEqual(actual, expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function parseWindowSeconds(value: string | undefined): number {
  if (!value) {
    return 120;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
}
