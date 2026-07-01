import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("cloudflare:sockets", () => ({
  connect: mocks.connect,
}));

import directConnectWorker from "../src/profiles/direct-connect";
import fullWorker from "../src/profiles/full";
import urlFullWorker from "../src/profiles/url-full";
import wssOnlyWorker from "../src/profiles/wss-only";

describe("worker profiles", () => {
  beforeEach(() => {
    mocks.connect.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("full exposes wss, payload, direct, and meta contracts", async () => {
    expect(await status(fullWorker, "https://worker.test/wss", { headers: { authorization: await wssAuth() } })).toBe(426);
    expect(await status(fullWorker, "https://worker.test/h2", { method: "POST" })).toBe(404);
    expect(await status(fullWorker, "https://worker.test/h3", { method: "POST" })).toBe(404);
    expect(await status(fullWorker, "https://worker.test/direct/example.test/80", { method: "POST" })).toBe(404);
    expect(await status(fullWorker, "https://worker.test/direct-url?target=tcp%3A%2F%2F1.1.1.1%3A80", { method: "POST" })).toBe(404);
    expect(await status(fullWorker, "https://worker.test/__meta", { headers: { authorization: "Bearer direct-secret" } })).toBe(200);
  });

  it("wss-only exposes only the wss contract", async () => {
    expect(await status(wssOnlyWorker, "https://worker.test/wss", { headers: { authorization: await wssAuth() } })).toBe(426);
    expect(await empty404(wssOnlyWorker, "https://worker.test/h2", { method: "POST" })).toBe(true);
    expect(await empty404(wssOnlyWorker, "https://worker.test/h3", { method: "POST" })).toBe(true);
    expect(await empty404(wssOnlyWorker, "https://worker.test/direct/example.test/80", { method: "POST" })).toBe(true);
    expect(await empty404(wssOnlyWorker, "https://worker.test/direct-url?target=tcp%3A%2F%2F1.1.1.1%3A80", { method: "POST" })).toBe(true);
    expect(await empty404(wssOnlyWorker, "https://worker.test/__meta", { headers: { authorization: "Bearer direct-secret" } })).toBe(true);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("direct-connect exposes only the direct connect contract", async () => {
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("direct-response"));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      close: vi.fn(() => Promise.resolve()),
    });

    const ctx = executionContext();
    const direct = await directConnectWorker.fetch(
      new Request("https://worker.test/direct/example.test/80", {
        method: "POST",
        headers: { authorization: "Bearer direct-secret" },
      }),
      env(),
      ctx,
    );
    expect(direct.status).toBe(200);
    expect(await direct.text()).toBe("direct-response");
    expect(mocks.connect).toHaveBeenCalledWith(
      { hostname: "example.test", port: 80 },
      { secureTransport: "off", allowHalfOpen: true },
    );

    mocks.connect.mockClear();
    expect(await empty404(directConnectWorker, "https://worker.test/wss", { headers: { authorization: await wssAuth() } })).toBe(true);
    expect(await empty404(directConnectWorker, "https://worker.test/h2", { method: "POST" })).toBe(true);
    expect(await empty404(directConnectWorker, "https://worker.test/h3", { method: "POST" })).toBe(true);
    expect(await empty404(directConnectWorker, "https://worker.test/direct-url?target=tcp%3A%2F%2F1.1.1.1%3A80", { method: "POST" })).toBe(true);
    expect(await empty404(directConnectWorker, "https://worker.test/__meta", { headers: { authorization: "Bearer direct-secret" } })).toBe(true);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("url-full exposes only the URL ingress with connect and fetch egress", async () => {
    mocks.connect.mockReturnValue({
      opened: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("url-connect-response"));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      close: vi.fn(() => Promise.resolve()),
    });

    const connectResponse = await urlFullWorker.fetch(
      new Request("https://worker.test/direct-url?target=tcp%3A%2F%2F1.1.1.1%3A80", {
        method: "POST",
        headers: { authorization: "Bearer direct-secret" },
      }),
      env(),
      executionContext(),
    );
    expect(connectResponse.status).toBe(200);
    expect(await connectResponse.text()).toBe("url-connect-response");
    expect(mocks.connect).toHaveBeenCalledWith(
      { hostname: "1.1.1.1", port: 80 },
      { secureTransport: "off", allowHalfOpen: true },
    );

    const fetchMock = vi.fn(async () => new Response("url-fetch-response", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const fetchResponse = await urlFullWorker.fetch(
      new Request("https://worker.test/direct-url?target=https%3A%2F%2Fexample.test%2F", {
        headers: { authorization: "Bearer direct-secret" },
      }),
      env(),
      executionContext(),
    );
    expect(fetchResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mocks.connect.mockClear();
    expect(await empty404(urlFullWorker, "https://worker.test/wss", { headers: { authorization: await wssAuth() } })).toBe(true);
    expect(await empty404(urlFullWorker, "https://worker.test/h2", { method: "POST" })).toBe(true);
    expect(await empty404(urlFullWorker, "https://worker.test/h3", { method: "POST" })).toBe(true);
    expect(await empty404(urlFullWorker, "https://worker.test/direct/example.test/80", { method: "POST" })).toBe(true);
    expect(await empty404(urlFullWorker, "https://worker.test/__meta", { headers: { authorization: "Bearer direct-secret" } })).toBe(true);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

async function status(
  worker: typeof fullWorker,
  url: string,
  init: RequestInit = {},
): Promise<number> {
  const response = await worker.fetch(new Request(url, init), env(), executionContext());
  return response.status;
}

async function empty404(worker: typeof fullWorker, url: string, init: RequestInit = {}): Promise<boolean> {
  const response = await worker.fetch(new Request(url, init), env(), executionContext());
  return response.status === 404 && (await response.text()) === "";
}

function env() {
  return { AUTH_SECRET: "secret", AUTH_WINDOW_SECONDS: "120", DIRECT_BEARER: "direct-secret" };
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

function wssAuth(): Promise<string> {
  return bearer("secret", "GET", "/wss", {
    op: "dial",
    host: "example.test",
    port: 443,
    ts: Math.floor(Date.now() / 1000),
  });
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
