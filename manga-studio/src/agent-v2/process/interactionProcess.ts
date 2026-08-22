"use client";

import type { ID, InteractionType } from "@/domain/types";
import { requireCharacter } from "@/agent/resolver";
import { executeInteraction } from "@/services/interaction";
import { charactersInAsset } from "@/domain/interactions";
import type { RunContext } from "../types";
import type { InteractionArgs } from "../types";
import { resolveOrGenerateState } from "./characterProcess";

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
    { characterName: args.targetCharacterName, characterId: args.targetCharacterId },
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
  interaction: InteractionType;
  subjectCharacterName: string;
  subjectCharacterId?: ID;
  targetCharacterName: string;
  targetCharacterId?: ID;
  expressions?: Record<string, string>;
}): Promise<void> {
  const panelId = ctx.panelIdByNumber(args.panel);
  const doc = ctx.currentDoc();
  const subject = requireCharacter(doc, {
    characterId: args.subjectCharacterId,
    characterName: args.subjectCharacterName,
  });
  const target = requireCharacter(doc, {
    characterId: args.targetCharacterId,
    characterName: args.targetCharacterName,
  });
  if (subject.id === target.id) throw new Error("An interaction needs two different characters");

  // Expressions arrive keyed by NAME; resolve each through the same grounding
  // resolver so "Yuri" cannot quietly become someone else here either.
  const expressions: Record<ID, string> = {};
  for (const [name, expression] of Object.entries(args.expressions ?? {})) {
    const character = requireCharacter(doc, { characterName: name });
    expressions[character.id] = expression.trim().toLowerCase();
  }

  const outcome = await executeInteraction({
    panelId,
    participantIds: [subject.id, target.id],
    type: args.interaction,
    expressions,
  });

  ctx.lastLanguageAction = outcome.reusedCache
    ? `Reused an existing ${args.interaction.replace(/_/g, " ")} render`
    : outcome.generationCalls > 0
      ? `Drawn once using both ${subject.name} and ${target.name} as references`
      : `Arranged locally — no generation`;

  /**
   * Post-condition: a joint render must actually contain both participants.
   * A composite that lost someone is a fatal outcome, not a warning.
   */
  if (outcome.assetId) {
    const participants = charactersInAsset(ctx.currentDoc(), outcome.assetId);
    for (const id of [subject.id, target.id]) {
      if (!participants.includes(id)) {
        throw new Error(`The generated interaction does not contain ${ctx.currentDoc().characters[id]?.name ?? id}`);
      }
    }
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
