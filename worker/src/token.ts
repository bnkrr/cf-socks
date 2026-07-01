const VERSION = 0x02;
const KEY_PREFIX = "cf-socks auth v2\n";
const DEFAULT_WINDOW_SECONDS = 120;
const MAX_WRITE_CLOSE_AFTER_MS = 600_000;

export interface Claims {
  op: "dial" | "payload";
  host: string;
  port: number;
  ts: number;
  secure_transport?: "off" | "on";
  write_close_after_ms?: number;
}

export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly maxEntries = 4096) {}

  consume(nonce: string, expiresAt: number, now: number): boolean {
    this.cleanup(now);
    if (this.seen.has(nonce)) {
      return false;
    }
    if (this.seen.size >= this.maxEntries) {
      const first = this.seen.keys().next().value;
      if (first !== undefined) {
        this.seen.delete(first);
      }
    }
    this.seen.set(nonce, expiresAt);
    return true;
  }

  private cleanup(now: number): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(nonce);
      }
    }
  }
}

export interface VerifyOptions {
  secret: string;
  method: string;
  path: string;
  expectedOp: Claims["op"];
  nowSeconds?: number;
  windowSeconds?: number;
  nonceCache?: NonceCache;
}

export async function verifyBearerToken(header: string | null, options: VerifyOptions): Promise<Claims | null> {
  const encoded = bearerToken(header);
  if (!encoded) {
    return null;
  }
  const raw = base64UrlDecode(encoded);
  if (!raw || raw.byteLength < 1 + 12 + 16 || raw[0] !== VERSION) {
    return null;
  }
  const nonce = raw.slice(1, 13);
  const ciphertext = raw.slice(13);
  let plaintext: ArrayBuffer;
  try {
    const key = await aesKey(options.secret);
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: new TextEncoder().encode(`${options.method}\n${options.path}`),
      },
      key,
      toArrayBuffer(ciphertext),
    );
  } catch {
    return null;
  }

  const claims = parseClaims(new TextDecoder().decode(plaintext));
  if (!claims || claims.op !== options.expectedOp) {
    return null;
  }

  const windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - claims.ts) > windowSeconds) {
    return null;
  }

  if (options.nonceCache) {
    const nonceKey = base64UrlEncode(nonce);
    if (!options.nonceCache.consume(nonceKey, claims.ts + windowSeconds, now)) {
      return null;
    }
  }
  return claims;
}

function bearerToken(header: string | null): string | null {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) {
    return null;
  }
  const value = header.slice(prefix.length);
  return value.length > 0 ? value : null;
}

function parseClaims(input: string): Claims | null {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.op !== "dial" && candidate.op !== "payload") ||
    typeof candidate.host !== "string" ||
    !isValidHost(candidate.host) ||
    typeof candidate.port !== "number" ||
    !Number.isInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65535 ||
    typeof candidate.ts !== "number" ||
    !Number.isInteger(candidate.ts)
  ) {
    return null;
  }
  const claims: Claims = {
    op: candidate.op,
    host: candidate.host,
    port: candidate.port,
    ts: candidate.ts,
  };
  if ("secure_transport" in candidate) {
    if (candidate.secure_transport !== "off" && candidate.secure_transport !== "on") {
      return null;
    }
    claims.secure_transport = candidate.secure_transport;
  }
  if ("write_close_after_ms" in candidate) {
    if (
      typeof candidate.write_close_after_ms !== "number" ||
      !Number.isInteger(candidate.write_close_after_ms) ||
      candidate.write_close_after_ms < 0 ||
      candidate.write_close_after_ms > MAX_WRITE_CLOSE_AFTER_MS
    ) {
      return null;
    }
    claims.write_close_after_ms = candidate.write_close_after_ms;
  }
  return claims;
}

function isValidHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && !host.includes("\n") && !host.includes("\r");
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(KEY_PREFIX + secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
