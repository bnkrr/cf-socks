import { describe, expect, it } from "vitest";
import { NonceCache, parseHandshake, signHandshake, verifyHandshake } from "../worker/src/auth";

describe("PSK handshake", () => {
  it("signs and verifies a valid handshake", async () => {
    const base = { host: "httpforever.com", port: 80, ts: 1_780_000_000, nonce: "nonce_1234567890" };
    const mac = await signHandshake("secret", base);
    const handshake = { v: 1 as const, ...base, mac };

    await expect(verifyHandshake(handshake, { secret: "secret", nowSeconds: base.ts })).resolves.toBe(true);
  });

  it("rejects wrong secrets and stale timestamps", async () => {
    const base = { host: "www.google.com", port: 443, ts: 1_780_000_000, nonce: "nonce_1234567890" };
    const mac = await signHandshake("secret", base);
    const handshake = { v: 1 as const, ...base, mac };

    await expect(verifyHandshake(handshake, { secret: "other", nowSeconds: base.ts })).resolves.toBe(false);
    await expect(verifyHandshake(handshake, { secret: "secret", nowSeconds: base.ts + 121 })).resolves.toBe(false);
  });

  it("rejects nonce replay inside the local cache", async () => {
    const base = { host: "github.com", port: 22, ts: 1_780_000_000, nonce: "nonce_1234567890" };
    const mac = await signHandshake("secret", base);
    const handshake = { v: 1 as const, ...base, mac };
    const cache = new NonceCache();

    await expect(verifyHandshake(handshake, { secret: "secret", nowSeconds: base.ts, nonceCache: cache })).resolves.toBe(true);
    await expect(verifyHandshake(handshake, { secret: "secret", nowSeconds: base.ts, nonceCache: cache })).resolves.toBe(false);
  });

  it("parses only structurally valid handshakes", async () => {
    const parsed = parseHandshake(
      JSON.stringify({
        v: 1,
        host: "host.example",
        port: 443,
        ts: 1_780_000_000,
        nonce: "nonce_1234567890",
        mac: "mac_1234567890",
      }),
    );

    expect(parsed?.host).toBe("host.example");
    expect(parseHandshake("{")).toBeNull();
    expect(parseHandshake(JSON.stringify({ ...parsed, port: 0 }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ ...parsed, host: "bad\nhost" }))).toBeNull();
  });
});
