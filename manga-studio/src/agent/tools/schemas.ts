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
    outfit: z.string().max(120).optional(),
    view: z.string().max(80).optional(),
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
    panel: panelIndex.optional().describe("Omit with target:'workspace' to stage the asset beside the page"),
    target: z.enum(["panel", "workspace"]).optional(),
    characterName: z.string().max(80).optional(),
    pose: z.string().max(80).optional(),
    expression: z.string().max(80).optional(),
    outfit: z.string().max(120).optional(),
    view: z.string().max(80).optional(),
    assetName: z.string().max(120).optional().describe("For backgrounds/props: name or description fragment"),
    category: z.enum(["character", "background", "prop", "upload"]).optional(),
    cropMode: z.enum(cropModes).optional(),
    flipX: z.boolean().optional(),
  }),

  set_character_slot: z.object({
    panel: panelIndex.optional().describe("Omit to target the user's selected character instance"),
    characterName: z.string().max(80).optional(),
    pose: z.string().max(80).optional(),
    expression: z.string().max(80).optional(),
    outfit: z.string().max(120).optional(),
    view: z.string().max(80).optional(),
    /** Missing slots generate a new asset by default; set false to only reuse. */
    generateIfMissing: z.boolean().optional(),
  }),

  reshape_panel: z.object({
    panel: panelIndex,
    points: z
      .array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }))
      .min(3)
      .max(8)
      .describe("Polygon in normalized page coordinates (0-1); diagonal cuts make action layouts"),
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
- generate_character_asset {characterName, kind: "reference"|"pose"|"expression", pose?, expression?, outfit?, view?, instruction?} — AI-generate a reusable full-state character asset. "reference" creates the canonical identity image.
- generate_background {description, name?} — AI-generate a reusable background.
- generate_prop {description, name?} — AI-generate a reusable prop.
- set_page_layout {layout: "single"|"two-vertical"|"two-horizontal"|"three-vertical"|"four-grid"|"yonkoma"} — replace the current page's panel arrangement (existing content is preserved).
- place_asset {panel?, target?, characterName?, pose?, expression?, outfit?, view?, assetName?, category?, cropMode?, flipX?} — place a library asset. Default target is the given panel; target:"workspace" stages it as a loose reference beside the page instead.
- set_character_slot {panel?, characterName?, pose?, expression?, outfit?, view?, generateIfMissing?} — change the selected character's semantic state. Unspecified fields MUST remain unchanged ("make her cry" changes expression only; "run angrily" changes pose and expression). The shared resolver reuses an exact full-state cache hit or generates the missing combination, then swaps it without changing composition.
- set_crop_mode {panel, characterName?, category?, mode: "fit"|"fill"|"upper-body"|"face"|"custom"} — reframe an already-placed instance. "upper-body" = medium shot, "fill" = full-bleed. Close-ups come from crop modes, never from regenerating.
- reshape_panel {panel, points} — replace a panel's polygon (3-8 points, normalized 0-1 page coords). Use for dynamic/diagonal action layouts; keep shapes readable and non-overlapping.
- add_speech_bubble {panel, bubbleType: "speech"|"thought"|"shout"|"narration", text, position?} — add dialogue.
- add_effect {panel, effectKind: "speed-lines"|"focus-lines"|"screentone"|"impact-burst"} — add a manga effect layer.
- remove_items {panel, kind?} — remove items from a panel (only when the user asked for replacement/clearing).
`.trim();
