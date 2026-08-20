/**
 * Shared execution plumbing for user-defined Custom APIs: auth header
 * assembly, SSRF-checked bounded fetch, and redacted request previews for
 * the test console.
 */

import { assertSafeProviderUrl, redactSecrets } from "@/ai/security";
import type { ProviderConfig } from "../providerSession";
import type { CustomApiConfig } from "./config";

const REQUEST_TIMEOUT_MS = 90_000;
export const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

export class CustomApiError extends Error {
  readonly safeMessage: string;
  readonly status: number;

  constructor(safeMessage: string, status = 502) {
    super(safeMessage);
    this.safeMessage = safeMessage;
    this.status = status;
  }
}

export function buildHeaders(config: ProviderConfig, custom: CustomApiConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const header of custom.headers) headers[header.name] = header.value;
  switch (custom.auth.mode) {
    case "bearer":
      headers.Authorization = `Bearer ${config.apiKey}`;
      break;
    case "header":
      headers[custom.auth.header!] = config.apiKey;
      break;
    case "none":
      break;
  }
  return headers;
}

/** Fetch with timeout + SSRF validation on the (possibly runtime-built) URL. */
export async function customFetch(
  url: string,
  init: RequestInit,
  control: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response> {
  try {
    assertSafeProviderUrl(url);
  } catch (error) {
    throw new CustomApiError(error instanceof Error ? error.message : "Unsafe URL", 400);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), control.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = control.signal ? AbortSignal.any([controller.signal, control.signal]) : controller.signal;
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (control.signal?.aborted) throw new CustomApiError("Agent planning was cancelled", 499);
      throw new CustomApiError("Timed out", 504);
    }
    throw new CustomApiError("Endpoint unreachable", 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function readJsonBounded(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new CustomApiError("Response too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new CustomApiError("Provider returned a non-JSON response");
  }
}

export async function customErrorFrom(response: Response, apiKey?: string): Promise<CustomApiError> {
  if (response.status === 401 || response.status === 403) {
    return new CustomApiError("Authentication failed — check the API key", 401);
  }
  if (response.status === 404) {
    return new CustomApiError("Endpoint or model not found — check the URL and model name", 404);
  }
  const text = await response.text().catch(() => "");
  return new CustomApiError(
    `Provider error (HTTP ${response.status})${text ? `: ${scrub(text, apiKey).slice(0, 200)}` : ""}`,
  );
}

/** Redact env secrets AND the user's BYOK key (which is not in env). */
function scrub(text: string, apiKey?: string): string {
  const base = redactSecrets(text);
  return apiKey && apiKey.length >= 4 ? base.split(apiKey).join("[REDACTED]") : base;
}

/** Debug preview of a request with every secret-bearing header redacted. */
export function previewRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  config: ProviderConfig,
): { method: string; url: string; headers: Record<string, string>; body: unknown } {
  const secretHeaders = new Set(["authorization", (config.custom?.auth.header ?? "").toLowerCase()]);
  const safeHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    // Auth headers are redacted wholesale; every other header value is still
    // scrubbed in case the user pasted the key into a custom header.
    safeHeaders[name] = secretHeaders.has(name.toLowerCase()) ? "[REDACTED]" : scrub(value, config.apiKey);
  }
  const bodyText = scrub(JSON.stringify(body ?? null), config.apiKey);
  return { method, url, headers: safeHeaders, body: JSON.parse(bodyText) };
}
