import { verifyStaticBearer } from "../auth/static-bearer";
import { parsePayloadOptions } from "./payload-options";
import type { Env, RouteDecision, Target } from "../shared/types";

export function isDirectPathRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith("/direct/");
}

export function resolveDirectPathRoute(request: Request, env: Env): RouteDecision | null {
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
  const payloadOptions = parsePayloadOptions(url);
  if (!payloadOptions) {
    return null;
  }
  return {
    op: "payload",
    target,
    transport: "payload",
    path: url.pathname,
    payloadOptions,
  };
}

export function parseDirectTarget(pathname: string): Target | null {
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
