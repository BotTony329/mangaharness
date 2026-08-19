/**
 * Generic OpenAI-compatible images adapter (POST {base}/images/generations).
 * Lets the studio point at any compatible gateway without code changes.
 * Deliberately minimal: text-to-image only, no reference-image support —
 * the UI adapts to the declared capabilities instead of pretending.
 */

import { assertSafeProviderUrl, redactSecrets } from "../security";
import {
  ProviderError,
  type ImageGenerationProvider,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ProviderStatus,
} from "../types";

const REQUEST_TIMEOUT_MS = 90_000;

interface GenericRestConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function genericRestConfigFromEnv(): GenericRestConfig | null {
  const apiKey = process.env.IMAGE_API_KEY;
  const baseUrl = process.env.IMAGE_API_BASE_URL;
  if (!apiKey || !baseUrl) return null;
  return { apiKey, baseUrl, model: process.env.IMAGE_MODEL || "" };
}

export function createGenericRestProvider(config: GenericRestConfig): ImageGenerationProvider {
  // Validated at construction so a bad URL fails at configuration time, not mid-generation.
  const base = assertSafeProviderUrl(config.baseUrl).toString().replace(/\/$/, "");

  return {
    id: "generic-rest",
    label: "Generic REST (OpenAI-compatible)",
    model: config.model,
    capabilities: {
      textToImage: true,
      referenceImage: false,
      imageVariation: false,
      transparentOutput: false,
      asyncGeneration: false,
    },

    async testConnection(): Promise<ProviderStatus> {
      const response = await boundedFetch(`${base}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      if (response.ok) return { ok: true };
      return { ok: false, message: await safeErrorMessage(response) };
    },

    async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      const size = request.width && request.height ? `${request.width}x${request.height}` : "1024x1024";
      const response = await boundedFetch(`${base}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...(config.model ? { model: config.model } : {}),
          prompt: request.prompt,
          n: 1,
          size,
          response_format: "b64_json",
        }),
      });
      if (!response.ok) {
        throw new ProviderError(await safeErrorMessage(response), response.status === 401 ? 401 : 502);
      }
      const body = (await response.json().catch(() => null)) as { data?: { b64_json?: string }[] } | null;
      const b64 = body?.data?.[0]?.b64_json;
      if (!b64) throw new ProviderError("Invalid image response from provider");
      return { mimeType: "image/png", data: Buffer.from(b64, "base64") };
    },
  };
}

async function boundedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("Generation timed out", 504);
    }
    throw new ProviderError("Provider temporarily unavailable", 502);
  } finally {
    clearTimeout(timer);
  }
}

async function safeErrorMessage(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) return "Authentication failed — check the API key";
  const text = await response.text().catch(() => "");
  return `Provider error (HTTP ${response.status})${text ? `: ${redactSecrets(text).slice(0, 300)}` : ""}`;
}
