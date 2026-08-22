"use client";

/**
 * LocalEditProcess — the agent's `edit_asset_region` tool.
 *
 * The agent has no painted mask, so the edit runs with a full-canvas mask and
 * locality comes from the instruction (ASM: regionless edits). The result is
 * saved as a NEW asset via LocalEditService and swapped into the targeted
 * instance — the original asset is never mutated.
 */

import { resolveLibraryAsset } from "@/agent/resolver";
import { assetRenderUrl, assetPreviewUrl } from "@/assets/renderSource";
import { editAssetRegion, fullCanvasMaskPng, saveEditedVariation } from "@/services/localEdit";
import type { AssetInstance, ID } from "@/domain/types";
import type { RunContext } from "../types";

export async function doEditAssetRegion(
  ctx: RunContext,
  args: { panel: number; characterName?: string; characterId?: ID; assetName?: string; instruction: string },
): Promise<void> {
  const doc = ctx.currentDoc();
  const panelId = ctx.panelIdByNumber(args.panel);
  const namedCharacter = args.characterId !== undefined || args.characterName !== undefined;

  const instance = namedCharacter
    ? ctx.findTargetInstance(doc, args)
    : (() => {
        const asset = resolveLibraryAsset(doc, { assetName: args.assetName });
        if (!asset) {
          throw new Error(`Name a character or a library asset to edit in panel ${args.panel}`);
        }
        const panel = doc.panels[panelId];
        const hit = panel?.itemIds
          .map((itemId) => doc.items[itemId])
          .find((item): item is AssetInstance => item?.kind === "asset" && item.sourceAssetId === asset.id);
        if (!hit) throw new Error(`${asset.name} is not in panel ${args.panel}`);
        return hit;
      })();

  const asset = doc.assets[instance.sourceAssetId];
  if (!asset) throw new Error("The targeted item has no editable asset");
  const sourceUrl = assetRenderUrl(asset) ?? assetPreviewUrl(asset);
  if (!sourceUrl) throw new Error(`${asset.name} has no image to edit yet`);

  const maskPng = await fullCanvasMaskPng(asset.width, asset.height);
  const result = await editAssetRegion({
    sourceUrl,
    maskPng,
    instruction: args.instruction,
    preserveAlpha: asset.category !== "background",
  });
  const newAssetId = saveEditedVariation(ctx.dispatch, asset, result.url, args.instruction);
  if (!newAssetId) throw new Error("The edited variation could not be saved");
  ctx.dispatch({ type: "swap-instance-asset", instanceId: instance.id, assetId: newAssetId });
}
