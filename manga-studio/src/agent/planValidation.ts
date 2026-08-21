/**
 * Grounded plan validation — the gate between "the model proposed this" and
 * "the document is mutated".
 *
 * Two jobs:
 *
 * 1. **Bind names to IDs.** Every character-referencing argument is resolved
 *    once, here, against the grounding report, and the resolved `characterId`
 *    is written into the step. Execution then works from a stable ID instead
 *    of re-running a name match per call site.
 *
 * 2. **Refuse before mutating.** A step that references a character that does
 *    not exist, an ambiguous reference, a panel that is not there, a creation
 *    the user never asked for, or a generation that would duplicate an asset
 *    already in the library is rejected while the document is still untouched.
 *    Previously these surfaced as mid-run step failures, which is how a run
 *    could place the wrong character and keep going.
 */

import { DEFAULT_CHARACTER_STATE, stateFromAsset } from "@/characters/state";
import { isAssetReadyForComposition } from "@/assets/renderSource";
import type { Character, CharacterState, ID, MangaLanguageCategory, ProjectDocument } from "@/domain/types";
import { bestLanguageAsset } from "@/language/library";
import {
  normalizeReference,
  resolveCharacterReference,
  type CharacterResolution,
  type GroundingReport,
} from "./grounding";
import type { AgentRunScope } from "./scope";
import { validateStepScope, type AgentPlan, type ToolName } from "./tools/schemas";

/** Which argument on each tool names a character, and where its ID belongs. */
interface CharacterArgBinding {
  nameArg: string;
  idArg: string;
  /** A step whose character argument is absent targets the selection instead. */
  required: boolean;
}

const CHARACTER_BINDINGS: Partial<Record<ToolName, CharacterArgBinding[]>> = {
  generate_character_asset: [{ nameArg: "characterName", idArg: "characterId", required: true }],
  place_asset: [{ nameArg: "characterName", idArg: "characterId", required: false }],
  place_character: [{ nameArg: "characterName", idArg: "characterId", required: true }],
  compose_character: [{ nameArg: "characterName", idArg: "characterId", required: true }],
  add_scene_relationship: [
    { nameArg: "subjectCharacterName", idArg: "subjectCharacterId", required: true },
    { nameArg: "targetCharacterName", idArg: "targetCharacterId", required: false },
  ],
  set_character_slot: [{ nameArg: "characterName", idArg: "characterId", required: false }],
  create_interaction: [
    { nameArg: "subjectCharacterName", idArg: "subjectCharacterId", required: true },
    { nameArg: "targetCharacterName", idArg: "targetCharacterId", required: true },
  ],
  set_crop_mode: [{ nameArg: "characterName", idArg: "characterId", required: false }],
  add_effect: [{ nameArg: "targetCharacterName", idArg: "targetCharacterId", required: false }],
  set_character_depth: [{ nameArg: "characterName", idArg: "characterId", required: false }],
  set_focal_character: [{ nameArg: "characterName", idArg: "characterId", required: true }],
  set_character_pose_rig: [{ nameArg: "characterName", idArg: "characterId", required: false }],
  attach_bubble: [{ nameArg: "characterName", idArg: "characterId", required: true }],
  set_puppet_expression: [{ nameArg: "characterName", idArg: "characterId", required: false }],
  set_puppet_joint: [{ nameArg: "characterName", idArg: "characterId", required: false }],
  place_manga_effect: [{ nameArg: "targetCharacterName", idArg: "targetCharacterId", required: false }],
  generate_manga_effect: [{ nameArg: "targetCharacterName", idArg: "targetCharacterId", required: false }],
};

export interface GroundedPlanValidation {
  plan: AgentPlan;
  rejected: { tool: string; error: string }[];
  /** True when the run must not start at all; `blockReason` explains why. */
  blocked: boolean;
  blockReason?: string;
  /**
   * Character IDs this run is permitted to create. Carried into execution as
   * the generation-boundary authorization (§19).
   */
  creationAuthorized: boolean;
  authorizedCreationNames: string[];
}

export interface GroundedPlanInput {
  plan: AgentPlan;
  doc: ProjectDocument;
  grounding: GroundingReport;
  scope?: AgentRunScope;
  /** Panel count of the page the run targets; steps beyond it are rejected. */
  panelCount?: number;
}

