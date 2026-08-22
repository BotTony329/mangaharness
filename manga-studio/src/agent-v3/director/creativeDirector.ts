/**
 * Main Creative Director — server side. ONE semantic LLM call: prompt +
 * literal lock + inventory + context in, validated Creative Task Map out.
 * Provider-independent: whatever model the creator connected answers through
 * the AgentModelProvider seam; this module knows nothing about vendors.
 */

import { z } from "zod";
import { AgentModelError } from "@/agent/providers/types";
import type { AgentModelProvider } from "@/agent/providers/types";
import { parseModelJson } from "@/agent/planner";
import { parseCreativeTaskMap, type CreativeTaskMap } from "../contract/creativeTaskMap";
import { CREATIVE_DIRECTOR_SYSTEM_PROMPT } from "./systemPrompt";

const DIRECTOR_TIMEOUT_MS = 60_000;

export const directorRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  /** Literal Lock evidence, serialized. */
  literalLock: z.string().max(4000),
  /** Semantic project inventory (names and descriptions, no internals). */
  inventory: z.string().max(8000),
  /** Current page/panel/selection, in creator terms. */
  context: z.string().max(2000),
});

export type DirectorRequestInput = z.infer<typeof directorRequestSchema>;

export interface DirectorResult {
  map: CreativeTaskMap;
  providerFinishReason?: string;
}

export async function planCreativeDirection(
  provider: AgentModelProvider,
  input: DirectorRequestInput,
  options: { signal?: AbortSignal } = {},
): Promise<DirectorResult> {
  const userPrompt = [
    "LITERAL LOCK (immutable evidence from the creator's prompt):",
    input.literalLock,
    "",
    "PROJECT INVENTORY:",
    input.inventory,
    "",
    "CURRENT CONTEXT:",
    input.context,
    "",
    "CREATOR'S REQUEST:",
    input.prompt,
    "",
    "Respond with the Creative Task Map JSON now.",
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECTOR_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let completion;
  try {
    completion = await provider.completeJson(CREATIVE_DIRECTOR_SYSTEM_PROMPT, userPrompt, {
      signal,
      timeoutMs: DIRECTOR_TIMEOUT_MS,
    });
  } finally {
    clearTimeout(timer);
  }

  let normalized: unknown;
  try {
    normalized = parseModelJson(completion.text);
  } catch {
    throw new AgentModelError("The creative director's response could not be parsed.", 502, { stage: "parsing" });
  }
  const { map, error } = parseCreativeTaskMap(normalized);
  if (!map) {
    throw new AgentModelError(`The creative director returned an invalid task map: ${error}`, 502, { stage: "validation" });
  }
  return { map, providerFinishReason: completion.finishReason };
}
