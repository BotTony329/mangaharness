/**
 * BYOK provider configuration — the harness does not own a fixed AI vendor.
 *
 * Users configure their own agent + image providers in AI Settings; configs
 * are encrypted into HttpOnly cookies (see secretBox.ts). Resolution order:
 *
 *   1. session (user's BYOK cookie)
 *   2. deployment environment variables (optional operator fallback)
 *   3. not configured
 *
 * Credentials are never stored in project data and never returned to the
 * browser — status endpoints get the summaries built here, which carry no key.
 */

import { z } from "zod";
import type { NextRequest, NextResponse } from "next/server";
import { assertSafeProviderUrl } from "@/ai/security";
import { customApiSchema, validateCustomApi, type CustomApiConfig } from "./customApi/config";
import { openSecret, sealSecret } from "./secretBox";

export const AGENT_COOKIE = "ms_agent_provider";
export const IMAGE_COOKIE = "ms_image_provider";

export type ProviderKind = "agent" | "image";

// "custom" is the universal, declarative provider type — presets are
// conveniences layered on top, never the capability boundary.
const agentTypes = ["custom", "openai-compatible", "anthropic-compatible", "gemini"] as const;
// "generic-rest" is a legacy alias for openai-compatible image endpoints.
const imageTypes = ["custom", "gemini", "openai-compatible", "generic-rest"] as const;

export type AgentProviderType = (typeof agentTypes)[number];
export type ImageProviderType = (typeof imageTypes)[number];

export interface ProviderConfig {
  kind: ProviderKind;
  providerType: string;
  name?: string;
  /** For custom providers this is the full request endpoint URL. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Declarative API description — present when providerType === "custom". */
  custom?: CustomApiConfig;
}

export interface ResolvedProvider {
  config: ProviderConfig;
  source: "session" | "deployment";
}

/** Base URLs users usually don't need to type. */
export const DEFAULT_BASE_URLS: Record<string, string> = {
  gemini: "https://generativelanguage.googleapis.com",
  "anthropic-compatible": "https://api.anthropic.com",
};

// ─── Save payload validation ────────────────────────────────────────────────

export const configPayloadSchema = z.object({
  kind: z.enum(["agent", "image"]),
  providerType: z.string().min(1).max(40),
  name: z.string().max(60).optional(),
  baseUrl: z.string().max(1024).optional(),
  /** Omitted on save = keep the previously stored key (replace-fields flow). */
  apiKey: z.string().min(4).max(4096).optional(),
  model: z.string().min(1).max(200),
  custom: customApiSchema.optional(),
});

export type ConfigPayload = z.infer<typeof configPayloadSchema>;

/**
 * Validate a payload into a full config. `existing` supplies the kept API key
 * when the user edits other fields without re-entering the secret.
 */
export function buildProviderConfig(payload: ConfigPayload, existing: ProviderConfig | null): ProviderConfig {
  const allowed: readonly string[] = payload.kind === "agent" ? agentTypes : imageTypes;
  if (!allowed.includes(payload.providerType)) {
    throw new Error(`Unsupported ${payload.kind} provider type: ${payload.providerType}`);
  }
  const baseUrl = (payload.baseUrl?.trim() || DEFAULT_BASE_URLS[payload.providerType]) ?? "";
  if (!baseUrl) throw new Error("Base URL is required for this provider type");
  assertSafeProviderUrl(baseUrl); // SSRF guard on every user-supplied endpoint

  const isCustom = payload.providerType === "custom";
  if (isCustom) {
    if (!payload.custom) throw new Error("Custom API configuration is required");
    validateCustomApi(payload.custom, payload.kind);
  }

  const apiKey = payload.apiKey ?? existing?.apiKey ?? "";
  // Custom APIs with auth mode "none" legitimately have no key.
  if (!apiKey && !(isCustom && payload.custom?.auth.mode === "none")) {
    throw new Error("API key is required");
  }

  const config: ProviderConfig = {
    kind: payload.kind,
    providerType: payload.providerType === "generic-rest" ? "openai-compatible" : payload.providerType,
    name: payload.name?.trim() || undefined,
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey,
    model: payload.model.trim(),
    custom: isCustom ? payload.custom : undefined,
  };

  // Cookies cap at ~4KB; fail loudly instead of silently truncating a config.
  if (JSON.stringify(config).length > 3500) {
    throw new Error("Configuration too large — shorten the request template or headers");
  }
  return config;
}

