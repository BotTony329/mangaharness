"use client";

import type { ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

interface BackgroundRemovalResponse {
  processedImageUrl?: string;
  hasAlpha?: boolean;
  backgroundRemoved?: boolean;
  processingStatus?: "ready" | "failed";
  processingReason?: string;
  backgroundRemovalMethod?: string;
  backgroundRemovalProvider?: string;
  requestId?: string;
  error?: string;
}

export interface RemoveBackgroundOptions {
  strategy?: "auto" | "image-edit" | "provider" | "local";
  /**
   * Leave the asset untouched if reprocessing fails.
   *
   * Repairing an asset that currently WORKS must never be able to break it: a
   * failure would otherwise mark it failed, and `assetRenderUrl` would then
   * refuse to render a character that was on the page a moment ago.
   */
  preserveOnFailure?: boolean;
}

/** Request a derivative while keeping the asset's original storageUrl untouched. */
export async function removeAssetBackground(
  assetId: ID,
  strategyOrOptions: "auto" | "image-edit" | "provider" | "local" | RemoveBackgroundOptions = "auto",
): Promise<void> {
  const options: RemoveBackgroundOptions =
    typeof strategyOrOptions === "string" ? { strategy: strategyOrOptions } : strategyOrOptions;
  const strategy = options.strategy ?? "auto";
  const asset = useEditorStore.getState().doc?.assets[assetId];
  if (!asset || (asset.category !== "character" && asset.category !== "prop")) {
    throw new Error("Background removal is available for character and prop assets");
  }
  useEditorStore.getState().dispatch({
    type: "set-asset-processed",
    assetId,
    update: { processingStatus: "processing", backgroundRemovalStatus: "processing", processingReason: undefined },
  });
  try {
    const response = await fetch("/api/assets/remove-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: asset.sourceUrl || asset.storageUrl, category: asset.category, assetId, strategy }),
    });
    const body = (await response.json().catch(() => ({}))) as BackgroundRemovalResponse;
    if (!response.ok || body.processingStatus === "failed" || !body.processedImageUrl) {
      throw new Error(body.error ?? "Background removal failed");
    }
    useEditorStore.getState().dispatch({
      type: "set-asset-processed",
      assetId,
      update: {
        processedImageUrl: body.processedImageUrl,
        hasAlpha: body.hasAlpha === true,
        backgroundRemoved: body.backgroundRemoved === true,
        processingStatus: "ready",
        backgroundRemovalStatus: "ready",
        processingReason: undefined,
        backgroundRemovalMethod: body.backgroundRemovalMethod,
        backgroundRemovalProvider: body.backgroundRemovalProvider,
      },
    });
    console.info("[bg-remove]", JSON.stringify({ requestId: body.requestId, stage: "asset_updated", assetId }));
  } catch (error) {
    useEditorStore.getState().dispatch({
      type: "set-asset-processed",
      assetId,
      update: options.preserveOnFailure
        ? {
            processedImageUrl: asset.processedImageUrl,
            hasAlpha: asset.hasAlpha,
            backgroundRemoved: asset.backgroundRemoved,
            processingStatus: asset.processingStatus,
            backgroundRemovalStatus: asset.backgroundRemovalStatus,
            processingReason: asset.processingReason,
          }
        : {
            processingStatus: "failed",
            backgroundRemovalStatus: "failed",
            processingReason: error instanceof Error ? error.message : "Background removal failed",
          },
    });
    throw error;
  }
}

export interface RepairProgress {
  done: number;
  total: number;
  failed: number;
}

/**
 * Re-run the CURRENT transparency pipeline over assets processed by an older
 * one.
 *
 * A pipeline fix only reaches images processed after it ships: the derivative
 * already in object storage keeps whatever bytes it was written with. Assets
 * generated before edge decontamination existed therefore keep their coloured
 * fringe until they are rebuilt from their original source, which is what this
 * does — the source is never modified, only the derivative is replaced.
 *
 * Sequential on purpose: each asset is a provider round trip, and a burst of
 * parallel requests is a good way to get rate limited mid-repair.
 */
export async function repairAssetTransparency(
  assetIds: ID[],
  onProgress?: (progress: RepairProgress) => void,
): Promise<RepairProgress> {
  const progress: RepairProgress = { done: 0, total: assetIds.length, failed: 0 };
  for (const assetId of assetIds) {
    try {
      await removeAssetBackground(assetId, { preserveOnFailure: true });
    } catch {
      progress.failed += 1;
    }
    progress.done += 1;
    onProgress?.({ ...progress });
  }
  return progress;
}

/** Every asset of a character that the transparency pipeline owns. */
export function repairableAssetIds(characterId: ID): ID[] {
  const doc = useEditorStore.getState().doc;
  if (!doc) return [];
  return Object.values(doc.assets)
    .filter(
      (asset) =>
        asset.status !== "archived" &&
        (asset.category === "character" || asset.category === "prop") &&
        (asset.metadata?.characterId === characterId || doc.characters[characterId]?.assetIds.includes(asset.id)),
    )
    .map((asset) => asset.id);
}
