/**
 * Redacted request previews for the Custom API test console — users
 * debugging a new provider see exactly what would be sent, minus secrets.
 */

import type { ProviderConfig } from "../providerSession";
import { AGENT_TEMPLATE_VARS, IMAGE_TEMPLATE_VARS } from "./config";
import { buildHeaders, previewRequest } from "./execute";
import { parseTemplate, renderTemplate } from "./template";

const SAMPLE_IMAGE_VARS: Record<string, unknown> = {
  model: "", // replaced with the real model below
  prompt: "girl running, manga line art (sample)",
  negativePrompt: "",
  width: 832,
  height: 1216,
  aspectRatio: "832:1216",
  seed: 12345,
  referenceImage: "…reference…",
  referenceImages: ["…reference…"],
};

const SAMPLE_AGENT_VARS: Record<string, unknown> = {
  model: "",
  systemPrompt: "(system prompt)",
  userPrompt: "(user request)",
  messages: [
    { role: "system", content: "(system prompt)" },
    { role: "user", content: "(user request)" },
  ],
  temperature: 0.2,
};

export interface RequestPreview {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Null when the config isn't a custom provider or its template is broken. */
export function buildRequestPreview(config: ProviderConfig): RequestPreview | null {
  const custom = config.custom;
  if (!custom) return null;
  try {
    const vars = { ...(config.kind === "image" ? SAMPLE_IMAGE_VARS : SAMPLE_AGENT_VARS), model: config.model };
    const allowed = config.kind === "image" ? IMAGE_TEMPLATE_VARS : AGENT_TEMPLATE_VARS;
    const body = renderTemplate(parseTemplate(custom.requestTemplate, allowed), vars);
    return previewRequest(custom.method, config.baseUrl, buildHeaders(config, custom), body, config);
  } catch {
    return null;
  }
}
