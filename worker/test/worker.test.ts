import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("cloudflare:sockets", () => ({
  connect: mocks.connect,
}));

import worker from "../src/index";
import { runWssTunnel } from "../src/response/wss-tunnel";

describe("worker endpoints", () => {
  beforeEach(() => {
    mocks.connect.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("/wss rejects invalid auth before upgrade", async () => {
    const ctx = executionContext();
    const response = await worker.fetch(new Request("https://worker.test/wss"), env(), ctx);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(ctx.promises).toHaveLength(0);
  });

  it("/h2 rejects invalid auth with empty 404", async () => {
    const ctx = executionContext();
    const response = await worker.fetch(new Request("https://worker.test/h2", { method: "POST" }), env(), ctx);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("/direct rejects when direct bearer is missing", async () => {
    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/direct/example.test/80", {
        method: "POST",
        headers: { authorization: "Bearer direct-secret" },
      }),
      env({ DIRECT_BEARER: undefined }),
      ctx,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("/direct rejects invalid direct bearer", async () => {
    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/direct/example.test/80", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("/__meta rejects invalid direct bearer", async () => {
    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/__meta", {
        headers: { authorization: "Bearer wrong" },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("/__meta returns authenticated capabilities", async () => {
    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/__meta", {
        headers: { authorization: "Bearer direct-secret" },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const meta = (await response.json()) as { name: string; protocol: number; capabilities: string[] };
    expect(meta.name).toBe("cf-socks");
    expect(meta.protocol).toBe(2);
    expect(meta.capabilities).toContain("write_close_after");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("/wss rejects valid auth without websocket upgrade", async () => {
    const ctx = executionContext();
    const auth = await bearer("secret", "GET", "/wss", {
      op: "dial",
      host: "example.test",
      port: 443,
      ts: Math.floor(Date.now() / 1000),
    });
    const response = await worker.fetch(new Request("https://worker.test/wss", { headers: { authorization: auth } }), env(), ctx);

    expect(response.status).toBe(426);
    expect(await response.text()).toBe("upgrade required\n");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("/h2 accepts payload and streams target response", async () => {
    const written: Uint8Array[] = [];
    const closed = vi.fn();
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("target-response"));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(chunk);
        },
      }),
      close: vi.fn(() => {
        closed();
        return Promise.resolve();
      }),
    });

    const ctx = executionContext();
    const auth = await bearer("secret", "POST", "/h2", {
      op: "payload",
      host: "example.test",
      port: 80,
      ts: Math.floor(Date.now() / 1000),
    });
    const response = await worker.fetch(
      new Request("https://worker.test/h2", {
        method: "POST",
        headers: { authorization: auth },
        body: "client-payload",
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("target-response");
    await Promise.all(ctx.promises);
    expect(mocks.connect).toHaveBeenCalledWith(
      { hostname: "example.test", port: 80 },
      { secureTransport: "off", allowHalfOpen: true },
    );
    expect(new TextDecoder().decode(written[0])).toBe("client-payload");
    expect(closed).not.toHaveBeenCalled();
  });

  it("/h3 accepts payload with h3 token path", async () => {
    const written: Uint8Array[] = [];
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("h3-target-response"));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(chunk);
        },
      }),
      close: vi.fn(() => Promise.resolve()),
    });

    const ctx = executionContext();
    const auth = await bearer("secret", "POST", "/h3", {
      op: "payload",
      host: "example.test",
      port: 443,
      ts: Math.floor(Date.now() / 1000),
    });
    const response = await worker.fetch(
      new Request("https://worker.test/h3", {
        method: "POST",
        headers: { authorization: auth },
        body: "h3-client-payload",
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("h3-target-response");
    await Promise.all(ctx.promises);
    expect(mocks.connect).toHaveBeenCalledWith(
      { hostname: "example.test", port: 443 },
      { secureTransport: "off", allowHalfOpen: true },
    );
    expect(new TextDecoder().decode(written[0])).toBe("h3-client-payload");
  });

  it("/h2 forwards target TLS mode from bearer claims", async () => {
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("tls-response"));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      close: vi.fn(() => Promise.resolve()),
    });

    const ctx = executionContext();
    const auth = await bearer("secret", "POST", "/h2", {
      op: "payload",
      host: "example.test",
      port: 443,
      ts: Math.floor(Date.now() / 1000),
      secure_transport: "on",
    });
    const response = await worker.fetch(
      new Request("https://worker.test/h2", {
        method: "POST",
        headers: { authorization: auth },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("tls-response");
    expect(mocks.connect).toHaveBeenCalledWith(
      { hostname: "example.test", port: 443 },
      { secureTransport: "on", allowHalfOpen: true },
    );
  });

  it("/h2 closes target writable when token requests write_close_after", async () => {
    const closed = vi.fn();
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        close() {
          closed();
        },
      }),
      close: vi.fn(() => Promise.resolve()),
    });

    const ctx = executionContext();
    const auth = await bearer("secret", "POST", "/h2", {
      op: "payload",
      host: "example.test",
      port: 80,
      ts: Math.floor(Date.now() / 1000),
      write_close_after_ms: 0,
    });
    const response = await worker.fetch(
      new Request("https://worker.test/h2", {
        method: "POST",
        headers: { authorization: auth },
        body: "client-payload",
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    await Promise.all(ctx.promises);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("/h2 rejects oversized write_close_after token claim", async () => {
    const ctx = executionContext();
    const auth = await bearer("secret", "POST", "/h2", {
      op: "payload",
      host: "example.test",
      port: 80,
      ts: Math.floor(Date.now() / 1000),
      write_close_after_ms: 600_001,
    });
    const response = await worker.fetch(
      new Request("https://worker.test/h2", {
        method: "POST",
        headers: { authorization: auth },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("/direct accepts static bearer and target URL", async () => {
    const written: Uint8Array[] = [];
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("direct-target-response"));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(chunk);
        },
      }),
      close: vi.fn(() => Promise.resolve()),
    });

    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/direct/example.test/80", {
        method: "POST",
        headers: { authorization: "Bearer direct-secret" },
        body: "direct-client-payload",
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("direct-target-response");
    await Promise.all(ctx.promises);
    expect(mocks.connect).toHaveBeenCalledWith(
      { hostname: "example.test", port: 80 },
      { secureTransport: "off", allowHalfOpen: true },
    );
    expect(new TextDecoder().decode(written[0])).toBe("direct-client-payload");
  });

  it("/direct closes target writable from write_close_after query", async () => {
    const closed = vi.fn();
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        close() {
          closed();
        },
      }),
      close: vi.fn(() => Promise.resolve()),
    });

    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/direct/example.test/80?write_close_after=0", {
        method: "POST",
        headers: { authorization: "Bearer direct-secret" },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    await Promise.all(ctx.promises);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("/direct treats write_close_after=none as disabled", async () => {
    const closed = vi.fn();
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        close() {
          closed();
        },
      }),
      close: vi.fn(() => Promise.resolve()),
    });

    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/direct/example.test/80?write_close_after=none", {
        method: "POST",
        headers: { authorization: "Bearer direct-secret" },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    await Promise.all(ctx.promises);
    expect(closed).not.toHaveBeenCalled();
  });

  it("/direct rejects malformed write_close_after values before connect", async () => {
    for (const value of ["", "-1ms", "1", "1h", "11m", "600001ms", "abc"]) {
      const ctx = executionContext();
      const response = await worker.fetch(
        new Request(`https://worker.test/direct/example.test/80?write_close_after=${encodeURIComponent(value)}`, {
          method: "POST",
          headers: { authorization: "Bearer direct-secret" },
        }),
        env(),
        ctx,
      );

      expect(response.status, value).toBe(404);
      expect(await response.text(), value).toBe("");
    }
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("/direct accepts percent-encoded IPv6 target host", async () => {
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ipv6-response"));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      close: vi.fn(() => Promise.resolve()),
    });

    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/direct/%3A%3A1/443", {
        method: "POST",
        headers: { authorization: "Bearer direct-secret" },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ipv6-response");
    expect(mocks.connect).toHaveBeenCalledWith(
      { hostname: "::1", port: 443 },
      { secureTransport: "off", allowHalfOpen: true },
    );
  });

  it("/direct accepts readable IPv6 target host", async () => {
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ipv6-response"));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      close: vi.fn(() => Promise.resolve()),
    });

    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/direct/::1/443", {
        method: "POST",
        headers: { authorization: "Bearer direct-secret" },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ipv6-response");
    expect(mocks.connect).toHaveBeenCalledWith(
      { hostname: "::1", port: 443 },
      { secureTransport: "off", allowHalfOpen: true },
    );
  });

  it("/direct-url accepts tcp target URL and uses connect egress", async () => {
    const written: Uint8Array[] = [];
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("tcp-url-response"));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(chunk);
        },
      }),
      close: vi.fn(() => Promise.resolve()),
    });

    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/direct-url?target=tcp%3A%2F%2F1.1.1.1%3A80", {
        method: "POST",
        headers: { authorization: "Bearer direct-secret" },
        body: "tcp-url-client-payload",
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("tcp-url-response");
    await Promise.all(ctx.promises);
    expect(mocks.connect).toHaveBeenCalledWith(
      { hostname: "1.1.1.1", port: 80 },
      { secureTransport: "off", allowHalfOpen: true },
    );
    expect(new TextDecoder().decode(written[0])).toBe("tcp-url-client-payload");
  });

  it("/direct-url accepts readable unencoded tcp target URLs", async () => {
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("raw-url-response"));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      close: vi.fn(() => Promise.resolve()),
    });

    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/direct-url?target=tcp://example.test:80", {
        method: "POST",
        headers: { authorization: "Bearer direct-secret" },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("raw-url-response");
    expect(mocks.connect).toHaveBeenCalledWith(
      { hostname: "example.test", port: 80 },
      { secureTransport: "off", allowHalfOpen: true },
    );
  });

  it("/direct-url accepts tls=on for tcp target URLs", async () => {
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("tls-url-response"));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      close: vi.fn(() => Promise.resolve()),
    });

    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/direct-url?target=tcp://example.test:443&tls=on", {
        method: "POST",
        headers: { authorization: "Bearer direct-secret" },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("tls-url-response");
    expect(mocks.connect).toHaveBeenCalledWith(
      { hostname: "example.test", port: 443 },
      { secureTransport: "on", allowHalfOpen: true },
    );
  });

  it("/direct-url accepts https target URL and uses fetch egress", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://example.test/a.html?x=1");
      expect(init.method).toBe("GET");
      expect(init.body).toBeNull();
      const headers = init.headers as Headers;
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("connection")).toBeNull();
      expect(headers.get("x-hop")).toBeNull();
      expect(headers.get("x-test")).toBe("yes");
      return new Response("fetch-response", {
        status: 203,
        headers: {
          "content-type": "text/plain",
          connection: "x-response-hop, close",
          "x-response-hop": "hidden",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = executionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/direct-url?target=https%3A%2F%2Fexample.test%2Fa.html%3Fx%3D1", {
        method: "GET",
        headers: {
          authorization: "Bearer direct-secret",
          connection: "x-hop",
          "x-hop": "hidden",
          "x-test": "yes",
        },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(203);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("x-response-hop")).toBeNull();
    expect(await response.text()).toBe("fetch-response");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("/direct-url rejects malformed target URLs before egress", async () => {
    const cases = [
      "https://worker.test/direct-url",
      "https://worker.test/direct-url?target=udp%3A%2F%2F1.1.1.1%3A53",
      "https://worker.test/direct-url?target=tcp%3A%2F%2F1.1.1.1",
      "https://worker.test/direct-url?target=tcp%3A%2F%2F1.1.1.1%3A80%2Fpath",
      "https://worker.test/direct-url?target=tcp%3A%2F%2F1.1.1.1%3A80&tls=starttls",
      "https://worker.test/direct-url?target=https%3A%2F%2Fuser%3Apass%40example.test%2F",
      "https://worker.test/direct-url?target=https%3A%2F%2Fexample.test%2F%23fragment",
      "https://worker.test/direct-url?target=https%3A%2F%2Fexample.test%2F&write_close_after=0",
      "https://worker.test/direct-url?target=https%3A%2F%2Fexample.test%2F&tls=on",
    ];

    for (const url of cases) {
      const ctx = executionContext();
      const response = await worker.fetch(
        new Request(url, {
          method: "POST",
          headers: { authorization: "Bearer direct-secret" },
        }),
        env(),
        ctx,
      );

      expect(response.status, url).toBe(404);
      expect(await response.text(), url).toBe("");
    }
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("/direct rejects malformed target paths before connect", async () => {
    const cases = [
      "https://worker.test/direct/example.test/0",
      "https://worker.test/direct/example.test/65536",
      "https://worker.test/direct/example.test/080",
      "https://worker.test/direct/bad%2Fhost/80",
      "https://worker.test/direct/%0A/80",
    ];

    for (const url of cases) {
      const ctx = executionContext();
      const response = await worker.fetch(
        new Request(url, {
          method: "POST",
          headers: { authorization: "Bearer direct-secret" },
        }),
        env(),
        ctx,
      );

      expect(response.status, url).toBe(404);
      expect(await response.text(), url).toBe("");
    }
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("/h2 returns 502 when target connect fails", async () => {
    mocks.connect.mockImplementation(() => {
      throw new Error("connect failed");
    });

    const ctx = executionContext();
    const auth = await bearer("secret", "POST", "/h2", {
      op: "payload",
      host: "example.test",
      port: 80,
      ts: Math.floor(Date.now() / 1000),
    });
    const response = await worker.fetch(
      new Request("https://worker.test/h2", {
        method: "POST",
        headers: { authorization: auth },
        body: "client-payload",
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
  });

  it("wss tunnel sends OK and relays binary bytes", async () => {
    const written: Uint8Array[] = [];
    const ws = new FakeWebSocket();
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("target-response"));
            controller.close();
          }, 10);
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(chunk);
        },
      }),
      close: vi.fn(() => Promise.resolve()),
    });

    const done = runWssTunnel(ws as unknown as WebSocket, { host: "example.test", port: 443 });
    await tick();
    ws.emitMessage(new TextEncoder().encode("client-payload"));
    await done;

    expect(mocks.connect).toHaveBeenCalledWith({ hostname: "example.test", port: 443 });
    expect(ws.sentText()).toContain("OK\n");
    expect(ws.sentText()).toContain("target-response");
    expect(new TextDecoder().decode(written[0])).toBe("client-payload");
  });

  it("wss tunnel forwards target TLS mode", async () => {
    const ws = new FakeWebSocket();
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      close: vi.fn(() => Promise.resolve()),
    });

    await runWssTunnel(ws as unknown as WebSocket, { host: "example.test", port: 443 }, { secureTransport: "on" });

    expect(mocks.connect).toHaveBeenCalledWith(
      { hostname: "example.test", port: 443 },
      { secureTransport: "on", allowHalfOpen: true },
    );
  });

  it("wss tunnel closes on text websocket messages", async () => {
    const ws = new FakeWebSocket();
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => controller.close(), 10);
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      close: vi.fn(() => Promise.resolve()),
    });

    const done = runWssTunnel(ws as unknown as WebSocket, { host: "example.test", port: 443 });
    await tick();
    ws.emitMessage("not-binary");
    await done;

    expect(ws.closeCodes).toContain(1002);
  });

  it("wss tunnel reports target connect failure", async () => {
    const ws = new FakeWebSocket();
    mocks.connect.mockImplementation(() => {
      throw new Error("connect failed");
    });

    await runWssTunnel(ws as unknown as WebSocket, { host: "example.test", port: 443 });

    expect(ws.sentText()).toContain("ERR connect_failed\n");
    expect(ws.closeCodes).toContain(1011);
  });
});

