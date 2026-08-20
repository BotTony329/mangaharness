/** Shared HTTP plumbing for agent adapters: timeouts and safe error text. */

import { redactSecrets } from "@/ai/security";
import { AGENT_REQUEST_TIMEOUT_MS, AgentModelError } from "./types";

export async function boundedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AgentModelError("The agent model timed out", 504);
    }
    throw new AgentModelError("Endpoint unreachable", 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function agentErrorFrom(response: Response): Promise<AgentModelError> {
  if (response.status === 401 || response.status === 403) {
    return new AgentModelError("Authentication failed — check the API key", 401);
  }
  if (response.status === 404) {
    return new AgentModelError("Model or endpoint not found — check the base URL and model name", 404);
  }
  const text = await response.text().catch(() => "");
  return new AgentModelError(
    `Provider error (HTTP ${response.status})${text ? `: ${redactSecrets(text).slice(0, 200)}` : ""}`,
  );
}
