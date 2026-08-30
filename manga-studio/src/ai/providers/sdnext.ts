/**
 * SD.Next (Stable Diffusion Next) image generation adapter.
 *
 * Communicates with the SD.Next REST API (public /sdapi/v1/ endpoints).
 * Supports:
 *   - Text-to-Image (/sdapi/v1/txt2img)
 *   - Reference conditioning & Image variation (/sdapi/v1/img2img)
 *   - Image editing (/sdapi/v1/img2img)
 *   - HTTP Basic Auth (for --auth instances), Bearer token, or None (local default)
 *   - Model overrides via override_settings
 */

import { assertSafeProviderUrl, redactSecrets } from "../security";
import { outboundFetch, readBodyText, UnsafeOutboundUrlError } from "@/server/outboundFetch";
import type { ProviderConfig } from "@/server/providerSession";
import {
  ProviderError,
  type ImageEditRequest,
  type ImageGenerationProvider,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ProviderStatus,
} from "../types";

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export function buildSdnextAuthHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey || apiKey.trim() === "") {
    return {};
  }
  const trimmed = apiKey.trim();
  if (trimmed.startsWith("Basic ") || trimmed.startsWith("Bearer ")) {
    return { Authorization: trimmed };
  }
  if (trimmed.includes(":")) {
    const encoded = Buffer.from(trimmed, "utf8").toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }
  return { Authorization: `Bearer ${trimmed}` };
}

export function buildSdnextTxt2ImgPayload(
  request: Pick<ImageGenerationRequest, "prompt" | "negativePrompt" | "width" | "height">,
  model?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: request.prompt,
    negative_prompt: request.negativePrompt || "",
    width: request.width || 832,
    height: request.height || 1216,
    steps: 20,
    cfg_scale: 7.0,
    sampler_name: "UniPC",
    seed: -1,
    batch_size: 1,
    n_iter: 1,
    save_images: false,
    send_images: true,
  };

  if (model && model.trim()) {
    payload.override_settings = { sd_model_checkpoint: model.trim() };
  }

  return payload;
}

export function buildSdnextImg2ImgPayload(
  request: Pick<ImageGenerationRequest, "prompt" | "negativePrompt" | "width" | "height" | "referenceImages">,
  model?: string,
): Record<string, unknown> {
  const references = request.referenceImages ?? [];
  if (references.length === 0) {
    throw new ProviderError("Reference generation requires at least one reference image", 400);
  }

  const base64Image = references[0].data.toString("base64");

  const payload: Record<string, unknown> = {
    prompt: request.prompt,
    negative_prompt: request.negativePrompt || "",
    init_images: [base64Image],
    denoising_strength: 0.65,
    width: request.width || 832,
    height: request.height || 1216,
    steps: 20,
    cfg_scale: 7.0,
    sampler_name: "UniPC",
    seed: -1,
    batch_size: 1,
    n_iter: 1,
    save_images: false,
    send_images: true,
  };

  if (model && model.trim()) {
    payload.override_settings = { sd_model_checkpoint: model.trim() };
  }

  return payload;
}

export async function parseSdnextImageResponse(response: Response): Promise<ImageGenerationResult> {
  const text = await readBodyText(response, MAX_RESPONSE_BYTES).catch(() => null);
  let body: { images?: string[]; image?: string } | null = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ProviderError("Invalid image response from SD.Next");
    }
  }

  const rawImage = body?.images?.[0] ?? body?.image;
  if (!rawImage) {
    throw new ProviderError("SD.Next returned no image");
  }

  // Strip data URI prefix if present (e.g. data:image/png;base64,...)
  const cleanB64 = rawImage.replace(/^data:image\/[a-z]+;base64,/, "");
  return {
    mimeType: "image/png",
    data: Buffer.from(cleanB64, "base64"),
  };
}

