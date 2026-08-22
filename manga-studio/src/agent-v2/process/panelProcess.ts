"use client";

import type { CropMode, ID, LayoutPresetId, Point } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { requireCharacter } from "@/agent/resolver";
import type { RunContext } from "../types";

export function doSetPageLayout(ctx: RunContext, args: { layout: LayoutPresetId }): void {
  const pageId = useEditorStore.getState().currentPageId;
  if (!pageId) throw new Error("No current page");
  ctx.dispatch({ type: "set-page-layout", pageId, layout: args.layout });
}

export function doReshapePanel(ctx: RunContext, args: { panel: number; points: Point[] }): void {
  const panelId = ctx.panelIdByNumber(args.panel);
  ctx.dispatch({ type: "reshape-panel", panelId, points: args.points });
}

export function doSetCropMode(ctx: RunContext, args: {
  panel: number;
  characterName?: string;
  characterId?: ID;
  category?: "character" | "background" | "prop" | "upload";
  mode: CropMode;
}): void {
  const doc = ctx.currentDoc();
  const panelId = ctx.panelIdByNumber(args.panel);
  const panel = doc.panels[panelId];

  const targets = panel.itemIds
    .map((id) => doc.items[id])
    .filter((item) => item?.kind === "asset")
    .filter((item) => {
      const asset = doc.assets[(item as { sourceAssetId: ID }).sourceAssetId];
      if (!asset) return false;
      if (args.characterId ?? args.characterName) {
        const character = requireCharacter(doc, args);
        return asset.metadata?.characterId === character.id;
      }
      if (args.category) return asset.category === args.category;
      return asset.category === "character"; // default target: the character shot
    });
  const target = targets[targets.length - 1];
  if (!target) throw new Error(`Nothing to reframe in panel ${args.panel}`);
  ctx.dispatch({ type: "set-framing", instanceId: target.id, cropMode: args.mode });
}

export function doRemoveItems(ctx: RunContext, args: { panel: number; kind?: "asset" | "bubble" | "effect" }): void {
  const doc = ctx.currentDoc();
  const panelId = ctx.panelIdByNumber(args.panel);
  const toRemove = doc.panels[panelId].itemIds.filter((id) => {
    const item = doc.items[id];
    return item && (!args.kind || item.kind === args.kind);
  });
  for (const itemId of toRemove) ctx.dispatch({ type: "delete-instance", instanceId: itemId });
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
