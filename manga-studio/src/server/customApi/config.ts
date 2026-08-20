/**
 * Declarative Custom API configuration — the universal provider type. Users
 * describe how to call an arbitrary AI API (endpoint, auth, headers, request
 * template, response mapping, optional polling); the harness executes it.
 * No code is ever accepted: everything here is data.
 */

import { z } from "zod";
import { isValidPath } from "./jsonPath";
import { parseTemplate, TemplateError } from "./template";

export const IMAGE_TEMPLATE_VARS = [
  "model",
  "prompt",
  "negativePrompt",
  "width",
  "height",
  "aspectRatio",
  "seed",
  "referenceImage",
  "referenceImages",
] as const;

export const AGENT_TEMPLATE_VARS = ["model", "systemPrompt", "userPrompt", "messages", "temperature"] as const;

const authSchema = z.object({
  mode: z.enum(["none", "bearer", "header"]),
  /** Header name for mode "header", e.g. x-api-key or X-Provider-Key. */
  header: z.string().min(1).max(100).optional(),
});

const pollingSchema = z.object({
  taskIdPath: z.string().min(1).max(300),
  /** May contain {{taskId}}; host is SSRF-checked at runtime. */
  statusUrlTemplate: z.string().min(8).max(1024),
  statusPath: z.string().min(1).max(300),
  completedValue: z.string().min(1).max(100),
  failedValue: z.string().max(100).optional(),
  resultPath: z.string().min(1).max(300),
  intervalMs: z.number().int().min(500).max(15000).default(2000),
  timeoutMs: z.number().int().min(5000).max(110000).default(60000),
});

export const customApiSchema = z.object({
  method: z.enum(["POST", "GET"]).default("POST"),
  auth: authSchema,
  headers: z.array(z.object({ name: z.string().min(1).max(100), value: z.string().max(2000) })).max(10).default([]),
  requestTemplate: z.string().min(2).max(6000),
  /** Image capability: where and how the result image appears. */
  response: z.object({ type: z.enum(["url", "base64"]), path: z.string().min(1).max(300) }).optional(),
  /** How {{referenceImage(s)}} template variables are materialized. */
  referenceMode: z.enum(["none", "url", "base64"]).default("none"),
  execution: z.enum(["sync", "async"]).default("sync"),
  polling: pollingSchema.optional(),
  /** Agent capability: where the model's text answer lives in the response. */
  responseTextPath: z.string().min(1).max(300).optional(),
});

export type CustomApiConfig = z.infer<typeof customApiSchema>;

/**
 * Capability-aware validation beyond field shapes: template must parse with
 * only the allowed variables, all mapping paths must be traversal-safe, and
 * async mode needs its polling block.
 */
export function validateCustomApi(config: CustomApiConfig, capability: "agent" | "image"): void {
  const allowedVars = capability === "image" ? IMAGE_TEMPLATE_VARS : AGENT_TEMPLATE_VARS;
  try {
    parseTemplate(config.requestTemplate, allowedVars);
  } catch (error) {
    throw new Error(error instanceof TemplateError ? error.message : "Invalid request template");
  }

  if (config.auth.mode === "header" && !config.auth.header) {
    throw new Error("Custom-header authentication needs a header name");
  }

  if (capability === "image") {
    if (!config.response) throw new Error("Image response mapping (type + path) is required");
    assertPath(config.response.path, "Image result path");
    if (config.execution === "async") {
      if (!config.polling) throw new Error("Asynchronous mode needs polling configuration");
      assertPath(config.polling.taskIdPath, "Task ID path");
      assertPath(config.polling.statusPath, "Status path");
      assertPath(config.polling.resultPath, "Result path");
      if (!/\{\{\s*taskId\s*\}\}/.test(config.polling.statusUrlTemplate)) {
        throw new Error("Status URL template must contain {{taskId}}");
      }
    }
  } else {
    assertPath(config.responseTextPath ?? "choices[0].message.content", "Response text path");
  }
}

function assertPath(path: string, label: string): void {
  if (!isValidPath(path)) {
    throw new Error(`${label} must be a simple property path like data.images[0].url`);
  }
}
