import type { PayloadOptions } from "../shared/types";

const MAX_WRITE_CLOSE_AFTER_MS = 600_000;

export function parsePayloadOptions(url: URL): PayloadOptions | null {
  const secureTransport = parseSecureTransport(url.searchParams.get("tls"));
  if (secureTransport === null) {
    return null;
  }
  const value = url.searchParams.get("write_close_after");
  if (value === null || value === "none") {
    return secureTransport ? { secureTransport } : {};
  }
  const ms = parseDurationMs(value);
  if (ms === null) {
    return null;
  }
  return secureTransport ? { secureTransport, writeCloseAfterMs: ms } : { writeCloseAfterMs: ms };
}

function parseSecureTransport(value: string | null): PayloadOptions["secureTransport"] | null | undefined {
  if (value === null || value === "" || value === "off") {
    return undefined;
  }
  if (value === "on") {
    return "on";
  }
  return null;
}

function parseDurationMs(value: string): number | null {
  if (value === "0") {
    return 0;
  }
  const match = /^([1-9][0-9]*)(ms|s|m)$/.exec(value);
  if (!match) {
    return null;
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : 60_000;
  const ms = amount * multiplier;
  return Number.isSafeInteger(ms) && ms <= MAX_WRITE_CLOSE_AFTER_MS ? ms : null;
}
