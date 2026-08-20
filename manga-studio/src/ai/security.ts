/**
 * Security helpers for the AI layer: secret redaction and URL validation
 * (SSRF protection for configurable provider endpoints and reference fetches).
 */

const SECRET_ENV_KEYS = [
  "GEMINI_API_KEY",
  "IMAGE_API_KEY",
  "AGENT_API_KEY",
  "BLOB_READ_WRITE_TOKEN",
  "APP_ENCRYPTION_KEY",
] as const;

/**
 * Strip any configured secret value from text that could reach logs or the
 * browser (provider error bodies sometimes echo auth headers back).
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length >= 8) {
      result = result.split(value).join("[redacted]");
    }
  }
  // Belt and braces: redact bearer tokens and long key-looking strings.
  result = result.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, "Bearer [redacted]");
  result = result.replace(/(Authorization["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]");
  result = result.replace(/((?:x-api-key|x-goog-api-key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]");
  result = result.replace(/(key=)[A-Za-z0-9_-]{16,}/g, "$1[redacted]");
  return result;
}

const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // link-local (incl. cloud metadata endpoints)
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // IPv6 unique-local
  /^\[?fe80:/i, // IPv6 link-local
  /\.local$/i,
  /^metadata\.google\.internal$/i,
];

function allowPrivateNetworks(): boolean {
  return process.env.ALLOW_PRIVATE_NETWORKS === "1" && process.env.NODE_ENV !== "production";
}

/**
 * Validate a configurable provider base URL. Production rejects plain HTTP
 * and anything pointing at loopback/private/link-local addresses.
 */
export function assertSafeProviderUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Provider URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Provider URL must use http(s)");
  }
  if (allowPrivateNetworks()) return url;
  if (url.protocol !== "https:") {
    throw new Error("Provider URL must use https");
  }
  if (PRIVATE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
    throw new Error("Provider URL points at a private or local address");
  }
  return url;
}

/**
 * Reference images may only be fetched from our own storage: the Vercel Blob
 * public host or the local dev file route. Anything else is rejected — the
 * server never fetches arbitrary user-supplied URLs.
 */
export function isAllowedReferenceUrl(rawUrl: string): boolean {
  if (rawUrl.startsWith("/api/files/")) return true;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}
