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
  if (request.referenceImages?.length && !capabilities.reference.supported) {
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

/**
 * Reference-conditioned request for gpt-image: multipart/form-data on
 * /images/edits with each reference as an `image[]` file part. Only keys the
 * model supports on edits are included — still no response_format.
 */
export function buildEditsFormData(
  request: Pick<ImageGenerationRequest, "prompt" | "width" | "height" | "transparentBackground" | "referenceImages">,
  model: string,
  capabilities: ImageModelCapabilities,
): FormData {
  const max = capabilities.reference.maxImages ?? 1;
  const references = (request.referenceImages ?? []).slice(0, max);
  if (references.length === 0) throw new ProviderError("Reference edit requires at least one image", 400);
  const form = new FormData();
  if (model) form.set("model", model);
  form.set("prompt", request.prompt);
  const size = snapSize(request.width, request.height, capabilities);
  if (size) form.set("size", size);
  if (request.transparentBackground && capabilities.background) {
    form.set("background", "transparent");
    form.set("output_format", "png");
  }
  for (const [index, ref] of references.entries()) {
    form.append("image[]", new Blob([new Uint8Array(ref.data)], { type: ref.mimeType }), `reference-${index}.png`);
  }
  return form;
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
      supportsReferenceImage: modelCapabilities.reference.supported,
      supportsTransparentBackground: modelCapabilities.background,
      supportsImageEditing: modelCapabilities.imageEditing,
      reference: modelCapabilities.reference,
      referenceImage: modelCapabilities.reference.supported,
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
      // Reference transport contract: gpt-image references travel as multipart
      // files on the edits endpoint; without references the plain generations
      // JSON path is used. The core layer never learns which.
      const withReferences = (request.referenceImages?.length ?? 0) > 0;
      const editsMode = withReferences && modelCapabilities.reference.endpointMode === "edit";
      const body = editsMode
        ? buildEditsFormData(request, config.model, modelCapabilities)
        : JSON.stringify(buildImagePayload(request, config.model, modelCapabilities));
      const endpoint = editsMode ? "/images/edits" : "/images/generations";
      request.trace?.("outbound_request_start", {
        provider: "generic-rest",
        operation: "generate_image",
        endpointPath: endpoint,
        model: config.model,
        referenceAttached: withReferences,
        capabilityResponseFormat: modelCapabilities.responseFormat,
        capabilityBackground: modelCapabilities.background,
      });
      const started = Date.now();
      const response = await boundedFetch(`${base}${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          // FormData sets its own multipart boundary — never hand-set it.
          ...(editsMode ? {} : { "Content-Type": "application/json" }),
        },
        body,
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
