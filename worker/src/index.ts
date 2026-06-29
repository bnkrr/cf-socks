import { Env, resolveDirectRoute, resolveRoute } from "./route";
import { runPayloadExchange, runWssTunnel } from "./tunnel";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // See docs/protocol.md for the endpoint and TCP binding model.
    const url = new URL(request.url);
    if (url.pathname === "/wss") {
      return handleWSS(request, env, ctx);
    }
    if (url.pathname === "/h2" || url.pathname === "/h3") {
      return handlePayload(request, env, ctx);
    }
    if (url.pathname.startsWith("/direct/")) {
      return handleDirect(request, env, ctx);
    }
    return notFound();
  },
};

async function handleWSS(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const route = await resolveRoute(request, env, "wss");
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
  ctx.waitUntil(runWssTunnel(server, route.target));
  return new Response(null, { status: 101, webSocket: client });
}

async function handlePayload(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const route = await resolveRoute(request, env, "payload");
  if (!route) {
    return notFound();
  }
  const response = await runPayloadExchange(request, route.target, ctx);
  if (!response) {
    return new Response(null, { status: 502 });
  }
  return response;
}

async function handleDirect(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const route = resolveDirectRoute(request, env);
  if (!route) {
    return notFound();
  }
  const response = await runPayloadExchange(request, route.target, ctx);
  if (!response) {
    return new Response(null, { status: 502 });
  }
  return response;
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}
