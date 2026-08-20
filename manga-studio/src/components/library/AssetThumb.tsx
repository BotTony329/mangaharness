"use client";

/**
 * Draggable library thumbnail — the primary gesture is dragging this into a
 * panel, which creates an independent instance (the source stays here).
 */

import { useState } from "react";
import type { SourceAsset } from "@/domain/types";
import { assetRenderUrl } from "@/assets/renderSource";
import { removeAssetBackground } from "@/assets/clientProcessing";

interface AssetThumbProps {
  asset: SourceAsset;
  subtitle?: string;
  onDelete?: () => void;
}

export function AssetThumb({ asset, subtitle, onDelete }: AssetThumbProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const canRemoveBackground = asset.category === "character" || asset.category === "prop";
  return (
    <div
      className="group relative w-[104px] cursor-grab select-none"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-asset-id", asset.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      title={`${asset.name} — drag into a panel`}
    >
      <div className="h-[104px] w-[104px] overflow-hidden rounded-md border border-zinc-700 bg-[repeating-conic-gradient(#3f3f46_0%_25%,#27272a_0%_50%)] bg-[length:16px_16px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={asset.processedImageUrl ?? asset.thumbnailUrl ?? assetRenderUrl(asset)}
          alt={asset.name}
          className="h-full w-full object-contain pointer-events-none"
          draggable={false}
        />
      </div>
      <p className="mt-1 truncate text-[11px] text-zinc-400">{asset.name}</p>
      {subtitle && <p className="truncate text-[10px] text-zinc-500">{subtitle}</p>}
      {canRemoveBackground && (
        <button
          type="button"
          disabled={busy}
          className="mt-1 w-full rounded border border-zinc-700 px-1 py-0.5 text-[9px] text-zinc-400 hover:border-violet-600 hover:text-violet-300 disabled:opacity-50"
          title="Create a transparent derivative while preserving the original"
          onClick={(event) => {
            event.stopPropagation();
            setBusy(true);
            setError(undefined);
            void removeAssetBackground(asset.id)
              .catch((cause) => setError(cause instanceof Error ? cause.message : "Background removal failed"))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Removing…" : asset.hasAlpha ? "Reprocess Background" : "Remove Background"}
        </button>
      )}
      {asset.processingStatus === "failed" && <p className="mt-0.5 text-[9px] text-amber-400">Source preserved · retry available</p>}
      {error && <p className="mt-0.5 line-clamp-2 text-[9px] text-red-400" title={error}>{error}</p>}
      {onDelete && (
        <button
          className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded bg-zinc-900/90 text-xs text-zinc-400 hover:text-red-400 group-hover:flex"
          onClick={onDelete}
          title="Remove from library"
        >
          ✕
        </button>
      )}
    </div>
  );
}
