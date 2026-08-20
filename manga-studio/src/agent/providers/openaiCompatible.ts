/**
 * OpenAI-compatible chat-completions adapter — the workhorse: DeepSeek,
 * Kimi/Moonshot, OpenAI, OpenRouter, self-hosted gateways, Ollama's
 * compatible endpoint, and most other vendors speak this shape.
 */

import type { ProviderConfig } from "@/server/providerSession";
import { agentErrorFrom, boundedFetch } from "./http";
import { AgentModelError, type AgentModelProvider } from "./types";

export function createOpenAiCompatibleAgent(config: ProviderConfig): AgentModelProvider {
  const base = config.baseUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };

  return {
    label: config.name || `openai-compatible @ ${hostOf(base)}`,
    model: config.model,

    async testConnection() {
      // Prefer the cheap models listing; some gateways don't expose it, so
      // fall back to a one-token completion rather than reporting failure.
      const models = await boundedFetch(`${base}/models`, { method: "GET", headers });
      if (models.ok) return { ok: true };
      if (models.status === 401 || models.status === 403) {
        return { ok: false, message: "Authentication failed — check the API key" };
      }
      const probe = await boundedFetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      });
      if (probe.ok) return { ok: true };
      return { ok: false, message: (await agentErrorFrom(probe)).safeMessage };
    },

    async completeJson(systemPrompt, userPrompt) {
      const response = await boundedFetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0.2,
        }),
      });
      if (!response.ok) throw await agentErrorFrom(response);
      const body = (await response.json().catch(() => null)) as {
        choices?: { message?: { content?: string } }[];
      } | null;
      const content = body?.choices?.[0]?.message?.content;
      if (!content) throw new AgentModelError("Agent model returned an empty response");
      return content;
    },
  };
}

/** Fetch the provider's model list for the settings model picker. */
export async function listOpenAiCompatibleModels(config: ProviderConfig): Promise<string[]> {
  const response = await boundedFetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) throw await agentErrorFrom(response);
  const body = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  return (body?.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
