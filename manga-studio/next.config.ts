import type { NextConfig } from "next";

/**
 * Baseline security headers for the public deployment.
 *
 * The CSP is deliberately modest: the app bundles no third-party scripts,
 * loads images only from its own origin (data:/blob: for canvas work, plus
 * the public Vercel Blob store where generated assets live), and talks to AI
 * providers exclusively through its own API routes — so connect-src stays
 * 'self'. 'unsafe-inline' for scripts/styles is the price of the App Router's
 * inline bootstrap without a nonce middleware; tightening it further would
 * break the app for no real adversary model here.
 */
const isDev = process.env.NODE_ENV === "development";

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.public.blob.vercel-storage.com",
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
