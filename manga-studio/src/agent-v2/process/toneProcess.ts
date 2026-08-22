"use client";

import { generateMangaEffectImage, registerMangaEffectAsset } from "@/services/language";
import type { EffectKind, ID, ProjectDocument, MangaLanguageCategory } from "@/domain/types";
import { characterIdOfInstance } from "@/characters/identity";
import { tonePreset, type ToneMask } from "@/domain/tones";
import { ensureToneGenerated, findLibraryTone, resolveToneIntent } from "@/services/tones";
import { panelPxRect } from "@/domain/docHelpers";
import { bestLanguageAsset } from "@/language/library";
import type { RunContext } from "../types";
import { characterInstanceInPanel } from "./cameraProcess";

export function doAddEffect(ctx: RunContext, args: { panel: number; effectKind: EffectKind }): void {
  const panelId = ctx.panelIdByNumber(args.panel);
  ctx.dispatch({ type: "add-effect", panelId, effectKind: args.effectKind });
}

/**
 * Lay a tone over a panel (§16).
 *
 * Goes through the SAME `add-tone` command the Tones shelf dispatches, so an
 * Agent-applied tone is an ordinary tone layer the creator can edit, reorder,
 * hide and delete. There is no Agent-only tone path, and nothing here can bake
 * tone into artwork because no such command exists.
 */

/**
 * Lay a tone over a panel (§16).
 *
 * Goes through the SAME `add-tone` command the Tones shelf dispatches, so an
 * Agent-applied tone is an ordinary tone layer the creator can edit, reorder,
 * hide and delete. There is no Agent-only tone path, and nothing here can bake
 * tone into artwork because no such command exists.
 */
export async function doApplyTone(ctx: RunContext, args: {
  panel: number;
  presetId?: string;
  toneAssetName?: string;
  toneAssetId?: string;
  mood?: string;
  opacity?: number;
  maskToCharacterName?: string;
  maskToCharacterId?: string;
}): Promise<void> {
  const doc = ctx.currentDoc();
  const panelId = ctx.panelIdByNumber(args.panel);

  let assetId = args.toneAssetId;
  if (!assetId && args.toneAssetName) {
    assetId = findLibraryTone(doc, args.toneAssetName)?.id;
  }

  let presetId = args.presetId && tonePreset(args.presetId) ? args.presetId : undefined;
  if (!assetId && !presetId) {
    const resolved = resolveToneIntent(doc, { name: args.toneAssetName, mood: args.mood });
    if (resolved?.kind === "preset") presetId = resolved.presetId;
    if (resolved?.kind === "asset") assetId = resolved.assetId;
  }

  if (!assetId && !presetId && args.mood) {
    /**
     * REUSE failed → GENERATE, through the same Tone capability the manual
     * Tones shelf uses. The new tone lands in the shared registry, so the
     * shelf sees it too — there are no agent-only tones.
     */
    const generated = await ensureToneGenerated({ description: args.mood, toneType: "atmosphere", tileable: true });
    assetId = generated.assetId;
  }

  if (!assetId && !presetId) {
    throw new Error(
      `No tone matches "${args.mood ?? args.presetId ?? args.toneAssetName ?? "that"}". Name a tone from the Tones shelf, or describe the mood.`,
    );
  }

  /**
   * "Add screentone to her shirt."
   *
   * A shirt is not a region this can resolve — it is inside the character's
   * artwork, and guessing at it would put tone on a face. What CAN be resolved
   * safely is where that character stands, so the tone is confined to them and
   * the creator refines it with the mask editor. Covering the whole panel when
   * a specific character was named would be the wrong answer quietly.
   */
  const mask = args.maskToCharacterName || args.maskToCharacterId ? maskOverCharacter(ctx, doc, panelId, args) : undefined;

  const created = ctx.dispatch({ type: "add-tone", panelId, presetId, assetId, mask });
  if (created.createdId && args.opacity !== undefined) {
    ctx.dispatch({ type: "update-tone", itemId: created.createdId, patch: { opacity: args.opacity } });
  }
}

/** The rectangle a named character occupies in this panel, normalized. */

