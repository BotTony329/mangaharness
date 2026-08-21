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
import type { AgentRunScope } from "../scope";

const layoutIds = ["single", "two-vertical", "two-horizontal", "three-vertical", "four-grid", "yonkoma"] as const;
const cropModes = ["fit", "fill", "upper-body", "face", "custom"] as const;
const panelIndex = z.number().int().min(1).max(12).describe("1-based panel number in reading order");

export const toolSchemas = {
  create_character: z.object({
    name: z.string().min(1).max(80),
    appearance: z.string().max(600).optional(),
    personalityNotes: z.string().max(400).optional(),
    /** Legacy planner compatibility; appearance is preferred. */
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

  place_character: z.object({
    panel: panelIndex,
    characterName: z.string().min(1).max(80),
    pose: z.string().max(80).optional(),
    expression: z.string().max(80).optional(),
    outfit: z.string().max(120).optional(),
    view: z.string().max(80).optional(),
    cropMode: z.enum(cropModes).optional(),
    flipX: z.boolean().optional(),
    generateIfMissing: z.boolean().optional(),
  }),

  compose_character: z.object({
    panel: panelIndex,
    characterName: z.string().min(1).max(80),
    pose: z.string().max(80).optional(),
    expression: z.string().max(80).optional(),
    outfit: z.string().max(120).optional(),
    view: z.string().max(80).optional(),
    framing: z.enum(["full-body", "medium-full", "medium", "upper-body", "close-up", "face"]).optional(),
    position: z.enum(["left", "center", "right"]).optional(),
    facing: z.enum(["left", "right", "camera"]).optional(),
    depth: z.enum(["foreground", "midground", "background"]).optional(),
    role: z.string().max(100).optional(),
    generateIfMissing: z.boolean().optional(),
  }),

  reuse_scene_background: z.object({
    sourcePanel: panelIndex,
    targetPanel: panelIndex,
  }),

  add_scene_relationship: z.object({
    panel: panelIndex,
    subjectCharacterName: z.string().min(1).max(80),
    action: z.string().min(1).max(160),
    targetCharacterName: z.string().min(1).max(80).optional(),
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
    effectKind: z.enum(["speed-lines", "focus-lines", "screentone", "impact-burst", "emotion"]),
    /** Semantic attachment: the character the effect describes (§16). */
    targetCharacterName: z.string().max(80).optional(),
    intensity: z.number().min(0).max(1).optional(),
  }),

  // ── Virtual manga stage: the director's semantic vocabulary (§18) ──
  set_camera: z.object({
    panel: panelIndex,
    shot: z.enum(["extreme-wide", "wide", "full", "medium", "close-up", "extreme-close-up"]).optional(),
    angle: z.enum(["eye-level", "high", "low", "overhead", "dutch"]).optional(),
    lens: z.enum(["wide", "normal", "telephoto"]).optional(),
    mangaPerspective: z.number().int().min(0).max(3).optional().describe("0 normal, 1 subtle, 2 dramatic, 3 extreme"),
  }),

  set_perspective: z.object({
    panel: panelIndex,
    type: z.enum(["none", "one-point", "two-point", "three-point"]),
    horizonY: z.number().min(0).max(1).optional().describe("Eye level: 0 top edge, 1 bottom edge"),
  }),

  set_character_depth: z.object({
    panel: panelIndex,
    characterName: z.string().max(80).optional(),
    /** Semantic placement; preferred over a raw number (§16). */
    placement: z.enum(["foreground", "midground", "background"]).optional(),
    depth: z.number().min(0).max(1).optional().describe("0 nearest the camera, 1 furthest away"),
    groundY: z.number().min(0).max(1).optional().describe("Ground contact line in the panel"),
  }),

  set_focal_character: z.object({
    panel: panelIndex,
    characterName: z.string().max(80).describe("The subject camera framing works around"),
  }),

  set_character_pose_rig: z.object({
    panel: panelIndex,
    characterName: z.string().max(80).optional(),
    basePose: z.string().max(80).optional().describe("Preset to start from; omit to keep the current pose"),
    /** Same semantic vocabulary the joint editor produces (§12). */
    adjustments: z
      .array(z.string().max(60))
      .max(8)
      .describe('Pose descriptors, e.g. ["right arm raised", "head turned left"]'),
  }),

  attach_bubble: z.object({
    panel: panelIndex,
    characterName: z.string().max(80),
    bubbleType: z.enum(["speech", "thought", "shout", "whisper", "narration"]),
    text: z.string().min(1).max(300),
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
  targetScope?: AgentRunScope;
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
export function validatePlan(raw: unknown, scope?: AgentRunScope): PlanValidation {
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
    const scopeError = scope ? validateStepScope(step.tool as ToolName, args.data as Record<string, unknown>, scope) : null;
    if (scopeError) {
      rejected.push({ tool: step.tool, error: scopeError });
      continue;
    }
    steps.push({ tool: step.tool as ToolName, args: args.data as Record<string, unknown>, reason: step.reason });
  }
  return { plan: { summary: parsed.data.summary, steps, targetScope: scope }, rejected };
}

const PANEL_TOOLS = new Set<ToolName>([
  "place_asset",
  "place_character",
  "compose_character",
  "add_scene_relationship",
  "set_character_slot",
  "reshape_panel",
  "set_crop_mode",
  "add_speech_bubble",
  "add_effect",
  "remove_items",
  "set_camera",
  "set_perspective",
  "set_character_depth",
  "attach_bubble",
  "set_character_pose_rig",
  "set_focal_character",
]);

/** Pure guard used both while validating model output and immediately before execution. */
export function validateStepScope(tool: ToolName, args: Record<string, unknown>, scope: AgentRunScope): string | null {
  if (scope.kind === "selected-object") {
    if (tool === "set_character_slot" && (args.panel === undefined || args.panel === scope.panelNumber)) return null;
    return `Scope violation: ${scope.label} permits only semantic changes to the selected character object`;
  }
  if (scope.kind === "selected-panel") {
    if (tool === "set_page_layout") return `Scope violation: ${scope.label} cannot change the page layout`;
    if (tool === "place_asset" && args.target === "workspace") {
      return `Scope violation: ${scope.label} cannot place assets outside the panel`;
    }
    if (PANEL_TOOLS.has(tool) && args.panel !== scope.panelNumber) {
      return `Scope violation: ${scope.label} allows only panel ${scope.panelNumber}`;
    }
    if (tool === "reuse_scene_background" && args.targetPanel !== scope.panelNumber) {
      return `Scope violation: ${scope.label} allows only panel ${scope.panelNumber}`;
    }
  }
  if (PANEL_TOOLS.has(tool) && typeof args.panel === "number" && args.panel > scope.panelCount) {
    return `Scope violation: panel ${args.panel} is outside ${scope.pageName}`;
  }
  if (tool === "reuse_scene_background") {
    if (typeof args.sourcePanel === "number" && args.sourcePanel > scope.panelCount) return `Scope violation: source panel ${args.sourcePanel} is outside ${scope.pageName}`;
    if (typeof args.targetPanel === "number" && args.targetPanel > scope.panelCount) return `Scope violation: target panel ${args.targetPanel} is outside ${scope.pageName}`;
  }
  return null;
}

/** Tool documentation injected into the planner's system prompt. */
export const TOOL_DOCS = `
Available tools (call only these, with exactly these argument shapes):

- create_character {name, appearance?, personalityNotes?} — add a new character identity. Appearance describes physical identity; never put rendering style here because the project Art Style is applied automatically.
- generate_character_asset {characterName, kind: "reference"|"pose"|"expression", pose?, expression?, outfit?, view?, instruction?} — AI-generate a reusable full-state character asset. "reference" creates the canonical identity image.
- generate_background {description, name?} — AI-generate a reusable background.
- generate_prop {description, name?} — AI-generate a reusable prop.
- set_page_layout {layout: "single"|"two-vertical"|"two-horizontal"|"three-vertical"|"four-grid"|"yonkoma"} — replace the current page's panel arrangement (existing content is preserved).
- place_asset {panel?, target?, characterName?, pose?, expression?, outfit?, view?, assetName?, category?, cropMode?, flipX?} — place a library asset. Default target is the given panel; target:"workspace" stages it as a loose reference beside the page instead.
- place_character {panel, characterName, pose?, expression?, outfit?, view?, cropMode?, flipX?, generateIfMissing?} — preferred semantic character placement. Resolve the Character entity first, reuse a cached asset matching every requested state field, and generate the missing state only when needed.
- compose_character {panel, characterName, pose?, expression?, outfit?, view?, framing?, position?, facing?, depth?, role?, generateIfMissing?} — preferred scene-aware placement. Resolve or generate the semantic Character state, then compose it with explicit shot, position, facing, depth, and narrative role.
- reuse_scene_background {sourcePanel, targetPanel} — reuse the exact same background asset and continuity metadata; never regenerate a merely similar location.
- add_scene_relationship {panel, subjectCharacterName, action, targetCharacterName?} — record semantic action/interaction in the panel scene graph.
- set_character_slot {panel?, characterName?, pose?, expression?, outfit?, view?, generateIfMissing?} — change the selected character's semantic state. Unspecified fields MUST remain unchanged ("make her cry" changes expression only; "run angrily" changes pose and expression). The shared resolver reuses an exact full-state cache hit or generates the missing combination, then swaps it without changing composition.
- set_crop_mode {panel, characterName?, category?, mode: "fit"|"fill"|"upper-body"|"face"|"custom"} — reframe an already-placed instance. "upper-body" = medium shot, "fill" = full-bleed. Close-ups come from crop modes, never from regenerating.
- reshape_panel {panel, points} — replace a panel's polygon (3-8 points, normalized 0-1 page coords). Use for dynamic/diagonal action layouts; keep shapes readable and non-overlapping.
- add_speech_bubble {panel, bubbleType: "speech"|"thought"|"shout"|"narration", text, position?} — add dialogue.
- add_effect {panel, effectKind: "speed-lines"|"focus-lines"|"screentone"|"impact-burst"} — add a manga effect layer.
- set_camera {panel, shot?, angle?, lens?, mangaPerspective?} — direct the panel. Use the semantic vocabulary (close-up, low angle) rather than moving objects to fake a shot.
- set_perspective {panel, type, horizonY?} — establish construction guides. These are editor guides only and never appear in the exported page.
- set_character_depth {panel, characterName?, placement?, depth?, groundY?} — place a character in stage depth. Prefer placement ("foreground"|"midground"|"background") over a raw depth number. Size and ground contact follow automatically; do not also set scale or position.
- set_focal_character {panel, characterName} — name the subject the camera frames. Set this before changing shot, so a close-up frames that character rather than the middle of the panel.
- set_character_pose_rig {panel, characterName?, basePose?, adjustments} — adjust a placed character's pose semantically, e.g. basePose "walking" with adjustments ["right arm raised","head turned left"]. Identity, expression, outfit, view and props are preserved; only pose geometry changes. Prefer this over regenerating a character to change a limb.
- attach_bubble {panel, characterName, bubbleType, text} — add dialogue that BELONGS to a character, so the tail keeps pointing at them when they move. Prefer this over add_speech_bubble whenever a speaker is known.
- remove_items {panel, kind?} — remove items from a panel (only when the user asked for replacement/clearing).
`.trim();
