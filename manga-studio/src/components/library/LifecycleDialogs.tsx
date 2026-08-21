"use client";

import { inspectAssetUsage } from "@/domain/assetLifecycle";
import type { Character, SourceAsset } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

export function AssetDeleteDialog({ asset, onClose }: { asset: SourceAsset; onClose: () => void }) {
  const doc = useEditorStore((state) => state.doc);
  if (!doc) return null;
  const usages = inspectAssetUsage(doc, asset.id);
  const execute = (mode: "if-unused" | "archive" | "cascade") => {
    useEditorStore.getState().dispatch({ type: "delete-asset", assetId: asset.id, mode });
    onClose();
  };
  return (
    <Dialog title={`Delete “${asset.name}”?`} onClose={onClose}>
      {usages.length > 0 ? (
        <>
          <p className="text-xs text-zinc-400">This reusable source is currently used in:</p>
          <ul className="my-3 max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-zinc-300">
            {usages.map((usage, index) => <li key={`${usage.kind}-${usage.id}-${index}`}>{usage.label}</li>)}
          </ul>
          <p className="mb-3 text-[11px] text-amber-300">Archiving hides it from the library but preserves every use. Cascade deletion removes the source and all listed uses.</p>
        </>
      ) : (
        <p className="mb-4 text-xs text-zinc-400">This asset is unused and can be deleted safely.</p>
      )}
      <div className="flex flex-wrap justify-end gap-2 text-xs">
        <button className="rounded px-3 py-1.5 text-zinc-400 hover:text-zinc-200" onClick={onClose}>Cancel</button>
        {usages.length > 0 && <button className="rounded border border-zinc-600 px-3 py-1.5 hover:bg-zinc-800" onClick={() => execute("archive")}>Archive, keep uses</button>}
        <button className="rounded bg-red-700 px-3 py-1.5 text-white hover:bg-red-600" onClick={() => execute(usages.length > 0 ? "cascade" : "if-unused")}>
          {usages.length > 0 ? `Delete asset and remove ${usages.length} uses` : "Delete asset"}
        </button>
      </div>
    </Dialog>
  );
}

export function CharacterDeleteDialog({ character, onClose }: { character: Character; onClose: () => void }) {
  const doc = useEditorStore((state) => state.doc);
  if (!doc) return null;
  const instanceCount = Object.values(doc.items).filter(
    (item) => item.kind === "asset" && item.characterState?.characterId === character.id,
  ).length;
  const execute = (mode: "keep-assets" | "delete-all") => {
    useEditorStore.getState().dispatch({ type: "delete-character", characterId: character.id, mode });
    useEditorStore.getState().select({});
    onClose();
  };
  return (
    <Dialog title={`Delete ${character.name}?`} onClose={onClose}>
      <p className="mb-3 text-xs leading-5 text-zinc-400">
        {character.assetIds.length} visual asset{character.assetIds.length === 1 ? "" : "s"} and {instanceCount} panel instance{instanceCount === 1 ? "" : "s"} are linked to this Character.
      </p>
      <div className="flex flex-wrap justify-end gap-2 text-xs">
        <button className="rounded px-3 py-1.5 text-zinc-400 hover:text-zinc-200" onClick={onClose}>Cancel</button>
        <button className="rounded border border-zinc-600 px-3 py-1.5 hover:bg-zinc-800" onClick={() => execute("keep-assets")}>Delete Character, keep assets</button>
        <button className="rounded bg-red-700 px-3 py-1.5 text-white hover:bg-red-600" onClick={() => execute("delete-all")}>Delete everything</button>
      </div>
    </Dialog>
  );
}

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-[440px] max-w-[calc(100vw-32px)] rounded-lg bg-[var(--bg-elevated)] p-4 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <h2 className="mb-3 text-sm font-semibold text-zinc-100">{title}</h2>
        {children}
      </div>
    </div>
  );
}
