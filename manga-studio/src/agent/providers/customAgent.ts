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
import { AgentModelError, type AgentModelProvider } from "./types";

const DEFAULT_TEXT_PATH = "choices[0].message.content";

export function createCustomAgentProvider(config: ProviderConfig): AgentModelProvider {
  const custom = config.custom;
  if (!custom) throw new Error("Custom agent provider is missing its API description");
  const textPath = custom.responseTextPath ?? DEFAULT_TEXT_PATH;

  const complete = async (systemPrompt: string, userPrompt: string): Promise<string> => {
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
    const body = renderTemplate(parseTemplate(custom.requestTemplate, AGENT_TEMPLATE_VARS), vars);
    const response = await customFetch(config.baseUrl, {
      method: custom.method,
      headers: buildHeaders(config, custom),
      body: custom.method === "POST" ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw toAgentError(await customErrorFrom(response, config.apiKey));

    const responseBody = await readJsonBounded(response).catch((error) => {
      throw toAgentError(error);
    });
    const value = getAtPath(responseBody, textPath);
    if (value === undefined || value === null || value === "") {
      throw new AgentModelError(`No response text found at "${textPath}"`);
    }
    // Some APIs return the JSON plan as a structured object rather than text.
    return typeof value === "string" ? value : JSON.stringify(value);
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
  if (error instanceof CustomApiError) return new AgentModelError(error.safeMessage, error.status);
  return new AgentModelError("Endpoint unreachable");
}
