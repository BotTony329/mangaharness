/**
 * Server-side planner: composes the system prompt (role + tools + selected
 * skills + guardrails), asks the agent model for a JSON plan, validates it.
 * Raw model output never executes — validatePlan is the gate.
 */

import { z } from "zod";
import type { AgentRunScope } from "./scope";
import { AGENT_REQUEST_TIMEOUT_MS, AgentModelError, type AgentModelProvider, type AgentProviderEvent } from "./providers/types";
import { selectSkills } from "./skills/selector";
import { TOOL_DOCS, validatePlan, type PlanValidation } from "./tools/schemas";

export const agentRequestSchema = z.object({
  prompt: z.string().min(2).max(2000),
  context: z.string().max(12000),
  scope: z.object({
    kind: z.enum(["selected-object", "selected-panel", "current-page", "whole-project"]),
    pageId: z.string().min(1),
    pageName: z.string().min(1),
    panelCount: z.number().int().min(1).max(12),
    panelId: z.string().optional(),
    panelNumber: z.number().int().min(1).max(12).optional(),
    itemId: z.string().optional(),
    label: z.string().min(1).max(160),
  }),
});

export type AgentRequestInput = z.infer<typeof agentRequestSchema>;

export interface AgentPlanResponse extends PlanValidation {
  skillsUsed: string[];
  providerFinishReason?: string;
  responseMode?: "stream" | "buffered";
}

export type AgentTraceStage =
  | "context_built"
  | AgentProviderEvent["stage"]
  | "response_parse_start"
  | "response_parse_complete"
  | "plan_normalized"
  | "tool_validation_complete";

export type AgentTrace = (stage: AgentTraceStage, details?: Record<string, string | number | boolean | undefined>) => void;

export async function planAgentRun(
  provider: AgentModelProvider,
  input: AgentRequestInput,
  options: { signal?: AbortSignal; trace?: AgentTrace } = {},
): Promise<AgentPlanResponse> {
  const skills = selectSkills(input.prompt);
  const systemPrompt = buildSystemPrompt(skills.map((s) => s.instructions));
  const userPrompt = [
    "PROJECT CONTEXT:",
    input.context,
    "",
    "USER REQUEST:",
    input.prompt,
    "",
    "Respond with the JSON plan now.",
  ].join("\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let completion;
  try {
    completion = await provider.completeJson(systemPrompt, userPrompt, {
      signal,
      timeoutMs: AGENT_REQUEST_TIMEOUT_MS,
      onEvent: (event) => options.trace?.(event.stage, {
        responseMode: event.responseMode,
        providerStatus: event.providerStatus,
        finishReason: event.finishReason,
      }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw new AgentModelError("Agent planning was cancelled", 499);
    if (controller.signal.aborted) throw new AgentModelError("Agent model timed out while planning.", 504);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  options.trace?.("response_parse_start");
  let normalized: unknown;
  try {
    normalized = parseModelJson(completion.text);
  } catch {
    throw new AgentModelError("Agent provider responded, but the planning response could not be parsed.", 502, {
      stage: "parsing",
      finishReason: completion.finishReason,
    });
  }
  options.trace?.("response_parse_complete");
  options.trace?.("plan_normalized");
  let validation: PlanValidation;
  try {
    validation = validatePlan(normalized, input.scope as AgentRunScope);
  } catch {
    throw new AgentModelError("Agent provider responded, but no valid tool plan was found.", 502, {
      stage: "validation",
      finishReason: completion.finishReason,
    });
  }
  options.trace?.("tool_validation_complete", { acceptedTools: validation.plan.steps.length, rejectedTools: validation.rejected.length });
  return {
    ...validation,
    skillsUsed: skills.map((s) => s.name),
    providerFinishReason: completion.finishReason,
    responseMode: completion.responseMode,
  };
}

function buildSystemPrompt(skillInstructions: string[]): string {
  return [
    `You are the Manga Agent inside a browser manga studio. You operate the same
editor the human creator uses, through a fixed set of tools. You NEVER produce
finished images of whole panels — you compose editable pages from reusable
library assets, generating individual assets only when the library lacks them.`,
    TOOL_DOCS,
    ...skillInstructions,
    `# Output format

Respond with ONLY a JSON object:
{
  "summary": "one sentence describing what you will do",
  "steps": [
    { "tool": "tool_name", "args": { ... }, "reason": "short why" }
  ]
}

Rules:
- Maximum 30 steps. Keep plans minimal — every generation step costs money.
- Steps execute strictly in order; a generated asset can be placed by a later step.
- Reference characters by their exact names from the context.
- The AUTHORITATIVE TARGET SCOPE in project context is a hard boundary. Never plan a tool call outside it.
- A selected panel means ONLY that panel unless the target scope explicitly says Current Page or Whole Project.
- If the request is unclear or impossible with these tools, return
  {"summary": "explanation of what you need", "steps": []}.
- Never invent tool names or argument fields.`,
  ].join("\n\n");
}

/** Models sometimes wrap JSON in code fences even in JSON mode. */
export function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error("The agent returned an unreadable plan");
  }
}
