"use client";

/**
 * Interaction Semantic Normalization — same layer as cameraSemantics.
 *
 * The Creative Director describes relationships in natural language
 * ("comforts", "argues with", "leans on"); the editor only executes the
 * InteractionType enum. This is the only place that translation may happen.
 *
 * Unknown wording is SOFT: the raw intent is preserved and the caller falls
 * back to placement + scene relationship — it never kills the run and never
 * throws the raw creative text away.
 */

import type { InteractionParameters, InteractionType } from "@/domain/types";

const INTERACTION_MAP: Record<string, InteractionType> = {
  beside: "beside",
  "next to": "beside",
  alongside: "beside",
  face_to_face: "face_to_face",
  "face to face": "face_to_face",
  facing: "face_to_face",
  confront: "face_to_face",
  confronts: "face_to_face",
  "faces off": "face_to_face",
  argue: "face_to_face",
  argues: "face_to_face",
  arguing: "face_to_face",
  look_at: "look_at",
  "look at": "look_at",
  "looking at": "look_at",
  stare: "look_at",
  stares: "look_at",
  watch: "look_at",
  watches: "look_at",
  "checks on": "look_at",
  hold_hands: "hold_hands",
  "hold hands": "hold_hands",
  "holding hands": "hold_hands",
  handhold: "hold_hands",
  hug: "hug",
  hugs: "hug",
  hugging: "hug",
  embrace: "hug",
  embraces: "hug",
  comfort: "hug",
  comforts: "hug",
  console: "hug",
  consoles: "hug",
  reassure: "hug",
  reassures: "hug",
  high_five: "high_five",
  "high five": "high_five",
  highfive: "high_five",
  hand_object: "hand_object",
  "hands over": "hand_object",
  give: "hand_object",
  gives: "hand_object",
  pass: "hand_object",
  passes: "hand_object",
  offer: "hand_object",
  offers: "hand_object",
  lean_on: "lean_on",
  "lean on": "lean_on",
  "leans on": "lean_on",
  "leaning on": "lean_on",
  "lean against": "lean_on",
  "leans against": "lean_on",
  walk_together: "walk_together",
  "walk together": "walk_together",
  "walking together": "walk_together",
  "walk with": "walk_together",
  sit_together: "sit_together",
  "sit together": "sit_together",
  "sitting together": "sit_together",
  "sit beside": "sit_together",
  "sits beside": "sit_together",
};

export interface ResolvedInteraction {
  /** Editor-executable type, or undefined when the wording has no mapping. */
  type?: InteractionType | (string & {});
  /** Editable semantics extracted from the wording ("hug from behind"). */
  parameters?: InteractionParameters;
  /** The director's original wording — always preserved for fallbacks. */
  raw: string;
  warning?: string;
}

/** Verbs that name a first-class custom interaction rather than a soft fallback. */
const CUSTOM_VERBS = new Set([
  "eat", "eats", "eating", "drink", "drinks", "drinking", "drive", "drives", "driving",
  "ride", "rides", "riding", "carry", "carries", "carrying", "hold", "holds", "holding",
  "sit", "sits", "sitting", "read", "reads", "reading", "wear", "wears", "wearing",
  "kiss", "kisses", "kissing", "push", "pushes", "pushing", "pull", "pulls", "pulling",
  "chase", "chases", "chasing", "fight", "fights", "fighting", "carry on back", "piggyback",
]);

const DIRECTION_PATTERN = /\bfrom (behind|the front|the side|the left|the right|above|below)\b/iu;

export function resolveInteraction(raw: string | undefined): ResolvedInteraction | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  /**
   * "hug from behind" is a hug with a direction, not an unknown wording: the
   * direction is editable semantics (v0.2), so it is extracted into parameters
   * instead of killing the mapping.
   */
  const direction = key.match(DIRECTION_PATTERN)?.[0];
  const withoutDirection = direction ? key.replace(DIRECTION_PATTERN, "").trim() : key;
  // Directors attach prepositions to the verb ("argues with", "leans on"…);
  // try the full wording, then the wording minus a trailing preposition.
  const candidates = [withoutDirection, withoutDirection.replace(/\s+(with|to|at|against|on|onto|toward|towards)$/u, "")];
  const parameters: InteractionParameters | undefined = direction ? { direction } : undefined;
  for (const candidate of candidates) {
    const type = INTERACTION_MAP[candidate];
    if (type) return { type, parameters, raw };
    if (CUSTOM_VERBS.has(candidate)) return { type: candidate, parameters, raw };
  }
  return { raw, warning: `Unsupported interaction intent "${raw}"; falling back to placement + scene relationship.` };
}
