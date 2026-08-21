"use client";

/**
 * Draggable library thumbnail — the primary gesture is dragging this into a
 * panel, which creates an independent instance (the source stays here).
 */

import { useState } from "react";
import type { SourceAsset } from "@/domain/types";
import { assetRenderUrl } from "@/assets/renderSource";
import { keepRawAsset, removeAssetBackground } from "@/assets/clientProcessing";
import { useUiStore } from "@/editor/uiStore";

interface AssetThumbProps {
  asset: SourceAsset;
  subtitle?: string;
  onUse?: () => void;
  onRename?: () => void;
  onRegenerate?: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
}

export function AssetThumb({ asset, subtitle, onUse, onRename, onRegenerate, onArchive, onRestore, onDelete }: AssetThumbProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const openSettings = useUiStore((state) => state.openSettings);
  const canRemoveBackground = asset.category === "character" || asset.category === "prop";
  const runRemoval = (strategy: "auto" | "image-edit" | "provider" | "local" = "auto") => {
    setBusy(true);
    setError(undefined);
    void removeAssetBackground(asset.id, strategy)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Background removal failed"))
      .finally(() => setBusy(false));
  };
  return (
    <div
      className="group relative w-[104px] cursor-grab select-none"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-asset-id", asset.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      title={`${asset.name} — drag into a panel`}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
      onMouseLeave={() => setMenuOpen(false)}
    >
      <div className="h-[104px] w-[104px] overflow-hidden rounded-md border border-zinc-700 bg-[repeating-conic-gradient(#3f3f46_0%_25%,#27272a_0%_50%)] bg-[length:16px_16px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={asset.thumbnailUrl ?? assetRenderUrl(asset)}
          alt={asset.name}
          className="h-full w-full object-contain pointer-events-none"
          draggable={false}
        />
      </div>
      <p className="mt-1 truncate text-[11px] text-zinc-400">{asset.name}</p>
      {subtitle && <p className="truncate text-[10px] text-zinc-500">{subtitle}</p>}
      {canRemoveBackground && asset.processingStatus !== "failed" && (
        <button
          type="button"
          disabled={busy}
          className="mt-1 w-full rounded border border-zinc-700 px-1 py-0.5 text-[9px] text-zinc-400 hover:border-violet-600 hover:text-violet-300 disabled:opacity-50"
          title="Create a transparent derivative while preserving the original"
          onClick={(event) => {
            event.stopPropagation();
            runRemoval();
          }}
        >
          {busy ? "Removing…" : asset.hasAlpha ? "Reprocess Background" : "Remove Background"}
        </button>
      )}
      {asset.processingStatus === "failed" && (
        <div className="mt-1 space-y-1 text-[9px]">
          <p className="font-medium text-amber-400">Needs background cleanup</p>
          <div className="flex flex-wrap gap-1">
            <SmallAction label={busy ? "Working…" : "Retry"} disabled={busy} onClick={() => runRemoval("auto")} />
            <SmallAction label="Use Image AI" title="Use Image AI to Remove Background" disabled={busy} onClick={() => runRemoval("image-edit")} />
            <SmallAction label="Choose Provider" title="Choose Background Removal Provider" disabled={busy} onClick={openSettings} />
            {asset.backgroundRemovalProvider && (
              <SmallAction label="Remove Again" title="Remove Background Again" disabled={busy} onClick={() => runRemoval("provider")} />
            )}
            <SmallAction label="Keep Raw" disabled={busy} onClick={() => keepRawAsset(asset.id)} />
          </div>
          {asset.processingReason && (
            <details className="text-zinc-500">
              <summary className="cursor-pointer">Details</summary>
              <p className="mt-0.5 leading-3">{asset.processingReason}</p>
            </details>
          )}
        </div>
      )}
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
      {menuOpen && (
        <div className="absolute left-2 top-8 z-40 min-w-40 rounded border border-zinc-600 bg-zinc-900 p-1 text-[11px] shadow-xl">
          {onUse && <MenuItem label="Use in selected panel" onClick={onUse} />}
          {onRename && <MenuItem label="Rename" onClick={onRename} />}
          {onRegenerate && <MenuItem label="Regenerate and replace" onClick={onRegenerate} />}
          {canRemoveBackground && <MenuItem label="Remove background" onClick={() => runRemoval()} />}
          {onArchive && <MenuItem label="Archive" onClick={onArchive} />}
          {onRestore && <MenuItem label="Restore" onClick={onRestore} />}
          {onDelete && <MenuItem label="Delete…" danger onClick={onDelete} />}
        </div>
      )}
    </div>
  );
}

function SmallAction({ label, title, disabled, onClick }: { label: string; title?: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      className="rounded border border-zinc-700 px-1 py-0.5 text-zinc-400 hover:border-violet-600 hover:text-violet-300 disabled:opacity-50"
      onClick={(event) => { event.stopPropagation(); onClick(); }}
    >
      {label}
    </button>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-zinc-800 ${danger ? "text-red-300" : "text-zinc-300"}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {label}
    </button>
  );
}
