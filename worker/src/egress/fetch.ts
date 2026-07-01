const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export async function runFetchExchange(request: Request, targetUrl: URL): Promise<Response | null> {
  try {
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: targetRequestHeaders(request.headers),
      body: requestBodyForFetch(request),
      redirect: "manual",
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: targetResponseHeaders(response.headers),
    });
  } catch {
    return null;
  }
}

function targetRequestHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  deleteConnectionHeaders(next, headers);
  next.delete("authorization");
  next.delete("host");
  return next;
}

function targetResponseHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  deleteConnectionHeaders(next, headers);
  return next;
}

function deleteConnectionHeaders(target: Headers, source: Headers): void {
  for (const name of connectionHeaderNames(source)) {
    target.delete(name);
  }
  for (const name of HOP_BY_HOP_HEADERS) {
    target.delete(name);
  }
}

function connectionHeaderNames(headers: Headers): string[] {
  const value = headers.get("connection");
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function requestBodyForFetch(request: Request): ReadableStream<Uint8Array> | null {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  return request.body;
}
