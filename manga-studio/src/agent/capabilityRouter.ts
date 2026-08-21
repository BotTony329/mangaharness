/**
 * What class of work does this action actually do?
 *
 * Three classes, and the difference is not cosmetic: it decides whether the
 * creator is billed for a generation, whether the run can be rolled back
 * cheaply, and whether the Agent is allowed to satisfy the request by moving
 * existing pixels around.
 *
 *   EDITOR_OP       — document state only. Never touches a provider.
 *   LOCAL_ASSET_OP  — re-renders an asset locally (puppet face, joint, crop).
 *                     Never touches a provider.
 *   AI_GENERATION   — genuinely needs new pixels. MUST reach a real provider.
 *
 * The rule that matters most: an `AI_GENERATION` request is never satisfied by
 * composing unrelated existing artwork. Overlapping two sprites is not a hug,
 * and drawing focus lines around them does not make it one.
 */

import type { ToolName } from "./tools/schemas";

export type ExecutionClass = "EDITOR_OP" | "LOCAL_ASSET_OP" | "AI_GENERATION";

/**
 * Tools that only move document state around.
 *
 * Listing them explicitly rather than inferring from the name: `set_camera`
 * and `set_character_slot` look equally innocuous, and one of them can spend
 * money.
 */
const EDITOR_OPS: ToolName[] = [
  "create_character",
  "set_page_layout",
  "place_asset",
  "place_character",
  "compose_character",
  "reuse_scene_background",
  "add_scene_relationship",
  "reshape_panel",
  "set_crop_mode",
  "add_speech_bubble",
  "add_effect",
  "set_camera",
  "set_perspective",
  "set_character_depth",
  "set_focal_character",
  "attach_bubble",
  "remove_items",
  "place_manga_effect",
];

/** Tools that re-render an asset locally, with no provider involved. */
const LOCAL_ASSET_OPS: ToolName[] = ["set_puppet_expression", "set_puppet_joint"];

/**
 * Tools that must reach a provider.
 *
 * `place_character` and `compose_character` are absent on purpose: they PREFER
 * a cached state and only escalate when nothing matches, so their class is
 * decided at run time by `escalatesToGeneration`.
 */
const AI_GENERATION: ToolName[] = [
  "generate_character_asset",
  "generate_background",
  "generate_prop",
  "generate_manga_effect",
  "create_interaction",
];

export function executionClass(tool: ToolName): ExecutionClass {
  if (AI_GENERATION.includes(tool)) return "AI_GENERATION";
  if (LOCAL_ASSET_OPS.includes(tool)) return "LOCAL_ASSET_OP";
  if (EDITOR_OPS.includes(tool)) return "EDITOR_OP";
  /**
   * Anything unclassified is treated as potentially generative. A new tool that
   * quietly spends a generation is a worse failure than one that is
   * over-cautiously counted.
   */
  return "AI_GENERATION";
}

/**
 * Tools whose class depends on whether the library already has what was asked
 * for. Reported to the creator as "may generate" rather than as a certainty.
 */
export function mayEscalateToGeneration(tool: ToolName): boolean {
  return tool === "place_character" || tool === "compose_character" || tool === "set_character_slot";
}

/** Every tool that can possibly reach a provider, for cost confirmation. */
export function couldGenerate(tool: ToolName): boolean {
  return executionClass(tool) === "AI_GENERATION" || mayEscalateToGeneration(tool);
}
