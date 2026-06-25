export const HANDSHAKE_PREFIX = "cf-socks-v1";

export interface Handshake {
  v: 1;
  host: string;
  port: number;
  ts: number;
  nonce: string;
  mac: string;
}

export interface VerifyOptions {
  secret: string;
  nowSeconds?: number;
  windowSeconds?: number;
  nonceCache?: NonceCache;
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

export function parseHandshake(input: unknown): Handshake | null {
  if (typeof input !== "string") {
    return null;
  }

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
    candidate.v !== 1 ||
    typeof candidate.host !== "string" ||
    !isValidHost(candidate.host) ||
    typeof candidate.port !== "number" ||
    !Number.isInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65535 ||
    typeof candidate.ts !== "number" ||
    !Number.isInteger(candidate.ts) ||
    typeof candidate.nonce !== "string" ||
    !isReasonableToken(candidate.nonce) ||
    typeof candidate.mac !== "string" ||
    !isReasonableToken(candidate.mac)
  ) {
    return null;
  }

  return {
    v: 1,
    host: candidate.host,
    port: candidate.port,
    ts: candidate.ts,
    nonce: candidate.nonce,
    mac: candidate.mac,
  };
}

export function handshakeMessage(handshake: Pick<Handshake, "host" | "port" | "ts" | "nonce">): string {
  return `${HANDSHAKE_PREFIX}\n${handshake.host}\n${handshake.port}\n${handshake.ts}\n${handshake.nonce}`;
}

export async function signHandshake(
  secret: string,
  handshake: Pick<Handshake, "host" | "port" | "ts" | "nonce">,
): Promise<string> {
  const key = await hmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(handshakeMessage(handshake)),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

export async function verifyHandshake(handshake: Handshake, options: VerifyOptions): Promise<boolean> {
  const windowSeconds = options.windowSeconds ?? 120;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - handshake.ts) > windowSeconds) {
    return false;
  }

  const actual = base64UrlDecode(handshake.mac);
  if (!actual) {
    return false;
  }

  const key = await hmacKey(options.secret, ["verify"]);
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(actual),
    new TextEncoder().encode(handshakeMessage(handshake)),
  );
  if (!verified) {
    return false;
  }

  if (options.nonceCache && !options.nonceCache.consume(handshake.nonce, handshake.ts + windowSeconds, now)) {
    return false;
  }
  return true;
}

function isValidHost(host: string): boolean {
  if (host.length < 1 || host.length > 253 || host.includes("\n") || host.includes("\r")) {
    return false;
  }
  return /^[A-Za-z0-9._:-]+$/.test(host);
}

function isReasonableToken(value: string): boolean {
  return value.length >= 8 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

async function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
