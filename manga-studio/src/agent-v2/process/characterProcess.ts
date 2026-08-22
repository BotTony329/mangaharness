"use client";

import { createCharacter } from "@/services/characters";
import { DEFAULT_CHARACTER_STATE, stateFromInstance } from "@/characters/state";
import { applyCharacterStateToInstance, generateCharacterAssetForState } from "@/characters/stateRuntime";
import type { SemanticFraming } from "@/domain/commands";
import type { Character, SourceAsset, CropMode, ID, SceneDepth, SceneFacing, ScenePosition } from "@/domain/types";
import { isAssetReadyForComposition } from "@/assets/renderSource";
import { findUnreadyCharacterAsset, requireCharacter, requestedCharacterState, resolveCharacterAsset } from "@/agent/resolver";
import { hasExactState } from "@/agent/planValidation";
import { normalizeReference } from "@/agent/grounding";
import { poseIntentFromDescriptors } from "@/characters/poseRig";
import { puppetForInstance } from "@/domain/puppetOps";
import { canRepresentView } from "@/puppet/capability";
import type { AgentRunScope } from "@/agent/scope";
import type { RunContext } from "../types";
import { characterInstanceInPanel } from "./cameraProcess";

/**
 * Persistent Character creation — the privileged operation.
 *
 * The guard here is the last line of defence and repeats the plan-validation
 * check on purpose: plan validation protects against a bad plan, this protects
 * against a bad *executor caller*. Failing to resolve a name is never grounds
 * for creating a character, so an unauthorized run throws instead of quietly
 * adding one to the library.
 */
export function doCreateCharacter(ctx: RunContext, args: { name: string; appearance?: string; personalityNotes?: string; description?: string }): void {
  const doc = ctx.currentDoc();
  // Idempotent: re-creating an existing character would fork the library.
  const existing = ctx.requireCharacterOrNull(doc, { characterName: args.name });
  if (existing) return;

  if (!ctx.guards.creationAuthorized) {
    throw new Error(
      `Refusing to create the character "${args.name}": this run has no character-creation authorization. Ask for a new character explicitly.`,
    );
  }
  const authorized = ctx.guards.authorizedCreationNames;
  if (authorized.length > 0 && !authorized.includes(normalizeReference(args.name))) {
    throw new Error(`Creation was authorized for ${authorized.join(", ")}, not "${args.name}".`);
  }
  const realId = createCharacter({
    name: args.name,
    appearance: args.appearance ?? args.description,
    personalityNotes: args.personalityNotes,
  });
  ctx.createdCharacterIds.push(realId);
  // Any planning-stage placeholder that stood in for this name now resolves to
  // the real domain ID — later steps receive it via canonicalizeStepArgs.
  ctx.bindCreatedCharacter(args.name, realId);
}

/** Resolution that reports "no unambiguous match" rather than throwing. */

export async function doGenerateCharacterAsset(ctx: RunContext, 
  args: { characterName: string; characterId?: ID; kind: "reference" | "pose" | "expression"; pose?: string; expression?: string; outfit?: string; view?: string; instruction?: string },
): Promise<void> {
  const doc = ctx.currentDoc();
  const character = requireCharacter(doc, args, { selectedCharacterId: ctx.guards.selectedCharacterId });

  const desired = {
    characterId: character.id,
    pose: args.pose?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.pose,
    expression: args.expression?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.expression,
    outfit: args.outfit?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.outfit,
    view: args.view?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.view,
  };
  // §9: re-check at the generation boundary, against the CURRENT document.
  // The plan was validated against an older document; an earlier step in this
  // same run may have produced exactly this asset.
  if (args.kind !== "reference" && hasExactState(doc, character, desired)) {
    throw new Error(
      `${character.name} already has a ${desired.pose}/${desired.expression} state — reused instead of generating a duplicate.`,
    );
  }
  const assetId = await generateCharacterAssetForState({
    characterId: character.id,
    role: args.kind === "reference" ? "canonical" : "state",
    instruction: args.instruction,
    state: desired,
  });
  ctx.stageOnWorkspace(assetId);
}

/**
 * REUSE → MODIFY → GENERATE, in that order, for one character state (§8/§9).
 *
 * Identity is resolved first and exactly once, from the ID grounding bound to
 * the step. Only then is the asset searched. The library is re-checked
 * immediately before generation against the CURRENT document, because the plan
 * was validated against an older one and an earlier step in this same run may
 * already have produced the asset.
 */
export async function resolveOrGenerateState(ctx: RunContext, 
  args: {
    characterName: string;
    characterId?: ID;
    pose?: string;
    expression?: string;
    outfit?: string;
    view?: string;
    generateIfMissing?: boolean;
  },
  instruction: string,
): Promise<{ character: Character; asset: SourceAsset }> {
  let doc = ctx.currentDoc();
  const character = requireCharacter(doc, args, { selectedCharacterId: ctx.guards.selectedCharacterId });
  const query = { pose: args.pose, expression: args.expression, outfit: args.outfit, view: args.view };
  const desired = requestedCharacterState(character.id, query);

  let asset = resolveCharacterAsset(doc, character, query);
  if (!asset) {
    const blocked = findUnreadyCharacterAsset(doc, character, desired);
    if (blocked) {
      throw new Error(`Background removal failed for "${blocked.name}" — retry it in the library before composing.`);
    }
    if (args.generateIfMissing === false) {
      throw new Error(`No cached state matches ${character.name}; generation was disabled`);
    }
    // Independent re-check at the generation boundary.
    doc = ctx.currentDoc();
    const recheck = resolveCharacterAsset(doc, character, query);
    if (recheck) {
      asset = recheck;
    } else {
      const assetId = await generateCharacterAssetForState({
        characterId: character.id,
        role: "state",
        state: desired,
        instruction,
      });
      doc = ctx.currentDoc();
      asset = doc.assets[assetId] ?? null;
    }
  }
  if (!asset || !isAssetReadyForComposition(asset)) {
    throw new Error(`Unable to resolve a ready reusable state for ${character.name}`);
  }
  return { character, asset };
}