export function validateGroundedPlan(input: GroundedPlanInput): GroundedPlanValidation {
  const { plan, doc, grounding, scope } = input;
  const projectCharacters = Object.values(doc.characters);
  const rejected: GroundedPlanValidation["rejected"] = [];
  const steps: AgentPlan["steps"] = [];

  /**
   * Characters the plan itself creates earlier in the same run. A later step
   * may reference them by name even though they do not exist yet — that is
   * legitimate, and distinct from referencing a character that will never
   * exist.
   */
  /**
   * Names that will EXIST by the time these steps run.
   *
   * Validation runs before requirement fulfilment, so a character the run is
   * about to create is absent from the document right now. Judging a step
   * against the document as it is today rejected exactly the runs this
   * architecture is meant to enable — "place Roach Man" failed as "does not
   * exist" while the stage that creates Roach Man was already queued. A step
   * is validated against the state it will actually run in.
   */
  const pendingNames = new Set<string>();

  /**
   * Who this run may create.
   *
   * Authorization comes from ENTITY RESOLUTION, not from spotting a verb.
   * Every reference the grounder classified as self-identifying — "Roach Man",
   * "a cockroach superhero", a name the library has never heard of — is a
   * character the creator introduced, so creating them is exactly what was
   * asked for. An explicit "create a character called X" still contributes its
   * name, so both routes agree.
   */
  const authorizedNames = [
    ...grounding.creation.requestedNames,
    ...grounding.entities
      .map((entity) => (entity.resolution?.status === "create" ? entity.resolution.proposedName : undefined))
      .filter((name): name is string => Boolean(name)),
  ].map(normalizeReference);
  const creationAuthorized = grounding.creation.allowed || authorizedNames.length > 0;
  for (const entity of grounding.entities) {
    if (entity.resolution?.status === "create") pendingNames.add(normalizeReference(entity.resolution.proposedName));
  }

  for (const step of plan.steps) {
    const args = { ...step.args };
    let error: string | null = null;

    // ── Panel existence ──
    if (input.panelCount !== undefined) {
      for (const key of ["panel", "sourcePanel", "targetPanel"] as const) {
        const value = args[key];
        if (typeof value === "number" && (value < 1 || value > input.panelCount)) {
          error = `Panel ${value} does not exist (the page has ${input.panelCount}).`;
        }
      }
    }

    // ── Creation is privileged (§6/§19) ──
    if (!error && step.tool === "create_character") {
      const name = typeof args.name === "string" ? args.name : "";
      const creationError = creationRejection(name, grounding, authorizedNames, projectCharacters);
      if (creationError) error = creationError;
      else pendingNames.add(normalizeReference(name));
    }

    // ── Bind every character reference to a real ID ──
    if (!error) {
      for (const binding of CHARACTER_BINDINGS[step.tool] ?? []) {
        const raw = args[binding.nameArg];
        if (typeof raw !== "string" || raw.trim().length === 0) {
          if (binding.required) error = `${step.tool} needs a character reference.`;
          continue;
        }
        if (pendingNames.has(normalizeReference(raw))) continue; // created earlier in this plan
        const resolution = resolveCharacterReference({
          query: raw,
          projectCharacters,
          selectedCharacterId: grounding.selectedCharacterId,
          sceneCharacterIds: grounding.sceneCharacterIds,
        });
        if (resolution.status === "resolved") {
          args[binding.idArg] = resolution.characterId;
          // Keep the display name truthful to the entity that was bound, so a
          // step label can never read "Yuri" while operating on someone else.
          args[binding.nameArg] = resolution.name;
          continue;
        }
        error =
          resolution.status === "ambiguous"
            ? `${resolution.reason} Refusing to guess which character "${raw}" means.`
            : `Character "${raw}" does not exist in this project. Refusing to substitute another character or create one.`;
        break;
      }
    }

    // ── Reuse before generate (§9/§10) ──
    if (!error && step.tool === "generate_character_asset") {
      error = generationRejection(args, doc, grounding, authorizedNames, pendingNames);
    }

    /**
     * The same rule for manga language: an effect the library already holds is
     * never worth an image generation. This is the deterministic half of
     * SEARCH → REUSE → GENERATE — the planner's judgement is not trusted with
     * a decision that costs money and can be checked exactly.
     */
    if (!error && step.tool === "generate_manga_effect") {
      const existing = bestLanguageAsset(doc, {
        category: args.category as MangaLanguageCategory | undefined,
        text: typeof args.description === "string" ? args.description : undefined,
      });
      if (existing) {
        error = `The library already has "${existing.name}" for that. Use place_manga_effect to reuse it instead of generating.`;
      }
    }

    // ── Scope (unchanged rules, re-checked after ID binding) ──
    if (!error && scope) error = validateStepScope(step.tool, args, scope);

    if (error) {
      rejected.push({ tool: step.tool, error });
      continue;
    }
    steps.push({ tool: step.tool, args, reason: step.reason });
  }

  /**
   * A plan that referenced an unresolvable character must not run at all. It
   * is not enough to drop that one step: the remaining steps were written on
   * the assumption that it succeeded, and executing them is exactly how a
   * panel ends up holding the wrong character.
   */
  const identityRejections = rejected.filter(
    (entry) => entry.error.includes("does not exist in this project") || entry.error.includes("Refusing to guess"),
  );
  const blocked = grounding.blocking.length > 0 || identityRejections.length > 0;
  const blockReason = blocked
    ? [...grounding.blocking, ...identityRejections.map((entry) => entry.error)][0]
    : undefined;

  return {
    plan: { ...plan, steps },
    rejected,
    blocked,
    blockReason,
    creationAuthorized,
    authorizedCreationNames: authorizedNames,
  };
}

