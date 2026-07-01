import type { Claims } from "../token";

export interface Env {
  AUTH_SECRET?: string;
  AUTH_WINDOW_SECONDS?: string;
  DIRECT_BEARER?: string;
}

export interface Target {
  host: string;
  port: number;
}

export type SecureTransport = "off" | "on";

export interface PayloadOptions {
  secureTransport?: SecureTransport;
  writeCloseAfterMs?: number;
}

export type RouteTransport = "wss" | "payload";

export interface RouteDecision {
  op: Claims["op"];
  target: Target;
  transport: RouteTransport;
  path: string;
  payloadOptions?: PayloadOptions;
}

export interface ConnectUrlRouteDecision {
  egress: "connect";
  target: Target;
  payloadOptions?: PayloadOptions;
}

export interface FetchUrlRouteDecision {
  egress: "fetch";
  targetUrl: URL;
}

export type TargetUrlRouteDecision = ConnectUrlRouteDecision | FetchUrlRouteDecision;

export interface WorkerMeta {
  name: "cf-socks";
  version: string;
  protocol: number;
  capabilities: string[];
}

export type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response;

export interface RouteModule {
  path: string;
  matches(request: Request): boolean;
  handle: Handler;
}

export interface WorkerProfile {
  routes: RouteModule[];
}

export const WORKER_META: WorkerMeta = {
  name: "cf-socks",
  version: "0.7.0",
  protocol: 2,
  capabilities: ["wss", "h2", "h3", "direct", "direct_url", "fetch", "tls", "write_close_after"],
};

export function notFound(): Response {
  return new Response(null, { status: 404 });
}
