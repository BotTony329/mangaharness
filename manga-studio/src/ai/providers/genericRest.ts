/**
 * Generic OpenAI-compatible images adapter (POST {base}/images/generations).
 * Lets the studio point at any compatible gateway without code changes.
 * Deliberately minimal: text-to-image only, no reference-image support —
 * the UI adapts to the declared capabilities instead of pretending.
 */

import { assertSafeProviderUrl, redactSecrets } from "../security";
import { outboundFetch, readBodyText, UnsafeOutboundUrlError } from "@/server/outboundFetch";
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

interface GenericRestConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  name?: string;
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
      supportsReferenceImage: false,
      supportsTransparentBackground: /^gpt-image-/i.test(config.model),
      supportsImageEditing: false,
      referenceImage: false,
      imageVariation: false,
      transparentOutput: /^gpt-image-/i.test(config.model),
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
      const size = request.width && request.height ? `${request.width}x${request.height}` : "1024x1024";
      request.trace?.("outbound_request_start", {
        provider: "generic-rest",
        operation: "generate_image",
        endpointPath: "/images/generations",
      });
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
          ...(request.transparentBackground ? { background: "transparent", output_format: "png" } : {}),
          response_format: "b64_json",
        }),
      });
      request.trace?.("outbound_response_received", { provider: "generic-rest", httpStatus: response.status });
      if (!response.ok) {
        throw new ProviderError(
          await safeErrorMessage(response, config.apiKey),
          response.status === 401 || response.status === 403 ? 401 : response.status === 429 ? 429 : 502,
          {
            provider: "OpenAI-compatible",
            model: config.model || "default",
            endpoint: "/images/generations",
            httpStatus: response.status,
          },
        );
      }
      const bodyText = await readBodyText(response, MAX_RESPONSE_BYTES).catch(() => null);
      const body = bodyText ? (JSON.parse(bodyText).catch(() => null) as { data?: { b64_json?: string }[] } | null) : null;
      const b64 = body?.data?.[0]?.b64_json;
      if (!b64) throw new ProviderError("Invalid image response from provider");
      request.trace?.("provider_response_parsed", { provider: "generic-rest", imageFound: true });
      return { mimeType: "image/png", data: Buffer.from(b64, "base64") };
    },
  };
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
  const text = await readBodyText(response, MAX_ERROR_BODY_BYTES).catch(() => "");
  const redacted = redactSecrets(text);
  const scrubbed = apiKey && apiKey.length >= 4 ? redacted.split(apiKey).join("[redacted]") : redacted;
  return `Provider error (HTTP ${response.status})${scrubbed ? `: ${scrubbed.slice(0, 300)}` : ""}`;
}
