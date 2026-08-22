/** Shared HTTP plumbing for agent adapters: timeouts, SSRF validation, and safe error text. */

import { redactSecrets } from "@/ai/security";
import { outboundFetch, readBodyText, UnsafeOutboundUrlError } from "@/server/outboundFetch";
import { AGENT_REQUEST_TIMEOUT_MS, AgentModelError, type AgentCompletionOptions } from "./types";

const MAX_ERROR_BODY_BYTES = 64 * 1024;

export async function boundedFetch(url: string, init: RequestInit, options: AgentCompletionOptions = {}): Promise<Response> {
  const upstreamSignal = options.signal ?? init.signal ?? undefined;
  try {
    options.onEvent?.({ stage: "outbound_request_start" });
    return await outboundFetch(url, init, {
      timeoutMs: options.timeoutMs ?? AGENT_REQUEST_TIMEOUT_MS,
      signal: upstreamSignal,
    });
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) {
      throw new AgentModelError(error.message, 400, { providerStatus: 400 });
    }
    if (error instanceof Error && error.name === "AbortError") {
      if (upstreamSignal?.aborted) throw new AgentModelError("Agent planning was cancelled", 499);
      throw new AgentModelError("Agent model timed out while planning.", 504);
    }
    throw new AgentModelError("Endpoint unreachable", 502);
  }
}

export async function agentErrorFrom(response: Response): Promise<AgentModelError> {
  if (response.status === 401 || response.status === 403) {
    return new AgentModelError("Authentication failed — check the API key", 401, { providerStatus: response.status });
  }
  if (response.status === 404) {
    return new AgentModelError("Model or endpoint not found — check the base URL and model name", 404, { providerStatus: response.status });
  }
  const text = await readBodyText(response, MAX_ERROR_BODY_BYTES).catch(() => "");
  return new AgentModelError(
    `Provider error (HTTP ${response.status})${text ? `: ${redactSecrets(text).slice(0, 200)}` : ""}`,
    response.status === 429 ? 429 : 502,
    { providerStatus: response.status },
  );
}
