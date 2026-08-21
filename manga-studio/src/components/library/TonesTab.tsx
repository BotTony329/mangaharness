"use client";

/**
 * The Tones shelf.
 *
 * Screentone is how manga says "shadow", "night", "anxiety" and "this fabric is
 * grey" — so it is a first-class shelf beside Characters and Scenes, not a
 * setting buried in an inspector. Built-in patterns, generated textures and
 * uploaded stickers sit together, because a creator looking for gloom does not
 * care which of the three produced it.
 *
 * Clicking applies to the panel you are working in. Dragging drops it on a
 * specific panel. Either way the result is a layer you can move, edit, hide and
 * delete — nothing is baked into the artwork.
 */

import { useMemo, useRef, useState } from "react";
import {
  TONE_FAMILIES,
  TONE_FAMILY_LABELS,
  presetsInFamily,
  type ToneFamily,
  type TonePreset,
} from "@/domain/tones";
import type { SourceAsset } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { assetPreviewUrl } from "@/assets/renderSource";
import { DeleteIcon, GenerateIcon, ICON_STROKE, UploadIcon } from "../ui/icons";
import { ToneSwatch } from "./ToneSwatch";
import { uploadImageFile } from "./uploadAsset";
import { repairAssetTransparency, type RepairProgress } from "@/assets/clientProcessing";
import { applyToneToWorkingPanel, TONE_DRAG_TYPE, toneDragPayload } from "@/tones/apply";
import { AssetDeleteDialog } from "./LifecycleDialogs";

/** Shelves that open on first view — the ones a creator reaches for daily. */
const OPEN_BY_DEFAULT: ToneFamily[] = ["basic", "hatching", "gradient"];

