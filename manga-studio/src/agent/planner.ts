/**
 * Server-side planner: composes the system prompt (role + tools + selected
 * skills + guardrails), asks the agent model for a JSON plan, validates it.
 * Raw model output never executes — validatePlan is the gate.
 */

import { z } from "zod";
import type { AgentModelProvider } from "./providers/types";
import { selectSkills } from "./skills/selector";
import { TOOL_DOCS, validatePlan, type PlanValidation } from "./tools/schemas";

export const agentRequestSchema = z.object({
  prompt: z.string().min(2).max(2000),
  context: z.string().max(12000),
});

export type AgentRequestInput = z.infer<typeof agentRequestSchema>;

export interface AgentPlanResponse extends PlanValidation {
  skillsUsed: string[];
}

export async function planAgentRun(provider: AgentModelProvider, input: AgentRequestInput): Promise<AgentPlanResponse> {
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

  const raw = await provider.completeJson(systemPrompt, userPrompt);
  const validation = validatePlan(parseModelJson(raw));
  return { ...validation, skillsUsed: skills.map((s) => s.name) };
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
- If the request is unclear or impossible with these tools, return
  {"summary": "explanation of what you need", "steps": []}.
- Never invent tool names or argument fields.`,
  ].join("\n\n");
}

/** Models sometimes wrap JSON in code fences even in JSON mode. */
function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error("The agent returned an unreadable plan");
  }
}
