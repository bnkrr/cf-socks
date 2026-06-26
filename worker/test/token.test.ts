import { describe, expect, it } from "vitest";
import { NonceCache, verifyBearerToken } from "../src/token";

describe("encrypted bearer token", () => {
  it("decrypts and verifies a valid token", async () => {
    const now = 1_800_000_000;
    const header = await bearer("secret", "POST", "/h2", {
      op: "payload",
      host: "example.test",
      port: 443,
      ts: now,
    });

    await expect(
      verifyBearerToken(header, {
        secret: "secret",
        method: "POST",
        path: "/h2",
        expectedOp: "payload",
        nowSeconds: now,
      }),
    ).resolves.toMatchObject({ op: "payload", host: "example.test", port: 443 });
  });

  it("rejects wrong secret, aad, expiry, op, and replay", async () => {
    const now = 1_800_000_000;
    const header = await bearer("secret", "GET", "/wss", {
      op: "dial",
      host: "example.test",
      port: 443,
      ts: now,
    });

    await expect(
      verifyBearerToken(header, { secret: "other", method: "GET", path: "/wss", expectedOp: "dial", nowSeconds: now }),
    ).resolves.toBeNull();
    await expect(
      verifyBearerToken(header, { secret: "secret", method: "POST", path: "/h2", expectedOp: "dial", nowSeconds: now }),
    ).resolves.toBeNull();
    await expect(
      verifyBearerToken(header, {
        secret: "secret",
        method: "GET",
        path: "/wss",
        expectedOp: "dial",
        nowSeconds: now + 121,
      }),
    ).resolves.toBeNull();
    await expect(
      verifyBearerToken(header, {
        secret: "secret",
        method: "GET",
        path: "/wss",
        expectedOp: "payload",
        nowSeconds: now,
      }),
    ).resolves.toBeNull();

    const cache = new NonceCache();
    await expect(
      verifyBearerToken(header, {
        secret: "secret",
        method: "GET",
        path: "/wss",
        expectedOp: "dial",
        nowSeconds: now,
        nonceCache: cache,
      }),
    ).resolves.not.toBeNull();
    await expect(
      verifyBearerToken(header, {
        secret: "secret",
        method: "GET",
        path: "/wss",
        expectedOp: "dial",
        nowSeconds: now,
        nonceCache: cache,
      }),
    ).resolves.toBeNull();
  });
});

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
