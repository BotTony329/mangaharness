/**
 * Universal image provider: executes a user-described Custom API. The editor
 * still sends the normalized internal request; this adapter renders the
 * user's template, performs the (optionally polled) call, and maps the result
 * out of the response by path. Providers Manga Studio has never heard of
 * connect here without any source change.
 */

import { getAtPath } from "@/server/customApi/jsonPath";
import { parseTemplate, renderTemplate } from "@/server/customApi/template";
import {
  buildHeaders,
  CustomApiError,
  customErrorFrom,
  customFetch,
  MAX_RESPONSE_BYTES,
  readJsonBounded,
} from "@/server/customApi/execute";
import { IMAGE_TEMPLATE_VARS } from "@/server/customApi/config";
import type { ProviderConfig } from "@/server/providerSession";
import { detectImageType } from "@/storage/imageValidation";
import {
  ProviderError,
  type ImageGenerationProvider,
  type ImageEditRequest,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ProviderStatus,
} from "../types";

export function createCustomImageProvider(config: ProviderConfig): ImageGenerationProvider {
  const custom = config.custom;
  if (!custom?.response) throw new Error("Custom image provider is missing its API description");

  return {
    id: "custom",
    label: config.name || "Custom API",
    model: config.model,
    capabilities: {
      textToImage: true,
      supportsReferenceImage: custom.referenceMode !== "none",
      supportsTransparentBackground: false,
      supportsImageEditing: custom.referenceMode !== "none",
      referenceImage: custom.referenceMode !== "none",
      imageVariation: custom.referenceMode !== "none",
      transparentOutput: false,
      asyncGeneration: custom.execution === "async",
    },

    /**
     * There is no universal cheap status endpoint for arbitrary APIs, so
     * Test Connection performs one real minimal generation and reports
     * whether the mapping found an image. The UI warns about the cost.
     */
    async testConnection(): Promise<ProviderStatus> {
      try {
        await runGeneration(config, {
          prompt: "simple line sketch of a circle, test",
          assetType: "prop",
          width: 512,
          height: 512,
        });
        return { ok: true, message: `Connected — image found at ${custom.response!.path}` };
      } catch (error) {
        return { ok: false, message: error instanceof CustomApiError ? error.safeMessage : "Connection failed" };
      }
    },

    async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      try {
        return await runGeneration(config, request);
      } catch (error) {
        if (error instanceof CustomApiError) throw new ProviderError(error.safeMessage, error.status);
        throw error;
      }
    },

    ...(custom.referenceMode !== "none" ? {
      async editImage(request: ImageEditRequest): Promise<ImageGenerationResult> {
        try {
          return await runGeneration(config, {
            prompt: request.instruction,
            assetType: "character",
            referenceImages: [request.image],
            referenceUrls: request.image.url ? [request.image.url] : undefined,
            trace: request.trace,
          });
        } catch (error) {
          if (error instanceof CustomApiError) throw new ProviderError(error.safeMessage, error.status);
          throw error;
        }
      },
    } : {}),
  };
}

async function runGeneration(config: ProviderConfig, request: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const custom = config.custom!;
  const body = renderTemplate(parseTemplate(custom.requestTemplate, IMAGE_TEMPLATE_VARS), templateVars(config, request));
  const headers = buildHeaders(config, custom);

  request.trace?.("outbound_request_start", {
    provider: "custom",
    operation: "generate_image",
    endpointPath: "configured_endpoint",
  });
  const response = await customFetch(config.baseUrl, {
    method: custom.method,
    headers,
    body: custom.method === "POST" ? JSON.stringify(body) : undefined,
  });
  request.trace?.("outbound_response_received", { provider: "custom", httpStatus: response.status });
  if (!response.ok) throw await customErrorFrom(response, config.apiKey);
  const responseBody = await readJsonBounded(response);

  const resultValue =
    custom.execution === "async"
      ? await pollForResult(config, responseBody, request)
      : getAtPath(responseBody, custom.response!.path);

  const result = await materializeImage(resultValue, custom.response!.type, custom.response!.path, request);
  request.trace?.("provider_response_parsed", { provider: "custom", imageFound: true });
  return result;
}

function templateVars(config: ProviderConfig, request: ImageGenerationRequest): Record<string, unknown> {
  const referenceValues =
    config.custom!.referenceMode === "url"
      ? (request.referenceUrls ?? [])
      : (request.referenceImages ?? []).map((ref) => ref.data.toString("base64"));
  return {
    model: config.model,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt ?? "",
    width: request.width ?? 1024,
    height: request.height ?? 1024,
    aspectRatio: `${request.width ?? 1024}:${request.height ?? 1024}`,
    // Deterministic randomness isn't needed — providers just want variety.
    seed: Math.floor(Math.random() * 2 ** 31),
    referenceImage: referenceValues[0] ?? "",
    referenceImages: referenceValues,
  };
}

async function pollForResult(
  config: ProviderConfig,
  submitBody: unknown,
  request: ImageGenerationRequest,
): Promise<unknown> {
  const polling = config.custom!.polling!;
  const taskId = getAtPath(submitBody, polling.taskIdPath);
  if (taskId === undefined || taskId === null) {
    throw new CustomApiError(`Task ID not found at ${polling.taskIdPath}`);
  }
  const statusUrl = polling.statusUrlTemplate.replace(/\{\{\s*taskId\s*\}\}/g, encodeURIComponent(String(taskId)));
  const headers = buildHeaders(config, config.custom!);
  const deadline = Date.now() + polling.timeoutMs;

  while (Date.now() < deadline) {
    await sleep(polling.intervalMs);
    request.trace?.("outbound_request_start", { provider: "custom", operation: "poll_generation" });
    const response = await customFetch(statusUrl, { method: "GET", headers });
    request.trace?.("outbound_response_received", {
      provider: "custom",
      operation: "poll_generation",
      httpStatus: response.status,
    });
    if (!response.ok) throw await customErrorFrom(response, config.apiKey);
    const body = await readJsonBounded(response);
    const status = String(getAtPath(body, polling.statusPath) ?? "");
    if (status === polling.completedValue) return getAtPath(body, polling.resultPath);
    if (polling.failedValue && status === polling.failedValue) {
      throw new CustomApiError("The provider reported the generation task as failed");
    }
  }
  throw new CustomApiError("Timed out waiting for the generation task", 504);
}

/** Turn the mapped response value (URL or base64) into image bytes. */
async function materializeImage(
  value: unknown,
  type: "url" | "base64",
  path: string,
  request: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  if (typeof value !== "string" || value.length === 0) {
    throw new CustomApiError(`No image found at response path "${path}"`);
  }

  let data: Buffer;
  if (type === "url") {
    request.trace?.("outbound_request_start", { provider: "custom", operation: "download_image" });
    const response = await customFetch(value, { method: "GET" });
    request.trace?.("outbound_response_received", {
      provider: "custom",
      operation: "download_image",
      httpStatus: response.status,
    });
    if (!response.ok) throw new CustomApiError(`Could not download the generated image (HTTP ${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw new CustomApiError("Generated image too large");
    data = bytes;
  } else {
    // Tolerate data-URI prefixes some providers add.
    data = Buffer.from(value.replace(/^data:image\/[a-z+]+;base64,/i, ""), "base64");
  }

  const detected = detectImageType(new Uint8Array(data.subarray(0, 16)));
  if (!detected) throw new CustomApiError("The mapped response value is not a PNG/JPEG/WebP image");
  return { mimeType: detected.mimeType, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
