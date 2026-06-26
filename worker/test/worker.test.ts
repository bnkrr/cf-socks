import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("cloudflare:sockets", () => ({
  connect: mocks.connect,
}));

import worker from "../src/index";

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
      close: closed,
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
      close: vi.fn(),
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
});

function env() {
  return { AUTH_SECRET: "secret", AUTH_WINDOW_SECONDS: "120" };
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
