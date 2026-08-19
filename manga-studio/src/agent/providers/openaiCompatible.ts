/**
 * Agent model provider: any OpenAI-compatible chat-completions endpoint.
 * Defaults target DeepSeek. Kept fully separate from the image provider —
 * the two services rarely come from the same vendor.
 */

import { assertSafeProviderUrl, redactSecrets } from "@/ai/security";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";
const REQUEST_TIMEOUT_MS = 120_000;

export interface AgentModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerLabel: string;
}

export function agentConfigFromEnv(): AgentModelConfig | null {
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) return null;
  const baseUrl = process.env.AGENT_API_BASE_URL || DEFAULT_BASE_URL;
  return {
    apiKey,
    baseUrl,
    model: process.env.AGENT_MODEL || DEFAULT_MODEL,
    providerLabel: new URL(baseUrl).hostname,
  };
}

export class AgentModelError extends Error {
  readonly safeMessage: string;
  readonly status: number;

  constructor(safeMessage: string, status = 502) {
    super(safeMessage);
    this.safeMessage = safeMessage;
    this.status = status;
  }
}

/**
 * One JSON-mode completion. The planner asks for a strict JSON object, which
 * is far more reliable across OpenAI-compatible vendors than parallel
 * function-calling.
 */
export async function completeJson(
  config: AgentModelConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const base = assertSafeProviderUrl(config.baseUrl).toString().replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AgentModelError("The agent model timed out", 504);
    }
    throw new AgentModelError("Agent model provider unavailable", 502);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new AgentModelError("Agent authentication failed — check the API key", 401);
    }
    const text = await response.text().catch(() => "");
    throw new AgentModelError(`Agent model error (HTTP ${response.status}): ${redactSecrets(text).slice(0, 200)}`);
  }

  const body = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new AgentModelError("Agent model returned an empty response");
  return content;
}
