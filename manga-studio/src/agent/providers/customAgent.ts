/**
 * Universal agent provider: a user-described Custom API as the reasoning
 * engine. The harness's plan contract stays canonical — whatever endpoint
 * shape the user wires up, the extracted text must be the JSON plan, which
 * validatePlan gates like every other provider.
 */

import { getAtPath } from "@/server/customApi/jsonPath";
import { parseTemplate, renderTemplate } from "@/server/customApi/template";
import { AGENT_TEMPLATE_VARS } from "@/server/customApi/config";
import {
  buildHeaders,
  CustomApiError,
  customErrorFrom,
  customFetch,
  readJsonBounded,
} from "@/server/customApi/execute";
import type { ProviderConfig } from "@/server/providerSession";
import { AGENT_REQUEST_TIMEOUT_MS, AgentModelError, type AgentCompletionOptions, type AgentModelProvider } from "./types";
import { normalizeMessage, readOpenAiCompletion } from "./openaiResponse";

const DEFAULT_TEXT_PATH = "choices[0].message.content";

export function createCustomAgentProvider(config: ProviderConfig): AgentModelProvider {
  const custom = config.custom;
  if (!custom) throw new Error("Custom agent provider is missing its API description");
  const textPath = custom.responseTextPath ?? DEFAULT_TEXT_PATH;

  const complete = async (systemPrompt: string, userPrompt: string, options: AgentCompletionOptions = {}) => {
    const vars = {
      model: config.model,
      systemPrompt,
      userPrompt,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
    };
    let body = renderTemplate(parseTemplate(custom.requestTemplate, AGENT_TEMPLATE_VARS), vars);
    const openAiChatShape = isOpenAiChatShape(config.baseUrl, body);
    if (openAiChatShape && typeof body === "object" && body !== null && !Array.isArray(body)) {
      body = {
        ...body,
        max_tokens: 2048,
        stream: true,
        stream_options: { include_usage: true },
        ...(isQwenHybridModel(config.model) ? { enable_thinking: false } : {}),
      };
    }
    options.onEvent?.({ stage: "outbound_request_start" });
    let response: Response;
    try {
      response = await customFetch(config.baseUrl, {
        method: custom.method,
        headers: buildHeaders(config, custom),
        body: custom.method === "POST" ? JSON.stringify(body) : undefined,
      }, { signal: options.signal, timeoutMs: options.timeoutMs ?? AGENT_REQUEST_TIMEOUT_MS });
    } catch (error) {
      throw toAgentError(error);
    }
    if (!response.ok) throw toAgentError(await customErrorFrom(response, config.apiKey));

    if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      return readOpenAiCompletion(response, options);
    }

    options.onEvent?.({ stage: "first_response_byte", responseMode: "buffered", providerStatus: response.status });
    const responseBody = await readJsonBounded(response).catch((error) => {
      throw toAgentError(error);
    });
    if (openAiChatShape) {
      const envelope = responseBody as { choices?: { message?: Parameters<typeof normalizeMessage>[0]; finish_reason?: string | null }[] };
      const choice = envelope.choices?.[0];
      if (choice?.message) {
        const text = normalizeMessage(choice.message);
        options.onEvent?.({ stage: "provider_response_complete", responseMode: "buffered", providerStatus: response.status, finishReason: choice.finish_reason ?? undefined });
        return { text, finishReason: choice.finish_reason ?? undefined, responseMode: "buffered" as const };
      }
    }
    const value = getAtPath(responseBody, textPath);
    if (value === undefined || value === null || value === "") {
      throw new AgentModelError(`No response text found at "${textPath}"`);
    }
    // Some APIs return the JSON plan as a structured object rather than text.
    const text = typeof value === "string" ? value : JSON.stringify(value);
    options.onEvent?.({ stage: "provider_response_complete", responseMode: "buffered", providerStatus: response.status });
    return { text, responseMode: "buffered" as const };
  };

  return {
    label: config.name || "Custom API",
    model: config.model,

    async testConnection() {
      try {
        await complete("Respond with a JSON object.", 'Return {"ok": true} and nothing else.');
        return { ok: true, message: `Connected — response text found at ${textPath}` };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof AgentModelError ? error.safeMessage : "Connection failed",
        };
      }
    },

    completeJson: complete,
  };
}

function toAgentError(error: unknown): AgentModelError {
  if (error instanceof AgentModelError) return error;
  if (error instanceof CustomApiError) {
    const message = error.status === 504 ? "Agent model timed out while planning." : error.safeMessage;
    return new AgentModelError(message, error.status);
  }
  return new AgentModelError("Endpoint unreachable");
}

function isOpenAiChatShape(url: string, body: unknown): boolean {
  return /\/chat\/completions\/?$/i.test(new URL(url).pathname) &&
    typeof body === "object" && body !== null && !Array.isArray(body) && Array.isArray((body as { messages?: unknown }).messages);
}

function isQwenHybridModel(model: string): boolean {
  return /qwen/i.test(model) && !/(thinking|qwq)/i.test(model);
}