export function createSdnextProvider(config: ProviderConfig): ImageGenerationProvider {
  const base = assertSafeProviderUrl(config.baseUrl).toString().replace(/\/$/, "");
  const authHeaders = buildSdnextAuthHeaders(config.apiKey);

  return {
    id: "sdnext",
    label: "SD.Next",
    model: config.model,
    capabilities: {
      textToImage: true,
      supportsReferenceImage: true,
      supportsTransparentBackground: false,
      supportsImageEditing: true,
      reference: {
        supported: true,
        transport: "json-inline-base64",
        maxImages: 1,
        endpointMode: "same-endpoint",
      },
      referenceImage: true,
      imageVariation: true,
      transparentOutput: false,
      asyncGeneration: false,
    },

    async testConnection(): Promise<ProviderStatus> {
      try {
        const response = await boundedFetch(`${base}/sdapi/v1/options`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders,
          },
        });
        if (response.ok) {
          return { ok: true, message: "Connected to SD.Next" };
        }
        return { ok: false, message: await safeErrorMessage(response, config.apiKey) };
      } catch (error) {
        if (error instanceof ProviderError) {
          return { ok: false, message: error.safeMessage };
        }
        return { ok: false, message: "Could not reach SD.Next server" };
      }
    },

    async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      const withReferences = (request.referenceImages?.length ?? 0) > 0;
      const endpoint = withReferences ? "/sdapi/v1/img2img" : "/sdapi/v1/txt2img";
      const payload = withReferences
        ? buildSdnextImg2ImgPayload(request, config.model)
        : buildSdnextTxt2ImgPayload(request, config.model);

      request.trace?.("outbound_request_start", {
        provider: "sdnext",
        operation: withReferences ? "img2img" : "txt2img",
        endpointPath: endpoint,
        model: config.model,
        referenceAttached: withReferences,
      });

      const started = Date.now();
      const response = await boundedFetch(`${base}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify(payload),
      });

      request.trace?.("outbound_response_received", {
        provider: "sdnext",
        httpStatus: response.status,
        durationMs: Date.now() - started,
      });

      if (!response.ok) {
        throw new ProviderError(await safeErrorMessage(response, config.apiKey), mapStatus(response.status), {
          provider: "sdnext",
          model: config.model || "default",
          endpoint,
          httpStatus: response.status,
        });
      }

      const result = await parseSdnextImageResponse(response);
      request.trace?.("provider_response_parsed", { provider: "sdnext", imageFound: true });
      return result;
    },

    async editImage(request: ImageEditRequest): Promise<ImageGenerationResult> {
      const endpoint = "/sdapi/v1/img2img";
      const payload: Record<string, unknown> = {
        prompt: request.instruction,
        negative_prompt: "",
        init_images: [request.image.data.toString("base64")],
        denoising_strength: 0.75,
        steps: 20,
        cfg_scale: 7.0,
        sampler_name: "UniPC",
        seed: -1,
        batch_size: 1,
        n_iter: 1,
        save_images: false,
        send_images: true,
      };

      if (config.model && config.model.trim()) {
        payload.override_settings = { sd_model_checkpoint: config.model.trim() };
      }

      request.trace?.("outbound_request_start", {
        provider: "sdnext",
        operation: "edit_image",
        endpointPath: endpoint,
        model: config.model,
      });

      const started = Date.now();
      const response = await boundedFetch(`${base}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify(payload),
      });

      request.trace?.("outbound_response_received", {
        provider: "sdnext",
        httpStatus: response.status,
        durationMs: Date.now() - started,
      });

      if (!response.ok) {
        throw new ProviderError(await safeErrorMessage(response, config.apiKey), mapStatus(response.status), {
          provider: "sdnext",
          model: config.model || "default",
          endpoint,
          httpStatus: response.status,
        });
      }

      const result = await parseSdnextImageResponse(response);
      request.trace?.("provider_response_parsed", { provider: "sdnext", imageFound: true });
      return result;
    },
  };
}

export async function listSdnextModels(config: ProviderConfig): Promise<string[]> {
  try {
    const base = assertSafeProviderUrl(config.baseUrl).toString().replace(/\/$/, "");
    const authHeaders = buildSdnextAuthHeaders(config.apiKey);
    const response = await boundedFetch(`${base}/sdapi/v1/sd-models`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
    });
    if (!response.ok) return [];
    const text = await readBodyText(response, MAX_RESPONSE_BYTES).catch(() => "[]");
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data
      .map((item) => (typeof item === "object" && item !== null ? item.title || item.model_name || "" : ""))
      .filter((title): title is string => typeof title === "string" && title.length > 0);
  } catch {
    return [];
  }
}

function mapStatus(status: number): number {
  if (status === 401 || status === 403) return 401;
  if (status === 400 || status === 404 || status === 422) return status;
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
      throw new ProviderError("SD.Next generation timed out", 504);
    }
    throw new ProviderError("SD.Next server temporarily unavailable", 502);
  }
}

async function safeErrorMessage(response: Response, apiKey?: string): Promise<string> {
  if (response.status === 401 || response.status === 403) return "Authentication failed — check SD.Next credentials";
  if (response.status === 429) return "SD.Next rate limit / busy — try again shortly";
  const text = await readBodyText(response, MAX_ERROR_BODY_BYTES).catch(() => "");
  const redacted = redactSecrets(text);
  const scrubbed = apiKey && apiKey.length >= 4 ? redacted.split(apiKey).join("[redacted]") : redacted;
  return `SD.Next error (HTTP ${response.status})${scrubbed ? `: ${scrubbed.slice(0, 300)}` : ""}`;
}
