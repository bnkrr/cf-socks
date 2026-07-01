import { verifyStaticBearer } from "../auth/static-bearer";
import { parsePayloadOptions } from "./payload-options";
import type { Env, TargetUrlRouteDecision } from "../shared/types";

export function isTargetUrlRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.pathname === "/direct-url";
}

export function resolveTargetUrlRoute(request: Request, env: Env): TargetUrlRouteDecision | null {
  const url = new URL(request.url);
  if (!isTargetUrlRequest(request)) {
    return null;
  }
  if (!env.DIRECT_BEARER || !verifyStaticBearer(request.headers.get("Authorization"), env.DIRECT_BEARER)) {
    return null;
  }

  const targetValue = url.searchParams.get("target");
  if (!targetValue) {
    return null;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(targetValue);
  } catch {
    return null;
  }

  switch (targetUrl.protocol) {
    case "tcp:":
      return resolveTcpTargetUrl(request, url, targetUrl);
    case "http:":
    case "https:":
      return resolveFetchTargetUrl(url, targetUrl);
    default:
      return null;
  }
}

function resolveTcpTargetUrl(request: Request, requestUrl: URL, targetUrl: URL): TargetUrlRouteDecision | null {
  if (request.method !== "POST") {
    return null;
  }
  if (targetUrl.username || targetUrl.password || targetUrl.pathname || targetUrl.search || targetUrl.hash) {
    return null;
  }
  const host = unbracketIPv6Host(targetUrl.hostname);
  const port = Number.parseInt(targetUrl.port, 10);
  if (
    !host ||
    host.length > 253 ||
    host.includes("\n") ||
    host.includes("\r") ||
    !targetUrl.port ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return null;
  }
  const payloadOptions = parsePayloadOptions(requestUrl);
  if (!payloadOptions) {
    return null;
  }
  return {
    egress: "connect",
    target: { host, port },
    payloadOptions,
  };
}

function unbracketIPv6Host(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function resolveFetchTargetUrl(requestUrl: URL, targetUrl: URL): TargetUrlRouteDecision | null {
  if (requestUrl.searchParams.has("write_close_after") || requestUrl.searchParams.has("tls")) {
    return null;
  }
  if (targetUrl.username || targetUrl.password || targetUrl.hash) {
    return null;
  }
  return {
    egress: "fetch",
    targetUrl,
  };
}
