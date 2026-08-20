/** Anthropic Messages API adapter (Claude and compatible gateways). */

import type { ProviderConfig } from "@/server/providerSession";
import { agentErrorFrom, boundedFetch } from "./http";
import { AgentModelError, type AgentModelProvider } from "./types";

export function createAnthropicCompatibleAgent(config: ProviderConfig): AgentModelProvider {
  const base = config.baseUrl.replace(/\/$/, "");
  const headers = {
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };

  const complete = (system: string, user: string, maxTokens: number, options?: Parameters<AgentModelProvider["completeJson"]>[2]) =>
    boundedFetch(`${base}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        temperature: 0.2,
      }),
    }, options);

  return {
    label: config.name || `anthropic @ ${hostOf(base)}`,
    model: config.model,

    async testConnection() {
      // No cheap status endpoint on the Messages API — a 1-token request is
      // the least expensive real validation of endpoint + key + model.
      const response = await complete("Reply with the word ok.", "ping", 1);
      if (response.ok) return { ok: true };
      return { ok: false, message: (await agentErrorFrom(response)).safeMessage };
    },

    async completeJson(systemPrompt, userPrompt, options) {
      // No native JSON mode: the planner's prompt demands a JSON object and
      // parseModelJson strips any code fences the model adds.
      const response = await complete(systemPrompt, userPrompt, 2048, options);
      if (!response.ok) throw await agentErrorFrom(response);
      options?.onEvent?.({ stage: "first_response_byte", responseMode: "buffered", providerStatus: response.status });
      const body = (await response.json().catch(() => null)) as {
        content?: { type?: string; text?: string }[];
      } | null;
      const text = body?.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      if (!text) throw new AgentModelError("Agent model returned an empty response");
      options?.onEvent?.({ stage: "provider_response_complete", responseMode: "buffered", providerStatus: response.status });
      return { text, responseMode: "buffered" };
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
