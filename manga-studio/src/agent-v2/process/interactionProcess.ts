"use client";

import type { ID, InteractionParameters, InteractionType, ProjectDocument } from "@/domain/types";
import { requireCharacter } from "@/agent/resolver";
import { executeInteraction, rerenderInteraction } from "@/services/interaction";
import {
  charactersInAsset,
  interactionLabel,
  interactionParticipants,
  interactionsInPanel,
} from "@/domain/interactions";
import type { RunContext } from "../types";
import type { InteractionArgs, UpdateInteractionArgs } from "../types";
import { resolveOrGenerateState } from "./characterProcess";

/**
 * A library prop/background by name. Interactions with objects and scenes are
 * declared against the LIBRARY asset (not a placed instance), matching the
 * Inspector's creation path.
 */
function requireLibraryAsset(doc: ProjectDocument, name: string) {
  const asset = Object.values(doc.assets).find(
    (candidate) =>
      (candidate.category === "prop" || candidate.category === "background") &&
      candidate.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (!asset) throw new Error(`No prop or background named "${name}" exists in the library`);
  return asset;
}

/**
 * Fallback Composition — an explicit product behaviour, not a hidden rescue.
 *
 * A joint render that failed leaves two characters who still have perfectly
 * good reusable assets. The fallback places each of them from EXISTING ready
 * assets only (generateIfMissing is false: a fallback must never spend a
 * second generation trying to fix the first). The run then reports
 * PARTIALLY COMPLETED and names what is missing — the true joint render.
 */
export async function approximateInteraction(ctx: RunContext, args: InteractionArgs): Promise<void> {
  const panelId = ctx.panelIdByNumber(args.panel);
  for (const who of [
    { characterName: args.subjectCharacterName, characterId: args.subjectCharacterId },
    // An object/scene target has no reusable character asset to fall back to;
    // the approximation places only the actors it actually has.
    ...(args.targetCharacterName || args.targetCharacterId
      ? [{ characterName: args.targetCharacterName ?? "", characterId: args.targetCharacterId }]
      : []),
  ]) {
    const { asset } = await resolveOrGenerateState(ctx, 
      { characterName: who.characterName, characterId: who.characterId, generateIfMissing: false },
      "Fallback composition reuses existing assets only.",
    );
    ctx.dispatch({ type: "add-instance", panelId, assetId: asset.id });
  }
}

/**
 * Coordinated multi-character action (P0.3/P0.4).
 *
 * Delegates to the SAME service the Inspector's Hug button uses, so the Agent
 * cannot acquire a different notion of what a hug is. The service decides
 * whether the action is local placement, a shared anchor, or one joint render
 * carrying both identity references — and performs the real provider call.
 *
 * Never satisfied by overlapping two existing sprites.
 */
export async function doCreateInteraction(ctx: RunContext, args: {
  panel: number;
  interaction: InteractionType | (string & {});
  subjectCharacterName: string;
  subjectCharacterId?: ID;
  targetCharacterName?: string;
  targetCharacterId?: ID;
  targetAssetName?: string;
  expressions?: Record<string, string>;
  parameters?: InteractionParameters;
}): Promise<void> {
  const panelId = ctx.panelIdByNumber(args.panel);
  const doc = ctx.currentDoc();
  const subject = requireCharacter(doc, {
    characterId: args.subjectCharacterId,
    characterName: args.subjectCharacterName,
  });

  /**
   * The target is a character OR a library prop/background — one or the other,
   * never neither. An object/scene target joins by asset id, and its own image
   * travels as a reference so the render uses THIS ramen bowl, not an
   * invented one.
   */
  const targetAsset = args.targetAssetName ? requireLibraryAsset(doc, args.targetAssetName) : undefined;
  const target = !targetAsset
    ? requireCharacter(doc, {
        characterId: args.targetCharacterId,
        characterName: args.targetCharacterName ?? "",
      })
    : undefined;
  if (!targetAsset && !target) throw new Error("An interaction needs a target character or a target asset");
  if (target && subject.id === target.id) throw new Error("An interaction needs two different characters");

  // Expressions arrive keyed by NAME; resolve each through the same grounding
  // resolver so "Yuri" cannot quietly become someone else here either.
  const expressions: Record<ID, string> = {};
  for (const [name, expression] of Object.entries(args.expressions ?? {})) {
    const character = requireCharacter(doc, { characterName: name });
    expressions[character.id] = expression.trim().toLowerCase();
  }

  const outcome = await executeInteraction({
    panelId,
    participantIds: target ? [subject.id, target.id] : [subject.id],
    participants: [
      { id: subject.id, kind: "character", role: "initiator" },
      target
        ? { id: target.id, kind: "character" as const, role: "target" }
        : { id: targetAsset!.id, kind: targetAsset!.category === "background" ? ("scene" as const) : ("object" as const), role: "target" },
    ],
    type: args.interaction,
    expressions,
    parameters: args.parameters,
    source: "agent",
  });

  ctx.lastLanguageAction = outcome.reusedCache
    ? `Reused an existing ${interactionLabel(args.interaction)} render`
    : outcome.generationCalls > 0
      ? `Drawn once using ${[subject.name, target?.name ?? targetAsset?.name].filter(Boolean).join(" and ")} as references`
      : `Arranged locally — no generation`;

  /**
   * Post-condition: a joint render must actually contain both participants.
   * A composite that lost someone is a fatal outcome, not a warning.
   */
  if (outcome.assetId) {
    const participants = charactersInAsset(ctx.currentDoc(), outcome.assetId);
    for (const id of [subject.id, ...(target ? [target.id] : [])]) {
      if (!participants.includes(id)) {
        throw new Error(`The generated interaction does not contain ${ctx.currentDoc().characters[id]?.name ?? id}`);
      }
    }
  }
}

/**
 * Edit an interaction that already exists — the Agent-side twin of the
 * Inspector editor. Finds the interaction by panel + subject + current type
 * (target name disambiguates when the subject has several of the same verb),
 * applies the patch through the domain command, then re-draws through the
 * same service when the interaction is a composite render.
 */
export async function doUpdateInteraction(ctx: RunContext, args: UpdateInteractionArgs): Promise<void> {
  const panelId = ctx.panelIdByNumber(args.panel);
  const doc = ctx.currentDoc();
  const subject = requireCharacter(doc, {
    characterId: args.subjectCharacterId,
    characterName: args.subjectCharacterName,
  });
  const target = args.targetCharacterName || args.targetCharacterId
    ? requireCharacter(doc, { characterId: args.targetCharacterId, characterName: args.targetCharacterName ?? "" })
    : undefined;
  const targetAsset = args.targetAssetName ? requireLibraryAsset(doc, args.targetAssetName) : undefined;

  const matches = interactionsInPanel(doc, panelId, subject.id).filter((interaction) => {
    if (interaction.type !== args.interaction) return false;
    const participants = interactionParticipants(interaction);
    if (target && !participants.some((p) => p.kind === "character" && p.id === target.id)) return false;
    if (targetAsset && !participants.some((p) => p.kind !== "character" && p.id === targetAsset.id)) return false;
    return true;
  });
  if (matches.length === 0) {
    throw new Error(
      `No "${interactionLabel(args.interaction)}" interaction with ${subject.name} exists in panel ${args.panel} — create it first, then edit it.`,
    );
  }
  const interaction = matches[0];

  ctx.dispatch({
    type: "update-interaction",
    interactionId: interaction.id,
    patch: {
      ...(args.newInteraction ? { type: args.newInteraction } : {}),
      ...(args.parameters ? { parameters: { ...interaction.parameters, ...args.parameters } } : {}),
    },
  });

  if (interaction.renderMode === "composite") {
    await rerenderInteraction(interaction.id);
    ctx.lastLanguageAction = `Redrawn as ${interactionLabel(args.newInteraction ?? interaction.type)} with the new settings`;
  } else {
    ctx.lastLanguageAction = `Updated the ${interactionLabel(interaction.type)} interaction — arranged locally`;
  }
}

// ─── Manga Language Library: SEARCH → REUSE → GENERATE → PLACE (§12) ────────

/**
 * Place an existing manga-language asset.
 *
 * The library is searched first and only reused — this handler cannot
 * generate. Failing loudly with the name of the fallback tool is what keeps
 * "add a shocked effect" from silently costing an image generation when a
 * perfectly good built-in Shock effect is already on the shelf.
 */