export async function doPlaceCharacter(ctx: RunContext, args: {
  panel?: number;
  target?: "panel" | "workspace";
  characterName: string;
  characterId?: ID;
  pose?: string;
  expression?: string;
  outfit?: string;
  view?: string;
  cropMode?: CropMode;
  flipX?: boolean;
  generateIfMissing?: boolean;
}): Promise<void> {
  const { asset } = await resolveOrGenerateState(ctx, 
    args,
    "Create the missing reusable state requested for placement in the manga page.",
  );

  if (args.target === "workspace" || args.panel === undefined) {
    ctx.stageOnWorkspace(asset.id);
    return;
  }
  const panelId = ctx.panelIdByNumber(args.panel);
  const placed = ctx.dispatch({ type: "add-instance", panelId, assetId: asset.id, cropMode: args.cropMode });
  if (args.flipX && placed.createdId) ctx.dispatch({ type: "set-instance-props", instanceId: placed.createdId, patch: { flipX: true } });
}


/**
 * REUSE → MODIFY → GENERATE, in that order, for one character state (§8/§9).
 *
 * Identity is resolved first and exactly once, from the ID grounding bound to
 * the step. Only then is the asset searched. The library is re-checked
 * immediately before generation against the CURRENT document, because the plan
 * was validated against an older one and an earlier step in this same run may
 * already have produced the asset.
 */

export async function doComposeCharacter(ctx: RunContext, args: {
  panel: number;
  characterName: string;
  characterId?: ID;
  pose?: string;
  expression?: string;
  outfit?: string;
  view?: string;
  framing?: SemanticFraming;
  position?: ScenePosition;
  facing?: SceneFacing;
  depth?: SceneDepth;
  role?: string;
  generateIfMissing?: boolean;
}): Promise<void> {
  const { character, asset } = await resolveOrGenerateState(ctx, 
    args,
    "Create the missing reusable character state for semantic scene composition.",
  );
  ctx.dispatch({
    type: "compose-character",
    panelId: ctx.panelIdByNumber(args.panel),
    characterId: character.id,
    assetId: asset.id,
    framing: args.framing,
    position: args.position,
    facing: args.facing,
    depth: args.depth,
    role: args.role,
  });
}

/**
 * Semantic slot change on an already-placed character instance — the tool
 * behind "make her cry". Reuse an exact-matching library asset when one
 * exists; otherwise generate the missing slot, then swap the instance while
 * the composition stays put.
 */
export async function doSetCharacterSlot(ctx: RunContext, 
  args: { panel?: number; characterName?: string; characterId?: ID; pose?: string; expression?: string; outfit?: string; view?: string; generateIfMissing?: boolean },
  scope?: AgentRunScope,
): Promise<void> {
  if (!args.pose && !args.expression && !args.outfit && !args.view) {
    throw new Error("set_character_slot needs a pose, expression, outfit, or view");
  }
  const doc = ctx.currentDoc();
  const instance = ctx.findTargetInstance(doc, args, scope);
  if (!stateFromInstance(doc, instance)) throw new Error("The targeted instance is not a character");

  /**
   * The capability gate for puppets (V3.2 §12).
   *
   * A view change — "turn Yuri completely around" — is something a front-facing
   * set of parts genuinely cannot represent. The agent must not discover that
   * by producing something broken, so the boundary is named explicitly here and
   * the run then takes the SANCTIONED fallback: generate the artwork. The point
   * is that the escalation is deliberate and logged, not accidental.
   */
  const puppet = puppetForInstance(doc, instance);
  if (puppet && args.view) {
    const capability = canRepresentView(puppet, args.view);
    if (!capability.supported) {
      ctx.lastLanguageAction = `${capability.reason} ${capability.fallbackRecommendation ?? ""}`.trim();
    }
  }
  await applyCharacterStateToInstance({
    instanceId: instance.id,
    patch: { pose: args.pose, expression: args.expression, outfit: args.outfit, view: args.view },
    generateIfMissing: args.generateIfMissing,
  });
}

/** Resolve which character instance a slot change targets: explicit panel/name, else the user's selection. */

/**
 * Semantic pose adjustment (§6).
 *
 * Produces a PoseIntent through the SAME normalizer the joint editor uses, so
 * "raise her right hand" and a dragged arm land on the identical canonical
 * descriptor and therefore the identical cached render. There is no agent-only
 * pose vocabulary and no agent-only pose path.
 */
export async function doSetCharacterPoseRig(ctx: RunContext, args: {
  panel: number;
  characterName?: string;
  characterId?: ID;
  basePose?: string;
  adjustments: string[];
}): Promise<void> {
  const panelId = ctx.panelIdByNumber(args.panel);
  const doc = ctx.currentDoc();
  const instance = characterInstanceInPanel(ctx, doc, panelId, args);
  const current = stateFromInstance(doc, instance);
  if (!current) throw new Error("The targeted instance is not a character");

  const basePose = args.basePose ?? current.poseRig?.basePose ?? current.pose;
  const intent = poseIntentFromDescriptors(basePose, args.adjustments);
  if (intent.descriptors.length === 0) {
    throw new Error(
      `None of those adjustments are recognized pose descriptors. Try phrasings like "right arm raised" or "head turned left".`,
    );
  }

  await applyCharacterStateToInstance({ instanceId: instance.id, patch: { poseRig: intent } });
}