function env(overrides: Partial<{ AUTH_SECRET?: string; AUTH_WINDOW_SECONDS?: string; DIRECT_BEARER?: string }> = {}) {
  return { AUTH_SECRET: "secret", AUTH_WINDOW_SECONDS: "120", DIRECT_BEARER: "direct-secret", ...overrides };
}

function executionContext() {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil(promise: Promise<unknown>) {
      promises.push(promise);
    },
    passThroughOnException() {
      // Not used by the worker.
    },
  } as ExecutionContext & { promises: Promise<unknown>[] };
}

class FakeWebSocket {
  readyState: number = WebSocket.OPEN;
  binaryType = "arraybuffer";
  closeCodes: number[] = [];
  private readonly handlers = new Map<string, Array<(event: { data?: unknown }) => void>>();
  private readonly sent: Array<string | Uint8Array> = [];

  addEventListener(type: string, handler: (event: { data?: unknown }) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  send(data: string | Uint8Array) {
    this.sent.push(data);
  }

  close(code = 1000) {
    this.closeCodes.push(code);
    this.readyState = WebSocket.CLOSED;
    for (const handler of this.handlers.get("close") ?? []) {
      handler({});
    }
  }

  emitMessage(data: unknown) {
    for (const handler of this.handlers.get("message") ?? []) {
      handler({ data });
    }
  }

  sentText(): string {
    return this.sent
      .map((value) => (typeof value === "string" ? value : new TextDecoder().decode(value)))
      .join("");
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function bearer(
  secret: string,
  method: string,
  path: string,
  claims: {
    op: "dial" | "payload";
    host: string;
    port: number;
    ts: number;
    secure_transport?: "off" | "on";
    write_close_after_ms?: number;
  },
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(claims));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: new TextEncoder().encode(`${method}\n${path}`),
      },
      key,
      plaintext,
    ),
  );
  const token = new Uint8Array(1 + nonce.byteLength + ciphertext.byteLength);
  token[0] = 0x02;
  token.set(nonce, 1);
  token.set(ciphertext, 13);
  return `Bearer ${base64UrlEncode(token)}`;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cf-socks auth v2\n${secret}`));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt"]);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
