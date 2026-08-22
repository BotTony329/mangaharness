/**
 * The single network-egress boundary for outbound provider calls.
 *
 * The lexical URL guard in ai/security.ts runs before DNS, so hostnames that
 * *resolve* into private space (numeric IP spellings like 2130706433, or a
 * public name whose DNS points inward) and cross-origin redirects to internal
 * addresses would slip past it. Every fetch to a user-configurable URL must go
 * through outboundFetch(); a plain fetch() on such a URL is the SSRF hole.
 *
 * What this adds on top of assertSafeProviderUrl, per hop (redirects included):
 *   1. DNS resolution check — every address the hostname resolves to must be
 *      public (loopback, RFC1918, link-local/metadata, ULA and multicast are
 *      refused).
 *   2. Manual redirect following — each Location hop is re-validated before it
 *      is fetched, so a public endpoint cannot relay a request (and its auth
 *      headers) into a private network.
 *   3. Timeout across the whole redirect chain.
 *
 * Residual risk: a check-then-dial race with DNS rebinding (short-TTL records
 * flipping between public and private) is theoretically still possible; this
 * boundary closes every deterministic bypass without a custom connection
 * dispatcher, which is the accepted trade-off for a BYOK harness.
 */

import { lookup } from "node:dns/promises";
import { assertSafeProviderUrl } from "@/ai/security";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class UnsafeOutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutboundUrlError";
  }
}

export interface OutboundControl {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRedirects?: number;
}

function privateNetworksAllowed(): boolean {
  return process.env.ALLOW_PRIVATE_NETWORKS === "1" && process.env.NODE_ENV !== "production";
}

/** True for addresses a provider fetch must never be able to dial. */
export function isBlockedAddress(address: string): boolean {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is how IPv6 sockets report IPv4 peers.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isBlockedAddress(mapped[1]);
  if (!address.includes(":")) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
      return true; // unparseable as IPv4 → refuse rather than guess
    }
    const [a, b] = octets;
    return (
      a === 0 || // "this" network
      a === 10 || // RFC1918
      a === 127 || // loopback
      (a === 169 && b === 254) || // link-local, incl. cloud metadata endpoints
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) || // RFC1918
      a >= 224 // multicast, reserved, broadcast
    );
  }
  const v6 = address.toLowerCase();
  const first = parseInt(v6.split(":")[0], 16);
  return (
    v6 === "::" || v6 === "::1" || // unspecified + loopback
    (first >= 0xfc00 && first <= 0xfdff) || // unique-local fc00::/7
    (first >= 0xfe80 && first <= 0xfebf) // link-local fe80::/10
  );
}

async function assertOutboundUrlSafe(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = assertSafeProviderUrl(rawUrl);
  } catch (error) {
    throw new UnsafeOutboundUrlError(error instanceof Error ? error.message : "Unsafe outbound URL");
  }
  if (privateNetworksAllowed()) return url;
  // lookup() normalizes exotic IP spellings (decimal/hex/octet hostnames) the
  // same way the dialer will, so we validate the address actually connected to.
  const records = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  for (const { address } of records) {
    if (isBlockedAddress(address)) {
      throw new UnsafeOutboundUrlError("Outbound URL resolves to a private or local address");
    }
  }
  return url;
}

export async function outboundFetch(
  rawUrl: string,
  init: RequestInit,
  { timeoutMs = DEFAULT_TIMEOUT_MS, signal, maxRedirects = DEFAULT_MAX_REDIRECTS }: OutboundControl = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  try {
    let url = await assertOutboundUrlSafe(rawUrl);
    let requestInit = init;
    for (let hop = 0; ; hop++) {
      // Match native fetch semantics: an already-aborted signal rejects
      // instead of dialing — a cancellation during the DNS hop must not be
      // swallowed (a listener registered on a settled signal never fires).
      if (combined.aborted) throw new DOMException("The operation was aborted", "AbortError");
      const response = await fetch(url, { ...requestInit, redirect: "manual", signal: combined });
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get("location");
      // No Location or one hop too many: hand the 3xx back so the caller
      // reports it as a provider error instead of silently following it.
      if (!location || hop >= maxRedirects) return response;
      void response.body?.cancel().catch(() => {});
      url = await assertOutboundUrlSafe(new URL(location, url).toString());
      // 303 always rewrites the method to GET; bodies are plain strings or
      // Buffers here, so re-sending them on 307/308 is safe.
      requestInit = response.status === 303 ? { ...requestInit, method: "GET", body: undefined } : requestInit;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response body with a hard byte cap. Providers are user-configured,
 * so an oversized response must abort the download instead of OOM-ing the
 * function — content-length is checked up front, then the stream itself.
 */
export async function readBodyBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("Response body exceeds the allowed size");
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("Response body exceeds the allowed size");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export async function readBodyText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBodyBytes(response, maxBytes));
}
