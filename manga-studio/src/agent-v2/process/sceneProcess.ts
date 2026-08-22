"use client";

import { generateSceneryAsset } from "@/services/scenery";
import type { CropMode, ID } from "@/domain/types";
import { requireCharacter, resolveLibraryAsset } from "@/agent/resolver";
import type { RunContext } from "../types";
import { doPlaceCharacter } from "./characterProcess";

export async function doGenerateScenery(ctx: RunContext, 
  args: { description: string; name?: string },
  category: "background" | "prop",
): Promise<void> {
  ctx.stageOnWorkspace(await generateSceneryAsset({ category, description: args.description, name: args.name }));
}

/**
 * Agent-generated results are staged as loose items beside the page — the
 * creator reviews spatially (compare, drag into a panel, or delete) instead
 * of results vanishing into the library.
 */

export async function doPlaceAsset(ctx: RunContext, args: {
  panel?: number;
  target?: "panel" | "workspace";
  characterName?: string;
  characterId?: ID;
  pose?: string;
  expression?: string;
  outfit?: string;
  view?: string;
  assetName?: string;
  category?: "character" | "background" | "prop" | "upload";
  cropMode?: CropMode;
  flipX?: boolean;
}): Promise<void> {
  const doc = ctx.currentDoc();
  if (args.characterName) return doPlaceCharacter(ctx, { ...args, characterName: args.characterName });
  const asset = resolveLibraryAsset(doc, { assetName: args.assetName, category: args.category });
  if (!asset) {
    throw new Error(
      `No library asset matches ${args.characterName ?? args.assetName ?? args.category ?? "the request"}`,
    );
  }

  if (args.target === "workspace" || args.panel === undefined) {
    ctx.stageOnWorkspace(asset.id);
    return;
  }

  const panelId = ctx.panelIdByNumber(args.panel);
  const placed = ctx.dispatch({ type: "add-instance", panelId, assetId: asset.id, cropMode: args.cropMode });
  if (args.flipX && placed.createdId) ctx.dispatch({ type: "set-instance-props", instanceId: placed.createdId, patch: { flipX: true } });
}

export function doReuseSceneBackground(ctx: RunContext, args: { sourcePanel: number; targetPanel: number }): void {
  ctx.dispatch({
    type: "reuse-panel-background",
    sourcePanelId: ctx.panelIdByNumber(args.sourcePanel),
    targetPanelId: ctx.panelIdByNumber(args.targetPanel),
  });
}

export function doAddSceneRelationship(ctx: RunContext, args: {
  panel: number;
  subjectCharacterName: string;
  subjectCharacterId?: ID;
  action: string;
  targetCharacterName?: string;
  targetCharacterId?: ID;
}): void {
  const doc = ctx.currentDoc();
  const subject = requireCharacter(doc, {
    characterId: args.subjectCharacterId,
    characterName: args.subjectCharacterName,
  });
  const target =
    args.targetCharacterId ?? args.targetCharacterName
      ? requireCharacter(doc, { characterId: args.targetCharacterId, characterName: args.targetCharacterName })
      : null;
  ctx.dispatch({
    type: "add-scene-relationship",
    panelId: ctx.panelIdByNumber(args.panel),
    subjectCharacterId: subject.id,
    action: args.action,
    targetCharacterId: target?.id,
  });
}

/**
 * Semantic slot change on an already-placed character instance — the tool
 * behind "make her cry". Reuse an exact-matching library asset when one
 * exists; otherwise generate the missing slot, then swap the instance while
 * the composition stays put.
 */
