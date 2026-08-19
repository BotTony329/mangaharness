/**
 * The Manga Agent's tool surface. Every tool call the model plans is
 * validated against these schemas before anything executes — the model can
 * only operate the studio through this registry, never mutate state directly.
 *
 * Tools address things semantically (panel numbers, character names, slot
 * descriptors) instead of internal IDs, so a single planning pass can
 * reference assets that earlier steps will create.
 */

import { z } from "zod";

const layoutIds = ["single", "two-vertical", "two-horizontal", "three-vertical", "four-grid", "yonkoma"] as const;
const cropModes = ["fit", "fill", "upper-body", "face", "custom"] as const;
const panelIndex = z.number().int().min(1).max(12).describe("1-based panel number in reading order");

export const toolSchemas = {
  create_character: z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(600).optional(),
  }),

  generate_character_asset: z.object({
    characterName: z.string().min(1).max(80),
    kind: z.enum(["reference", "pose", "expression"]),
    pose: z.string().max(80).optional(),
    expression: z.string().max(80).optional(),
    instruction: z.string().max(500).optional(),
  }),

  generate_background: z.object({
    description: z.string().min(3).max(600),
    name: z.string().max(80).optional(),
  }),

  generate_prop: z.object({
    description: z.string().min(3).max(600),
    name: z.string().max(80).optional(),
  }),

  set_page_layout: z.object({
    layout: z.enum(layoutIds),
  }),

  place_asset: z.object({
    panel: panelIndex,
    characterName: z.string().max(80).optional(),
    pose: z.string().max(80).optional(),
    expression: z.string().max(80).optional(),
    assetName: z.string().max(120).optional().describe("For backgrounds/props: name or description fragment"),
    category: z.enum(["character", "background", "prop", "upload"]).optional(),
    cropMode: z.enum(cropModes).optional(),
    flipX: z.boolean().optional(),
  }),

  set_crop_mode: z.object({
    panel: panelIndex,
    characterName: z.string().max(80).optional(),
    category: z.enum(["character", "background", "prop", "upload"]).optional(),
    mode: z.enum(cropModes),
  }),

  add_speech_bubble: z.object({
    panel: panelIndex,
    bubbleType: z.enum(["speech", "thought", "shout", "narration"]),
    text: z.string().min(1).max(300),
    position: z.enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"]).optional(),
  }),

  add_effect: z.object({
    panel: panelIndex,
    effectKind: z.enum(["speed-lines", "focus-lines", "screentone", "impact-burst"]),
  }),

  remove_items: z.object({
    panel: panelIndex,
    kind: z.enum(["asset", "bubble", "effect"]).optional().describe("Omit to clear the panel"),
  }),
} as const;

export type ToolName = keyof typeof toolSchemas;

export interface PlannedStep {
  tool: ToolName;
  args: unknown;
  reason?: string;
}

export interface AgentPlan {
  summary: string;
  steps: { tool: ToolName; args: Record<string, unknown>; reason?: string }[];
}

export const MAX_PLAN_STEPS = 30;

const rawPlanSchema = z.object({
  summary: z.string().max(500).catch(""),
  steps: z
    .array(
      z.object({
        tool: z.string(),
        args: z.record(z.string(), z.unknown()).default({}),
        reason: z.string().max(300).optional(),
      }),
    )
    .max(MAX_PLAN_STEPS),
});

export interface PlanValidation {
  plan: AgentPlan;
  rejected: { tool: string; error: string }[];
}

/**
 * Validate raw model output into an executable plan. Unknown tools and
 * malformed args are rejected individually (reported, not executed) so one
 * bad step doesn't waste an otherwise good plan.
 */
export function validatePlan(raw: unknown): PlanValidation {
  const parsed = rawPlanSchema.safeParse(raw);
  if (!parsed.success) throw new Error("The agent returned an unreadable plan");

  const steps: AgentPlan["steps"] = [];
  const rejected: PlanValidation["rejected"] = [];
  for (const step of parsed.data.steps) {
    const schema = (toolSchemas as Record<string, z.ZodTypeAny>)[step.tool];
    if (!schema) {
      rejected.push({ tool: step.tool, error: "Unknown tool" });
      continue;
    }
    const args = schema.safeParse(step.args);
    if (!args.success) {
      rejected.push({ tool: step.tool, error: args.error.issues[0]?.message ?? "Invalid arguments" });
      continue;
    }
    steps.push({ tool: step.tool as ToolName, args: args.data as Record<string, unknown>, reason: step.reason });
  }
  return { plan: { summary: parsed.data.summary, steps }, rejected };
}

/** Tool documentation injected into the planner's system prompt. */
export const TOOL_DOCS = `
Available tools (call only these, with exactly these argument shapes):

- create_character {name, description?} — add a new character to the library.
- generate_character_asset {characterName, kind: "reference"|"pose"|"expression", pose?, expression?, instruction?} — AI-generate a reusable character asset. "reference" creates the identity image (required before poses/expressions if the character has no assets).
- generate_background {description, name?} — AI-generate a reusable background.
- generate_prop {description, name?} — AI-generate a reusable prop.
- set_page_layout {layout: "single"|"two-vertical"|"two-horizontal"|"three-vertical"|"four-grid"|"yonkoma"} — replace the current page's panel arrangement (existing content is preserved).
- place_asset {panel, characterName?, pose?, expression?, assetName?, category?, cropMode?, flipX?} — place a library asset into a panel as an independent instance. Use characterName+pose/expression for characters; assetName or category:"background"/"prop" for scenery.
- set_crop_mode {panel, characterName?, category?, mode: "fit"|"fill"|"upper-body"|"face"|"custom"} — reframe an already-placed instance. "upper-body" = medium shot, "fill" = full-bleed. Close-ups come from crop modes, never from regenerating.
- add_speech_bubble {panel, bubbleType: "speech"|"thought"|"shout"|"narration", text, position?} — add dialogue.
- add_effect {panel, effectKind: "speed-lines"|"focus-lines"|"screentone"|"impact-burst"} — add a manga effect layer.
- remove_items {panel, kind?} — remove items from a panel (only when the user asked for replacement/clearing).
`.trim();
