/** Shared HTTP plumbing for agent adapters: timeouts and safe error text. */

import { redactSecrets } from "@/ai/security";
import { AGENT_REQUEST_TIMEOUT_MS, AgentModelError, type AgentCompletionOptions } from "./types";

export async function boundedFetch(url: string, init: RequestInit, options: AgentCompletionOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = options.signal ?? init.signal;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? AGENT_REQUEST_TIMEOUT_MS);
  const signal = upstreamSignal ? AbortSignal.any([controller.signal, upstreamSignal]) : controller.signal;
  try {
    options.onEvent?.({ stage: "outbound_request_start" });
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (upstreamSignal?.aborted) throw new AgentModelError("Agent planning was cancelled", 499);
      throw new AgentModelError("Agent model timed out while planning.", 504);
    }
    throw new AgentModelError("Endpoint unreachable", 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function agentErrorFrom(response: Response): Promise<AgentModelError> {
  if (response.status === 401 || response.status === 403) {
    return new AgentModelError("Authentication failed — check the API key", 401, { providerStatus: response.status });
  }
  if (response.status === 404) {
    return new AgentModelError("Model or endpoint not found — check the base URL and model name", 404, { providerStatus: response.status });
  }
  const text = await response.text().catch(() => "");
  return new AgentModelError(
    `Provider error (HTTP ${response.status})${text ? `: ${redactSecrets(text).slice(0, 200)}` : ""}`,
    response.status === 429 ? 429 : 502,
    { providerStatus: response.status },
  );
}