/**
 * NOT_FOUND must never mean create. Creation is allowed only when the prompt
 * asked for it, and — when the prompt named who to create — only for that name.
 */
function creationRejection(
  name: string,
  grounding: GroundingReport,
  authorizedNames: string[],
  projectCharacters: Character[],
): string | null {
  if (name.trim().length === 0) return "create_character needs a name.";
  const normalized = normalizeReference(name);

  const existing = resolveCharacterReference({ query: name, projectCharacters });
  if (existing.status === "resolved") {
    return `"${existing.name}" already exists — reuse character ${existing.characterId} instead of creating a duplicate.`;
  }

  /**
   * The rule is no longer "was a creation verb used" but "did the creator's own
   * words introduce THIS entity". A name nobody typed is still refused, which
   * is what stops a planner inventing a cast around the request.
   */
  if (!authorizedNames.includes(normalized)) {
    return authorizedNames.length > 0
      ? `Creation was authorized for ${authorizedNames.join(", ")}, not "${name}".`
      : `Creating the character "${name}" was not requested. Failing to resolve a name is not permission to invent a character.`;
  }
  return null;
}

/**
 * REUSE → MODIFY → GENERATE. A generation step that would reproduce a state
 * already sitting in the library is rejected rather than paid for.
 */
function generationRejection(
  args: Record<string, unknown>,
  doc: ProjectDocument,
  grounding: GroundingReport,
  authorizedNames: string[],
  pendingNames: Set<string>,
): string | null {
  const characterId = typeof args.characterId === "string" ? args.characterId : undefined;
  const name = typeof args.characterName === "string" ? args.characterName : "";
  const character = characterId ? doc.characters[characterId] : undefined;

  if (!character) {
    // Only reachable for a character this plan is creating; that is fine when
    // creation was authorized, and impossible otherwise.
    if (pendingNames.has(normalizeReference(name))) return null;
    if (!grounding.creation.allowed) {
      return `Refusing to generate artwork for "${name}": it is not an existing character and creation was not requested.`;
    }
    if (authorizedNames.length > 0 && !authorizedNames.includes(normalizeReference(name))) {
      return `Creation was authorized for ${authorizedNames.join(", ")}, not "${name}".`;
    }
    return null;
  }

  if (args.kind === "reference" && (character.canonicalReferenceAssetId ?? character.referenceAssetId)) {
    return `${character.name} already has a canonical reference. Generate a state instead of a second identity image.`;
  }
  if (args.kind === "reference") return null;

  const desired = desiredState(character.id, args);
  return hasExactState(doc, character, desired)
    ? `${character.name} already has a cached ${describeState(desired)} state. Reuse it instead of generating a duplicate.`
    : null;
}

function desiredState(characterId: ID, args: Record<string, unknown>): CharacterState {
  const field = (key: string, fallback: string) =>
    typeof args[key] === "string" && (args[key] as string).trim() ? (args[key] as string).trim().toLowerCase() : fallback;
  return {
    characterId,
    pose: field("pose", DEFAULT_CHARACTER_STATE.pose),
    expression: field("expression", DEFAULT_CHARACTER_STATE.expression),
    outfit: field("outfit", DEFAULT_CHARACTER_STATE.outfit),
    view: field("view", DEFAULT_CHARACTER_STATE.view),
  };
}

function describeState(state: CharacterState): string {
  return `${state.pose}/${state.expression}`;
}

/** Exact full-state cache hit across every asset linked to the character. */
export function hasExactState(doc: ProjectDocument, character: Character, desired: CharacterState): boolean {
  const ids = new Set(character.assetIds);
  for (const asset of Object.values(doc.assets)) {
    if (asset.metadata?.characterId === character.id) ids.add(asset.id);
  }
  for (const id of ids) {
    const asset = doc.assets[id];
    if (!isAssetReadyForComposition(asset)) continue;
    if (asset!.metadata?.characterAssetRole === "canonical") continue;
    const state = stateFromAsset(asset!, character.id);
    if (
      state &&
      state.pose === desired.pose &&
      state.expression === desired.expression &&
      state.outfit === desired.outfit &&
      state.view === desired.view
    ) {
      return true;
    }
  }
  return false;
}

/** Convenience for callers that only need the resolution, not a whole plan. */
export function resolveForExecution(
  doc: ProjectDocument,
  reference: string,
  context: { selectedCharacterId?: ID; sceneCharacterIds?: ID[] } = {},
): CharacterResolution {
  return resolveCharacterReference({
    query: reference,
    projectCharacters: Object.values(doc.characters),
    selectedCharacterId: context.selectedCharacterId,
    sceneCharacterIds: context.sceneCharacterIds,
  });
}
