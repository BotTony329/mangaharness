import { ProviderError, type ProviderStatus } from "@/ai/types";
import { outboundFetch, readBodyBytes, UnsafeOutboundUrlError } from "@/server/outboundFetch";
import type { ProviderConfig } from "@/server/providerSession";
import type { BackgroundRemovalProvider } from "./types";
import { validatedProviderResult } from "./validateResult";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

export function createRemoveBgProvider(config: ProviderConfig): BackgroundRemovalProvider {
  const id = "remove-bg";
  const name = config.name || "remove.bg";
  return {
    id,
    name,
    model: config.model,
    async removeBackground(input) {
      if (!input.imageBytes && !input.imageUrl) {
        return {
          success: false,
          alphaValidation: { valid: false, reason: "Image input is required" },
          providerMetadata: { id, name, model: config.model },
          safeError: "Background-removal input was unavailable",
        };
      }
      const form = new FormData();
      if (input.imageBytes) {
        form.append("image_file", new Blob([new Uint8Array(input.imageBytes)], { type: input.mimeType ?? "image/png" }), "asset");
      } else {
        form.append("image_url", input.imageUrl!);
      }
      form.append("size", "auto");
      input.trace?.("outbound_request_start", { provider: id, operation: "remove_background", endpointPath: "/v1.0/removebg" });
      const response = await boundedFetch(config.baseUrl, {
        method: "POST",
        headers: { "X-Api-Key": config.apiKey },
        body: form,
      });
      input.trace?.("outbound_response_received", { provider: id, operation: "remove_background", httpStatus: response.status });
      if (!response.ok) {
        const status = response.status === 401 || response.status === 403
          ? 401
          : response.status === 402 || response.status === 429 ? response.status : 502;
        throw new ProviderError(safeMessage(response.status), status);
      }
      const data = Buffer.from(await readBodyBytes(response, MAX_RESPONSE_BYTES));
      return validatedProviderResult({ data, mimeType: response.headers.get("content-type") ?? "image/png", id, name, model: config.model });
    },
    async testConnection(): Promise<ProviderStatus> {
      return { ok: true, message: "Configured — the first real removal will verify the API key and available credits" };
    },
  };
}

async function boundedFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await outboundFetch(url, init, { timeoutMs: REQUEST_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) throw new ProviderError(error.message, 400);
    if (error instanceof Error && error.name === "AbortError") throw new ProviderError("Background removal timed out", 504);
    throw new ProviderError("Background-removal provider is temporarily unavailable", 502);
  }
}

function safeMessage(status: number): string {
  if (status === 401 || status === 403) return "Background-removal authentication failed — check the API key";
  if (status === 402) return "Background-removal provider has no credits available";
  if (status === 429) return "Background-removal provider rate limit reached";
  return `Background-removal provider failed (HTTP ${status})`;
}