/** The rectangle a named character occupies in this panel, normalized. */
export function maskOverCharacter(ctx: RunContext, 
  doc: ProjectDocument,
  panelId: ID,
  args: { maskToCharacterName?: string; maskToCharacterId?: string },
): ToneMask | undefined {
  const character = ctx.requireCharacterOrNull(doc, {
    characterId: args.maskToCharacterId,
    characterName: args.maskToCharacterName,
  });
  if (!character) return undefined;
  const instance = doc.panels[panelId]?.itemIds
    .map((id) => doc.items[id])
    .find((item) => item?.kind === "asset" && characterIdOfInstance(doc, item) === character.id);
  if (!instance) return undefined;

  const rect = panelPxRect(doc, panelId);
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  return {
    shapes: [
      {
        kind: "rect",
        x: Math.max(0, (instance.cx - instance.width / 2) / rect.width),
        y: Math.max(0, (instance.cy - instance.height / 2) / rect.height),
        width: Math.min(1, instance.width / rect.width),
        height: Math.min(1, instance.height / rect.height),
      },
    ],
  };
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
export function doPlaceMangaEffect(ctx: RunContext, args: {
  panel: number;
  query: string;
  category?: MangaLanguageCategory;
  targetCharacterName?: string;
  targetCharacterId?: ID;
  text?: string;
}): void {
  const doc = ctx.currentDoc();
  const panelId = ctx.panelIdByNumber(args.panel);
  const asset = bestLanguageAsset(doc, { category: args.category, text: args.query });
  if (!asset) {
    throw new Error(
      `No manga-language asset matches "${args.query}". Use generate_manga_effect to create one, then place it.`,
    );
  }
  placeLanguageAssetOnTarget(ctx, doc, panelId, asset.id, args, args.text);
  ctx.lastLanguageAction = `Reused "${asset.name}" (${asset.source})`;
}

/**
 * Generate a new manga-language asset, add it to the library, then place it.
 *
 * The library is re-checked here against the CURRENT document as well as in
 * plan validation, because an earlier step in this same run may already have
 * created what this step is about to pay for.
 */

/**
 * Generate a new manga-language asset, add it to the library, then place it.
 *
 * The library is re-checked here against the CURRENT document as well as in
 * plan validation, because an earlier step in this same run may already have
 * created what this step is about to pay for.
 */
export async function doGenerateMangaEffect(ctx: RunContext, args: {
  description: string;
  category: MangaLanguageCategory;
  name?: string;
  panel?: number;
  targetCharacterName?: string;
  targetCharacterId?: ID;
}): Promise<void> {
  let doc = ctx.currentDoc();
  const existing = bestLanguageAsset(doc, { category: args.category, text: args.description });
  if (existing) {
    throw new Error(`"${existing.name}" already covers that — reuse it with place_manga_effect instead of generating.`);
  }

  const { result, prompt } = await generateMangaEffectImage(doc, args.description, args.category);
  const { languageAssetId, name } = await registerMangaEffectAsset({
    result,
    prompt,
    description: args.description,
    category: args.category,
    name: args.name,
  });
  ctx.lastLanguageAction = `Generated "${name}" and added it to the library`;

  if (args.panel === undefined) return;
  doc = ctx.currentDoc();
  placeLanguageAssetOnTarget(ctx, doc, ctx.panelIdByNumber(args.panel), languageAssetId, args);
}

export function placeLanguageAssetOnTarget(ctx: RunContext, 
  doc: ProjectDocument,
  panelId: ID,
  languageAssetId: ID,
  ref: { targetCharacterName?: string; targetCharacterId?: ID },
  text?: string,
): void {
  // Attaching is what makes "around Yuri" mean something: the effect keeps its
  // relationship to the subject when the subject is moved or restaged.
  const target =
    ref.targetCharacterId ?? ref.targetCharacterName
      ? characterInstanceInPanel(ctx, doc, panelId, {
          characterName: ref.targetCharacterName,
          characterId: ref.targetCharacterId,
        })
      : undefined;
  const placed = ctx.dispatch({
    type: "place-language-asset",
    panelId,
    languageAssetId,
    text,
    attachToItemId: target?.id,
    at: target ? { x: target.cx, y: target.cy - target.height * 0.35 } : undefined,
  });
  if (!placed.createdId) throw new Error("The effect could not be placed");
}
