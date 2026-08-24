/**
 * Google Gemini image generation ("nano banana" family). Chosen as the first
 * real provider because it accepts reference images natively, which is what
 * character-consistent pose/expression generation needs.
 */

import { redactSecrets } from "../security";
import { outboundFetch, readBodyText, UnsafeOutboundUrlError } from "@/server/outboundFetch";
import {
  ProviderError,
  type ImageGenerationProvider,
  type ImageEditRequest,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ProviderStatus,
} from "../types";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.5-flash-image";
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 30 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

interface GeminiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  name?: string;
}

export const GEMINI_DEFAULTS = { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL };

export function createGeminiProvider(config: GeminiConfig): ImageGenerationProvider {
  return {
    id: "gemini",
    label: "Google Gemini",
    model: config.model,
    capabilities: {
      textToImage: true,
      supportsReferenceImage: true,
      supportsTransparentBackground: false,
      supportsImageEditing: true,
      // Contract metadata only — the working inline_data path below is untouched.
      reference: { supported: true, transport: "json-inline-base64", maxImages: 3, endpointMode: "same-endpoint" },
      referenceImage: true,
      imageVariation: true,
      // Gemini returns opaque images; we do not fake transparency.
      transparentOutput: false,
      asyncGeneration: false,
    },

    async testConnection(): Promise<ProviderStatus> {
      const response = await geminiFetch(config, `/v1beta/models/${config.model}`, { method: "GET" });
      if (response.ok) return { ok: true };
      return { ok: false, message: await safeErrorMessage(response, config.model, config.apiKey) };
    },

    async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      return runGeminiImageRequest(config, request, "generate_image");
    },

    async editImage(request: ImageEditRequest): Promise<ImageGenerationResult> {
      return runGeminiImageRequest(config, {
        prompt: request.instruction,
        assetType: "character",
        referenceImages: [request.image],
        trace: request.trace,
      }, "edit_image");
    },
  };
}

async function runGeminiImageRequest(
  config: GeminiConfig,
  request: ImageGenerationRequest,
  operation: "generate_image" | "edit_image",
): Promise<ImageGenerationResult> {
  const parts: unknown[] = [];
  for (const ref of request.referenceImages ?? []) {
    parts.push({ inline_data: { mime_type: ref.mimeType, data: ref.data.toString("base64") } });
  }
  parts.push({ text: request.prompt });

  request.trace?.("outbound_request_start", {
    provider: "gemini",
    operation,
    endpointPath: "/v1beta/models/:model:generateContent",
  });
  const response = await geminiFetch(config, `/v1beta/models/${config.model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  });
  request.trace?.("outbound_response_received", { provider: "gemini", httpStatus: response.status });

  if (!response.ok) {
    throw new ProviderError(await safeErrorMessage(response, config.model, config.apiKey), mapStatus(response.status), {
      provider: "Google Gemini",
      model: config.model,
      endpoint: "/v1beta/models/:model:generateContent",
      httpStatus: response.status,
    });
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
  request.trace?.("provider_response_parsed", { provider: "gemini", imageFound: true });
  return {
    mimeType: imagePart.inlineData.mimeType ?? "image/png",
    data: Buffer.from(imagePart.inlineData.data, "base64"),
  };
}

async function geminiFetch(config: GeminiConfig, path: string, init: RequestInit): Promise<Response> {
  try {
    return await outboundFetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, "x-goog-api-key": config.apiKey },
    }, { timeoutMs: REQUEST_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) {
      throw new ProviderError(error.message, 400);
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("Generation timed out", 504);
    }
    throw new ProviderError("Provider temporarily unavailable", 502);
  }
}

async function readBounded(response: Response): Promise<unknown> {
  const text = await readBodyText(response, MAX_RESPONSE_BYTES).catch(() => {
    throw new ProviderError("Provider response too large");
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("Invalid image response from provider");
  }
}

function mapStatus(status: number): number {
  if (status === 401 || status === 403) return 401;
  if (status === 400 || status === 404) return status;
  if (status === 429) return 429;
  return 502;
}

/** Provider error bodies can echo request details — redact before surfacing. */
async function safeErrorMessage(response: Response, model?: string, apiKey?: string): Promise<string> {
  if (response.status === 401 || response.status === 403) return "Authentication failed — check the API key";
  if (response.status === 404) return `Model unavailable: ${model ?? "configured model"}`;
  if (response.status === 429) return "Provider rate limit reached — try again shortly";
  const text = await readBodyText(response, MAX_ERROR_BODY_BYTES).catch(() => "");
  const redacted = scrubByok(redactSecrets(text), apiKey).slice(0, 300);
  return `Provider error (HTTP ${response.status})${redacted ? `: ${redacted}` : ""}`;
}

function scrubByok(text: string, apiKey?: string): string {
  return apiKey && apiKey.length >= 4 ? text.split(apiKey).join("[redacted]") : text;
}
