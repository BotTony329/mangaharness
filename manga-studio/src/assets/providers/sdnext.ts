/**
 * SD.Next Background Removal Provider using built-in rembg postprocessing.
 *
 * Calls POST /sdapi/v1/extra-single-image with rembg_model (default "u2net").
 */

import { ProviderError, type ProviderStatus } from "@/ai/types";
import { assertSafeProviderUrl, redactSecrets } from "@/ai/security";
import { outboundFetch, readBodyText, UnsafeOutboundUrlError } from "@/server/outboundFetch";
import type { ProviderConfig } from "@/server/providerSession";
import { buildSdnextAuthHeaders } from "@/ai/providers/sdnext";
import type { BackgroundRemovalInput, BackgroundRemovalProvider, BackgroundRemovalResult } from "./types";
import { validatedProviderResult } from "./validateResult";

const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export function createSdnextBackgroundRemovalProvider(config: ProviderConfig): BackgroundRemovalProvider {
  const id = "sdnext";
  const name = config.name || "SD.Next (rembg)";
  const base = assertSafeProviderUrl(config.baseUrl).toString().replace(/\/$/, "");
  const authHeaders = buildSdnextAuthHeaders(config.apiKey);
  const rembgModel = config.model && config.model !== "background-removal" ? config.model : "u2net";

  return {
    id,
    name,
    model: rembgModel,

    async removeBackground(input: BackgroundRemovalInput): Promise<BackgroundRemovalResult> {
      let base64Image: string;
      if (input.imageBytes) {
        base64Image = Buffer.from(input.imageBytes).toString("base64");
      } else if (input.imageUrl) {
        const fetchRes = await outboundFetch(input.imageUrl, { method: "GET" }, { timeoutMs: 15_000 });
        if (!fetchRes.ok) {
          return {
            success: false,
            alphaValidation: { valid: false, reason: "Could not fetch source image" },
            providerMetadata: { id, name, model: rembgModel },
            safeError: "Could not fetch source image for background removal",
          };
        }
        const imgBuffer = Buffer.from(await fetchRes.arrayBuffer());
        base64Image = imgBuffer.toString("base64");
      } else {
        return {
          success: false,
          alphaValidation: { valid: false, reason: "Image input is required" },
          providerMetadata: { id, name, model: rembgModel },
          safeError: "Background-removal input was unavailable",
        };
      }

      const payload = {
        image: base64Image,
        rembg_model: rembgModel,
      };

      input.trace?.("outbound_request_start", {
        provider: id,
        operation: "remove_background",
        endpointPath: "/sdapi/v1/extra-single-image",
        model: rembgModel,
      });

      const response = await boundedFetch(`${base}/sdapi/v1/extra-single-image`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify(payload),
      });

      input.trace?.("outbound_response_received", {
        provider: id,
        operation: "remove_background",
        httpStatus: response.status,
      });

      if (!response.ok) {
        throw new ProviderError(await safeErrorMessage(response, config.apiKey), mapStatus(response.status));
      }

      const text = await readBodyText(response, MAX_RESPONSE_BYTES).catch(() => null);
      let body: { image?: string; images?: string[] } | null = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new ProviderError("Invalid JSON response from SD.Next rembg");
        }
      }

      const rawImage = body?.image ?? body?.images?.[0];
      if (!rawImage) {
        throw new ProviderError("SD.Next rembg returned no image");
      }

      const cleanB64 = rawImage.replace(/^data:image\/[a-z]+;base64,/, "");
      const data = Buffer.from(cleanB64, "base64");

      return validatedProviderResult({
        data,
        mimeType: "image/png",
        id,
        name,
        model: rembgModel,
      });
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
  };
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
      throw new ProviderError("Background removal timed out", 504);
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