export function TonesTab() {
  const doc = useEditorStore((s) => s.doc);
  const openGenerator = useUiStore((s) => s.openGenerator);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<ToneFamily[]>(OPEN_BY_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SourceAsset | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const toneAssets = useMemo(
    () =>
      Object.values(doc?.assets ?? {}).filter(
        (asset) => asset.category === "tone" && asset.status !== "archived",
      ),
    [doc],
  );

  if (!doc) return null;

  /**
   * Uploaded tones that are still opaque.
   *
   * A tone with no alpha paints a white box over the artwork. Rather than
   * stripping backgrounds automatically — which would destroy a legitimately
   * light pattern — the existing repair workflow is offered, the same one the
   * character shelf uses.
   */
  const opaqueTones = toneAssets.filter((asset) => !asset.hasAlpha && !asset.processedImageUrl);

  const term = search.trim().toLowerCase();
  const matches = (text: string) => term.length === 0 || text.toLowerCase().includes(term);
  const shelves = TONE_FAMILIES.map((family) => ({
    family,
    presets: presetsInFamily(family).filter((preset) => matches(preset.name) || matches(preset.use)),
  }));
  const myTones = toneAssets.filter((asset) => matches(asset.name));
  const nothingMatches = term.length > 0 && myTones.length === 0 && shelves.every((shelf) => shelf.presets.length === 0);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await uploadImageFile(file, "tone");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That image could not be added.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div>
      <p className="mb-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
        Tone is a layer over your art. Click one to lay it over the panel you are working in — your drawing
        underneath is never changed.
      </p>

      <input
        className="mb-2 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 text-xs"
        placeholder="Search tones…"
        aria-label="Search tones"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />

      <div className="mb-3 flex gap-1.5">
        <button
          className="flex flex-1 items-center justify-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]"
          onClick={() => openGenerator({ assetType: "tone" })}
        >
          <GenerateIcon size={12} strokeWidth={ICON_STROKE} /> Generate Tone
        </button>
        <button
          className="flex flex-1 items-center justify-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)] disabled:opacity-50"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          <UploadIcon size={12} strokeWidth={ICON_STROKE} /> {busy ? "Adding…" : "Upload Tone"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => onFiles(event.target.files)}
        />
      </div>

      {error && <p className="mb-2 rounded-md bg-[var(--bg-elevated)] p-2 text-[11px] text-[var(--danger)]">{error}</p>}
      {nothingMatches && (
        <p className="mb-3 rounded-md bg-[var(--bg-elevated)] p-2 text-[11px] text-zinc-500">
          Nothing matches “{search}”. Generate one — it becomes reusable across the project.
        </p>
      )}

      {myTones.length > 0 && (
        <section className="mb-3">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
            My Tones <span className="text-zinc-600">({myTones.length})</span>
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            {myTones.map((asset) => (
              <div key={asset.id} className="group relative">
                <button
                  className="w-full overflow-hidden rounded border border-[var(--border-subtle)] hover:border-[var(--accent)]"
                  title={asset.name}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(TONE_DRAG_TYPE, toneDragPayload({ assetId: asset.id }));
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => applyToneToWorkingPanel({ assetId: asset.id })}
                >
                  {/* Checkerboard reads through a transparent overlay tone. */}
                  <span className="block bg-[repeating-conic-gradient(#e5e5e5_0_25%,#ffffff_0_50%)] bg-[length:12px_12px]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={assetPreviewUrl(asset)} alt="" className="h-14 w-full object-cover" />
                  </span>
                </button>
                <button
                  className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-zinc-300 opacity-0 group-hover:opacity-100"
                  aria-label={`Delete ${asset.name}`}
                  onClick={() => setDeleteTarget(asset)}
                >
                  <DeleteIcon size={11} strokeWidth={ICON_STROKE} />
                </button>
                <p className="mt-0.5 truncate text-[10px] text-zinc-500">{asset.name}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {opaqueTones.length > 0 && <ToneTransparencyRepair assetIds={opaqueTones.map((asset) => asset.id)} />}

      {shelves.map(({ family, presets }) => {
        if (presets.length === 0) return null;
        const expanded = open.includes(family) || term.length > 0;
        return (
          <section key={family} className="mb-2">
            <button
              className="mb-1 flex w-full items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
              onClick={() => setOpen((current) => (current.includes(family) ? current.filter((f) => f !== family) : [...current, family]))}
              aria-expanded={expanded}
            >
              <span>
                {TONE_FAMILY_LABELS[family]} <span className="text-zinc-600">({presets.length})</span>
              </span>
              <span className="text-zinc-600">{expanded ? "−" : "+"}</span>
            </button>
            {expanded && (
              <div className="grid grid-cols-3 gap-1.5">
                {presets.map((preset) => (
                  <TonePresetButton key={preset.id} preset={preset} />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {deleteTarget && <AssetDeleteDialog asset={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </div>
  );
}

function TonePresetButton({ preset }: { preset: TonePreset }) {
  return (
    <button
      className="group flex flex-col items-center gap-0.5"
      title={`${preset.name} — ${preset.use}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(TONE_DRAG_TYPE, toneDragPayload({ presetId: preset.id }));
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => applyToneToWorkingPanel({ presetId: preset.id })}
    >
      <span className="rounded ring-offset-1 ring-offset-[var(--bg-panel)] group-hover:ring-1 group-hover:ring-[var(--accent)]">
        <ToneSwatch params={preset.params} size={56} />
      </span>
      <span className="w-full truncate text-center text-[10px] text-zinc-500 group-hover:text-zinc-300">{preset.name}</span>
    </button>
  );
}


/**
 * The SAME transparency repair the character shelf offers, pointed at tones.
 *
 * Not a second pipeline: `repairAssetTransparency` is the existing service, and
 * originals are never modified by it.
 */
function ToneTransparencyRepair({ assetIds }: { assetIds: string[] }) {
  const [progress, setProgress] = useState<RepairProgress | null>(null);
  const [failure, setFailure] = useState<string>();
  const running = progress !== null && progress.done < progress.total;

  return (
    <div className="mb-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-zinc-500">
          {running
            ? `Rebuilding ${progress.done}/${progress.total}…`
            : progress
              ? `Rebuilt ${progress.total - progress.failed}/${progress.total}${progress.failed ? ` · ${progress.failed} failed` : ""}`
              : `${assetIds.length} tone${assetIds.length === 1 ? "" : "s"} would cover the art with a solid background.`}
        </span>
        <button
          className="shrink-0 rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] text-zinc-300 hover:border-[var(--accent)] disabled:opacity-40"
          disabled={running}
          title="Removes the flat background so the pattern can sit over your art. The original upload is never modified."
          onClick={() => {
            setFailure(undefined);
            setProgress({ done: 0, total: assetIds.length, failed: 0 });
            void repairAssetTransparency(assetIds, setProgress).catch((cause: unknown) =>
              setFailure(cause instanceof Error ? cause.message : "Repair failed"),
            );
          }}
        >
          {running ? "Fixing…" : "Make transparent"}
        </button>
      </div>
      {failure && <p className="mt-1 text-[10px] text-[var(--danger)]">{failure}</p>}
    </div>
  );
}