// ─── Cookie round-trip ──────────────────────────────────────────────────────

export function cookieNameFor(kind: ProviderKind): string {
  return kind === "agent" ? AGENT_COOKIE : IMAGE_COOKIE;
}

export function readSessionConfig(request: NextRequest, kind: ProviderKind): ProviderConfig | null {
  const sealed = request.cookies.get(cookieNameFor(kind))?.value;
  if (!sealed) return null;
  const opened = openSecret(sealed);
  if (!opened) return null;
  try {
    const parsed = JSON.parse(opened) as ProviderConfig;
    const hasCredential = Boolean(parsed.apiKey) || parsed.custom?.auth.mode === "none";
    return parsed.kind === kind && hasCredential && parsed.baseUrl && parsed.model ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSessionConfig(response: NextResponse, config: ProviderConfig): void {
  response.cookies.set(cookieNameFor(config.kind), sealSecret(JSON.stringify(config)), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearSessionConfig(response: NextResponse, kind: ProviderKind): void {
  response.cookies.set(cookieNameFor(kind), "", { httpOnly: true, path: "/", maxAge: 0 });
}

// ─── Resolution: session first, deployment env second ───────────────────────

export function resolveProvider(request: NextRequest, kind: ProviderKind): ResolvedProvider | null {
  const session = readSessionConfig(request, kind);
  if (session) return { config: session, source: "session" };
  const env = kind === "agent" ? envAgentConfig() : envImageConfig();
  return env ? { config: env, source: "deployment" } : null;
}

export function envAgentConfig(): ProviderConfig | null {
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) return null;
  return {
    kind: "agent",
    providerType: "openai-compatible",
    baseUrl: (process.env.AGENT_API_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""),
    apiKey,
    model: process.env.AGENT_MODEL || "deepseek-chat",
  };
}

export function envImageConfig(): ProviderConfig | null {
  const selected = process.env.IMAGE_PROVIDER || "gemini";
  if (selected === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY || process.env.IMAGE_API_KEY;
    if (!apiKey) return null;
    return {
      kind: "image",
      providerType: "gemini",
      baseUrl: (process.env.IMAGE_API_BASE_URL || DEFAULT_BASE_URLS.gemini).replace(/\/$/, ""),
      apiKey,
      model: process.env.IMAGE_MODEL || "gemini-2.5-flash-image",
    };
  }
  const apiKey = process.env.IMAGE_API_KEY;
  const baseUrl = process.env.IMAGE_API_BASE_URL;
  if (!apiKey || !baseUrl) return null;
  return {
    kind: "image",
    providerType: "openai-compatible",
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey,
    model: process.env.IMAGE_MODEL || "",
  };
}

// ─── Safe status (what the browser is allowed to know) ──────────────────────

export interface ProviderSummary {
  configured: boolean;
  source?: "session" | "deployment";
  providerType?: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  /** Non-secret API description (custom providers) so users can re-edit it. */
  custom?: CustomApiConfig;
}

/** Never include apiKey here — not even masked. */
export function summarize(resolved: ResolvedProvider | null): ProviderSummary {
  if (!resolved) return { configured: false };
  const { config, source } = resolved;
  return {
    configured: true,
    source,
    providerType: config.providerType,
    name: config.name,
    baseUrl: config.baseUrl,
    model: config.model,
    // The custom block is declarative non-secret configuration; the key
    // lives only in ProviderConfig.apiKey, which never enters a summary.
    custom: config.custom,
  };
}
