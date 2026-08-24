/**
 * OpenAI-compatible images adapter (POST {base}/images/generations).
 *
 * Capability-driven: the payload is BUILT from the model capability registry
 * (imageModels.ts), never by spreading the normalized request. A key that the
 * model does not declare support for is simply absent — e.g. gpt-image-1
 * never sees response_format (it answers HTTP 400 "Unknown parameter").
 * Unknown models keep the legacy conservative shape so existing
 * OpenAI-compatible gateways don't break. All egress goes through the
 * hardened outboundFetch boundary.
 */

import { assertSafeProviderUrl, redactSecrets } from "../security";
import { outboundFetch, readBodyText, UnsafeOutboundUrlError } from "@/server/outboundFetch";
import { capabilitiesForModel, snapSize, type ImageModelCapabilities } from "../imageModels";
import {
  ProviderError,
  type ImageGenerationProvider,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ProviderStatus,
} from "../types";

const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  name?: string;
}

/**
 * Pure request builder — testable without network. Emits ONLY the keys the
 * model declares; unsupported requested features fail here, before any call.
 */
export function buildImagePayload(
  request: Pick<ImageGenerationRequest, "prompt" | "width" | "height" | "transparentBackground" | "referenceImages">,
  model: string,
  capabilities: ImageModelCapabilities,
): Record<string, unknown> {
  if (request.referenceImages?.length && !capabilities.referenceImages) {
    throw new ProviderError("Selected model does not support reference images", 400, {
      provider: "OpenAI-compatible",
      model,
    });
  }
  if (request.transparentBackground && !capabilities.background) {
    throw new ProviderError("Selected model does not support transparent background", 400, {
      provider: "OpenAI-compatible",
      model,
    });
  }

  const payload: Record<string, unknown> = { prompt: request.prompt };
  if (model) payload.model = model;
  if (capabilities.multipleImages) payload.n = 1;

  const size = snapSize(request.width, request.height, capabilities);
  if (size) payload.size = size;

  if (request.transparentBackground) {
    payload.background = "transparent";
    payload.output_format = "png";
  }
  if (capabilities.responseFormat && capabilities.outputTypes.includes("base64")) {
    payload.response_format = "b64_json";
  }
  return payload;
}

/** Normalize OpenAI-shaped responses: b64_json inline, or a URL to download. */
export async function parseImageResponse(
  response: Response,
  fetchImage: (url: string) => Promise<Buffer>,
): Promise<ImageGenerationResult> {
  const text = await readBodyText(response, MAX_RESPONSE_BYTES).catch(() => null);
  let body: { data?: { b64_json?: string; url?: string }[] } | null = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ProviderError("Invalid image response from provider");
    }
  }
  const first = body?.data?.[0];
  if (first?.b64_json) return { mimeType: "image/png", data: Buffer.from(first.b64_json, "base64") };
  if (first?.url) return { mimeType: "image/png", data: await fetchImage(first.url) };
  throw new ProviderError("Provider returned no image");
}

export function createGenericRestProvider(config: OpenAICompatibleConfig): ImageGenerationProvider {
  // Validated at construction so a bad URL fails at configuration time, not mid-generation.
  const base = assertSafeProviderUrl(config.baseUrl).toString().replace(/\/$/, "");
  const modelCapabilities = capabilitiesForModel(config.model);

  return {
    id: "generic-rest",
    label: "OpenAI-compatible",
    model: config.model,
    capabilities: {
      textToImage: modelCapabilities.textToImage,
      supportsReferenceImage: modelCapabilities.referenceImages,
      supportsTransparentBackground: modelCapabilities.background,
      supportsImageEditing: modelCapabilities.imageEditing,
      referenceImage: modelCapabilities.referenceImages,
      imageVariation: modelCapabilities.imageEditing,
      transparentOutput: modelCapabilities.background,
      asyncGeneration: false,
    },

    async testConnection(): Promise<ProviderStatus> {
      const response = await boundedFetch(`${base}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      if (response.ok) return { ok: true };
      return { ok: false, message: await safeErrorMessage(response, config.apiKey) };
    },

    async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      const payload = buildImagePayload(request, config.model, modelCapabilities);
      request.trace?.("outbound_request_start", {
        provider: "generic-rest",
        operation: "generate_image",
        endpointPath: "/images/generations",
        model: config.model,
        capabilityResponseFormat: modelCapabilities.responseFormat,
        capabilityBackground: modelCapabilities.background,
      });
      const started = Date.now();
      const response = await boundedFetch(`${base}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      request.trace?.("outbound_response_received", {
        provider: "generic-rest",
        httpStatus: response.status,
        durationMs: Date.now() - started,
      });
      if (!response.ok) {
        throw new ProviderError(await safeErrorMessage(response, config.apiKey), mapStatus(response.status), {
          provider: "OpenAI-compatible",
          model: config.model || "default",
          endpoint: "/images/generations",
          httpStatus: response.status,
        });
      }
      const result = await parseImageResponse(response, downloadImage);
      request.trace?.("provider_response_parsed", { provider: "generic-rest", imageFound: true });
      return result;
    },
  };
}

async function downloadImage(url: string): Promise<Buffer> {
  const response = await boundedFetch(url, { method: "GET" });
  if (!response.ok) throw new ProviderError("Could not download the generated image");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) throw new ProviderError("Generated image too large");
  return bytes;
}

function mapStatus(status: number): number {
  if (status === 401 || status === 403) return 401;
  if (status === 400 || status === 404) return status;
  if (status === 429) return 429;
  return 502;
}

async function boundedFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await outboundFetch(url, init, { timeoutMs: REQUEST_TIMEOUT_MS });
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

async function safeErrorMessage(response: Response, apiKey?: string): Promise<string> {
  if (response.status === 401 || response.status === 403) return "Authentication failed — check the API key";
  if (response.status === 429) return "Provider rate limit reached — try again shortly";
  const text = await readBodyText(response, MAX_ERROR_BODY_BYTES).catch(() => "");
  const redacted = redactSecrets(text);
  const scrubbed = apiKey && apiKey.length >= 4 ? redacted.split(apiKey).join("[redacted]") : redacted;
  return `Provider error (HTTP ${response.status})${scrubbed ? `: ${scrubbed.slice(0, 300)}` : ""}`;
}
