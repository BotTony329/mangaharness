/**
 * Google Gemini image generation ("nano banana" family). Chosen as the first
 * real provider because it accepts reference images natively, which is what
 * character-consistent pose/expression generation needs.
 */

import { redactSecrets } from "../security";
import {
  ProviderError,
  type ImageGenerationProvider,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ProviderStatus,
} from "../types";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.5-flash-image";
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 30 * 1024 * 1024;

interface GeminiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function geminiConfigFromEnv(): GeminiConfig | null {
  const apiKey = process.env.GEMINI_API_KEY || process.env.IMAGE_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: process.env.IMAGE_API_BASE_URL || DEFAULT_BASE_URL,
    model: process.env.IMAGE_MODEL || DEFAULT_MODEL,
  };
}

export function createGeminiProvider(config: GeminiConfig): ImageGenerationProvider {
  return {
    id: "gemini",
    label: "Google Gemini",
    model: config.model,
    capabilities: {
      textToImage: true,
      referenceImage: true,
      imageVariation: true,
      // Gemini returns opaque images; we do not fake transparency.
      transparentOutput: false,
      asyncGeneration: false,
    },

    async testConnection(): Promise<ProviderStatus> {
      const response = await geminiFetch(config, `/v1beta/models/${config.model}`, { method: "GET" });
      if (response.ok) return { ok: true };
      return { ok: false, message: await safeErrorMessage(response) };
    },

    async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      const parts: unknown[] = [];
      for (const ref of request.referenceImages ?? []) {
        parts.push({ inline_data: { mime_type: ref.mimeType, data: ref.data.toString("base64") } });
      }
      parts.push({ text: request.prompt });

      const response = await geminiFetch(config, `/v1beta/models/${config.model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
      });

      if (!response.ok) {
        throw new ProviderError(await safeErrorMessage(response), mapStatus(response.status));
      }

      const body = (await readBounded(response)) as {
        candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
      };
      const imagePart = body.candidates
        ?.flatMap((c) => c.content?.parts ?? [])
        .find((part) => part.inlineData?.data);
      if (!imagePart?.inlineData?.data) {
        throw new ProviderError("Provider returned no image (the prompt may have been refused)");
      }
      return {
        mimeType: imagePart.inlineData.mimeType ?? "image/png",
        data: Buffer.from(imagePart.inlineData.data, "base64"),
      };
    },
  };
}

async function geminiFetch(config: GeminiConfig, path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, "x-goog-api-key": config.apiKey },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("Generation timed out", 504);
    }
    throw new ProviderError("Provider temporarily unavailable", 502);
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new ProviderError("Provider response too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("Invalid image response from provider");
  }
}

function mapStatus(status: number): number {
  if (status === 401 || status === 403) return 401;
  if (status === 429) return 429;
  return 502;
}

/** Provider error bodies can echo request details — redact before surfacing. */
async function safeErrorMessage(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) return "Authentication failed — check the API key";
  if (response.status === 429) return "Provider rate limit reached — try again shortly";
  const text = await response.text().catch(() => "");
  const redacted = redactSecrets(text).slice(0, 300);
  return `Provider error (HTTP ${response.status})${redacted ? `: ${redacted}` : ""}`;
}
