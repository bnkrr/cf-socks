import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("cloudflare:sockets", () => ({
  connect: mocks.connect,
}));

import worker from "../src/index";
import { runWssTunnel } from "../src/tunnel";

describe("worker endpoints", () => {
  beforeEach(() => {
    mocks.connect.mockReset();
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
  claims: { op: "dial" | "payload"; host: string; port: number; ts: number },
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
