/**
 * Creative Task Map — the provider-independent contract between the Main
 * Creative LLM and the deterministic harness.
 *
 * The LLM (Creative Director) decides WHAT the user means and WHAT should
 * happen creatively; this schema is the only thing it may output. It contains
 * CREATIVE INTENT addressed by name — never runtime identity. No characterId,
 * assetId, panelId, sceneId, semantic placeholder or invented ID of any kind:
 * the planner does not own runtime identity, the harness binds refs to real
 * IDs during project resolution.
 *
 * Serializable, inspectable, testable, versioned.
 */

import { z } from "zod";

export const CREATIVE_TASK_MAP_VERSION = 1;

const name = z.string().min(1).max(80);

export const participantSchema = z.object({
  /** Stable within this map: other tasks refer to the participant by this name. */
  name,
  /** create_if_missing = the prompt introduced them; existing = must already be in the project. */
  resolutionIntent: z.enum(["existing", "create_if_missing"]),
  /** Attributes/descriptions bound to this participant (nationality, role, appearance…). */
  attributes: z.array(z.string().max(120)).max(8).default([]),
  /** Relationships to other participants, by name. */
  relationships: z
    .array(z.object({ type: z.string().max(40), target: name }))
    .max(6)
    .default([]),
});

export const beatSchema = z.object({
  /** Panel this beat plays in (1-based, within the target page). Omit = current/selected panel. */
  panel: z.number().int().min(1).max(12).optional(),
  /** Who acts — a participant name. */
  actor: name,
  /** The action, preserved whole ("walking toward the camera", never downgraded to "standing"). */
  action: z.string().max(200).optional(),
  /** Compound poses stay compound: bodyOrientation / stance / head / gaze, as stated. */
  poseDetails: z.array(z.string().max(80)).max(6).default([]),
  /** A second participant for interactions ("chasing Momo" → target Momo). */
  target: name.optional(),
  /** The interaction kind when the beat names one. */
  interaction: z
    .enum(["beside", "face_to_face", "look_at", "hold_hands", "hug", "high_five", "hand_object", "lean_on", "walk_together", "sit_together"])
    .optional(),
  /** Exact dialogue, byte-preserved from quotes in the prompt. */
  dialogue: z.string().min(1).max(300).optional(),
  dialogueKind: z.enum(["speech", "thought", "shout", "whisper", "narration"]).default("speech"),
  /** Expression change for the actor. */
  expression: z.string().max(80).optional(),
});

export const cameraIntentSchema = z.object({
  /**
   * CREATIVE vocabulary, not editor enums. The director speaks in creative
   * intent ("dramatic", "intimate", "compressed"); translation to editor
   * shot/angle/lens happens exactly once, in agent-v3/routing/cameraSemantics.
   */
  shot: z.string().max(40).optional(),
  angle: z.string().max(40).optional(),
  lens: z.string().max(40).optional(),
  /** Free-text dramatic intent ("motion", "tension") — never compiled away. */
  dramaticIntent: z.string().max(120).optional(),
  /**
   * True when the camera implies a redrawn viewpoint (low/high angle, extreme
   * perspective): generation must receive the camera BEFORE composition, not
   * a scale/crop afterwards.
   */
  requiresRedraw: z.boolean().default(false),
});

export const creativeTaskMapSchema = z.object({
  version: z.literal(CREATIVE_TASK_MAP_VERSION).default(CREATIVE_TASK_MAP_VERSION),
  /** One sentence a creator would recognise as their own request. */
  summary: z.string().max(200),
  intent: z.enum(["new_scene", "continue_scene", "modify_existing", "dialogue_only", "restyle", "unclear"]),
  participants: z.array(participantSchema).max(6).default([]),
  scene: z
    .object({
      /** Scene description to create, or exact name of an inventory scene to reuse. */
      description: z.string().max(300),
      reuseExisting: z.string().max(80).optional(),
    })
    .optional(),
  objects: z.array(z.object({ description: z.string().max(200), name: z.string().max(80).optional() })).max(4).default([]),
  beats: z.array(beatSchema).max(12).default([]),
  cameraIntent: cameraIntentSchema.optional(),
  effects: z.array(z.object({ kind: z.string().max(40), panel: z.number().int().min(1).max(12).optional() })).max(6).default([]),
  tone: z.object({ mood: z.string().max(60), panel: z.number().int().min(1).max(12).optional() }).optional(),
  localEdits: z
    .array(z.object({ target: name, panel: z.number().int().min(1).max(12), instruction: z.string().min(3).max(600) }))
    .max(4)
    .default([]),
  target: z
    .object({
      scope: z.enum(["selected_panel", "current_page", "whole_project"]).default("current_page"),
      panel: z.number().int().min(1).max(12).optional(),
    })
    .default({ scope: "current_page" }),
  /** Genuine ambiguity that blocks creation — the UI asks the creator, in their words. */
  clarificationNeeded: z.string().max(200).optional(),
});

export type CreativeTaskMap = z.infer<typeof creativeTaskMapSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type Beat = z.infer<typeof beatSchema>;
export type CameraIntent = z.infer<typeof cameraIntentSchema>;

/**
 * Structural normalization at the LLM boundary.
 *
 * STRUCTURAL NORMALIZATION ≠ SEMANTIC GUESSING. This only repairs JSON
 * shapes models commonly emit for OPTIONAL fields: explicit null, empty
 * strings, untrimmed whitespace, null array entries. It never invents or
 * reinterprets semantic content — a required field that is null still fails
 * validation, just at a precise path.
 */
export function normalizeCreativeTaskMap(raw: unknown): unknown {
  if (raw === null) return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => normalizeCreativeTaskMap(entry))
      .filter((entry) => entry !== undefined);
  }
  if (typeof raw === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const normalized = normalizeCreativeTaskMap(value);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return raw;
}

export function parseCreativeTaskMap(raw: unknown): { map?: CreativeTaskMap; error?: string } {
  const parsed = creativeTaskMapSchema.safeParse(normalizeCreativeTaskMap(raw));
  if (!parsed.success) {
    // Field paths are the whole point: "beats[0].dialogue — expected string,
    // received null" is actionable; "Invalid input" is not.
    const formatPath = (path: PropertyKey[]) =>
      path.reduce<string>((acc, seg) => (typeof seg === "number" ? `${acc}[${seg}]` : acc ? `${acc}.${String(seg)}` : String(seg)), "");
    const details = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${formatPath(issue.path) || "(root)"} — ${issue.message}`)
      .join("; ");
    return { error: `Creative Task Map invalid: ${details}` };
  }
  const map = parsed.data;
  // Defence in depth: a ref that LOOKS like a runtime ID is rejected here,
  // before resolution — planner output carries names, never identity.
  const idLike = /^(?:new_|tmp_|semantic_|char_|asset_|panel_)|_placeholder$/i;
  for (const participant of map.participants) {
    if (idLike.test(participant.name)) return { error: `Participant ref "${participant.name}" looks like a runtime ID. Names only.` };
  }
  return { map };
}
