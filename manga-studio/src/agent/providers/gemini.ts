/** Google Gemini agent adapter (generateContent with JSON response mode). */

import type { ProviderConfig } from "@/server/providerSession";
import { agentErrorFrom, boundedFetch } from "./http";
import { AgentModelError, type AgentModelProvider } from "./types";

export function createGeminiAgent(config: ProviderConfig): AgentModelProvider {
  const base = config.baseUrl.replace(/\/$/, "");
  const headers = { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" };

  return {
    label: config.name || `gemini (${config.model})`,
    model: config.model,

    async testConnection() {
      const response = await boundedFetch(`${base}/v1beta/models/${config.model}`, { method: "GET", headers });
      if (response.ok) return { ok: true };
      return { ok: false, message: (await agentErrorFrom(response)).safeMessage };
    },

    async completeJson(systemPrompt, userPrompt) {
      const response = await boundedFetch(`${base}/v1beta/models/${config.model}:generateContent`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        }),
      });
      if (!response.ok) throw await agentErrorFrom(response);
      const body = (await response.json().catch(() => null)) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      } | null;
      const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
      if (!text) throw new AgentModelError("Agent model returned an empty response");
      return text;
    },
  };
}
