"use client";

/**
 * The Manga FX shelf: the scalable surface for manga language (§3).
 *
 * The toolbar keeps quick access to a handful of built-ins; this is where the
 * catalogue actually lives, because a dropdown cannot hold uploads and
 * generated assets that grow with the project. Built-ins, uploads and
 * AI-generated assets sit side by side — the creator should not have to care
 * which is which to use one.
 */

import { useMemo, useRef, useState } from "react";
import type { MangaLanguageAsset, MangaLanguageCategory } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { DeleteIcon, ICON_STROKE, RenameIcon } from "../ui/icons";
import {
  CATEGORY_LABELS,
  LANGUAGE_CATEGORIES,
  LANGUAGE_DRAG_TYPE,
  languageSourceAsset,
  searchLanguageAssets,
} from "@/language/library";
import { assetRenderUrl } from "@/assets/renderSource";
import { uploadImageFile } from "./uploadAsset";

/** Categories whose custom assets are images rather than parameters. */
const UPLOADABLE: MangaLanguageCategory[] = ["bubbles", "effects", "tones", "emotion", "sfx", "decorations"];

export function MangaFxTab() {
  const doc = useEditorStore((s) => s.doc);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<MangaLanguageCategory[]>(["bubbles", "effects", "emotion"]);

  const grouped = useMemo(() => {
    if (!doc) return [];
    return LANGUAGE_CATEGORIES.map((category) => ({
      category,
      hits: searchLanguageAssets(doc, { category, text: search || undefined }),
    }));
  }, [doc, search]);

  if (!doc) return null;
  const totalHits = grouped.reduce((sum, group) => sum + group.hits.length, 0);

  return (
    <div>
      <input
        className="mb-3 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 text-xs"
        placeholder="Search effects, bubbles, tones…"
        aria-label="Search manga language library"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {search && totalHits === 0 && (
        <p className="mb-3 rounded-md bg-[var(--bg-elevated)] p-2 text-[11px] text-zinc-500">
          Nothing matches “{search}”. Generate or upload one — it becomes reusable across the project.
        </p>
      )}
      {grouped.map((group) => (
        <CategorySection
          key={group.category}
          category={group.category}
          assets={group.hits.map((hit) => hit.asset)}
          expanded={open.includes(group.category) || Boolean(search)}
          onToggle={() =>
            setOpen((current) =>
              current.includes(group.category)
                ? current.filter((id) => id !== group.category)
                : [...current, group.category],
            )
          }
        />
      ))}
    </div>
  );
}

function CategorySection({
  category,
  assets,
  expanded,
  onToggle,
}: {
  category: MangaLanguageCategory;
  assets: MangaLanguageAsset[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const openGenerator = useUiStore((s) => s.openGenerator);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        // The image goes through the normal upload path, so transparency is
        // handled by the same pipeline that handles character cutouts.
        const assetId = await uploadImageFile(file, "upload");
        useEditorStore.getState().dispatch({
          type: "add-language-asset",
          input: {
            category,
            name: file.name.replace(/\.[^.]+$/, ""),
            source: "upload",
            format: "visual",
            assetId,
            tags: [category, "custom"],
          },
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-3 border-b border-zinc-800 pb-3 last:border-b-0">
      <button
        className="mb-2 flex w-full items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span>
          {CATEGORY_LABELS[category]} <span className="text-zinc-600">({assets.length})</span>
        </span>
        <span>{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <>
          <div className="mb-2 flex gap-1.5">
            <button
              className="flex-1 rounded-md bg-[var(--accent-soft)] py-1 text-[11px] text-[var(--accent-text)] transition-colors hover:bg-[var(--accent)] hover:text-white"
              onClick={() => openGenerator({ assetType: "manga-effect", languageCategory: category })}
            >
              + Generate
            </button>
            {UPLOADABLE.includes(category) && (
              <button
                className="flex-1 rounded border border-zinc-700 bg-zinc-800 py-1 text-[11px] hover:bg-zinc-700"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
              >
                {busy ? "Uploading…" : "+ Upload"}
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              // SVG is deliberately absent: the upload path measures dimensions
              // with createImageBitmap, which does not decode SVG, so offering
              // it would be an affordance that always fails.
              accept="image/png,image/webp,image/jpeg"
              multiple
              hidden
              onChange={(event) => onFiles(event.target.files)}
            />
          </div>
          {error && <p className="mb-2 text-[11px] text-red-400">{error}</p>}
          {assets.length === 0 ? (
            <p className="py-2 text-center text-[11px] text-zinc-600">Nothing here yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {assets.map((asset) => (
                <LanguageThumb key={asset.id} asset={asset} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function LanguageThumb({ asset }: { asset: MangaLanguageAsset }) {
  const doc = useEditorStore((s) => s.doc);
  const source = doc ? languageSourceAsset(doc, asset) : undefined;
  const preview = asset.thumbnailUrl ?? (source ? assetRenderUrl(source) : undefined);
  const owned = Boolean(doc?.language[asset.id]);

  const place = () => {
    const store = useEditorStore.getState();
    const page = store.currentPageId ? store.doc?.pages[store.currentPageId] : undefined;
    const panelId = store.selection.panelId ?? store.doc?.items[store.selection.itemId ?? ""]?.panelId ?? page?.panelIds[0];
    if (!panelId) return;
    // Dropping onto a selected character attaches the effect to it (§11), so
    // moving the character afterwards carries the effect along.
    const selectedItem = store.selection.itemId ? store.doc?.items[store.selection.itemId] : undefined;
    const attachToItemId =
      selectedItem?.kind === "asset" && selectedItem.panelId === panelId ? selectedItem.id : undefined;
    store.dispatch({ type: "place-language-asset", panelId, languageAssetId: asset.id, attachToItemId });
  };

  return (
    <div className="group relative w-[72px]">
      <button
        className="flex h-[56px] w-full items-center justify-center overflow-hidden rounded border border-zinc-700 bg-zinc-800 hover:border-[var(--accent)]"
        onClick={place}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(LANGUAGE_DRAG_TYPE, asset.id);
          event.dataTransfer.effectAllowed = "copy";
        }}
        title={`${asset.name}${asset.tags.length ? ` · ${asset.tags.join(", ")}` : ""}`}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={asset.name} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="px-1 text-center text-[10px] leading-3 text-zinc-400">{asset.name}</span>
        )}
      </button>
      <p className="mt-0.5 truncate text-[9px] text-zinc-500" title={asset.name}>
        {asset.name}
      </p>
      {owned && (
        <div className="absolute right-0.5 top-0.5 hidden gap-0.5 group-hover:flex">
          <IconButton
            label="Rename"
            onClick={() => {
              const name = window.prompt("Rename effect", asset.name);
              if (name?.trim()) {
                useEditorStore.getState().dispatch({
                  type: "update-language-asset",
                  languageAssetId: asset.id,
                  patch: { name },
                });
              }
            }}
          >
            <RenameIcon size={12} strokeWidth={ICON_STROKE} />
          </IconButton>
          <IconButton
            label="Delete"
            onClick={() => {
              useEditorStore.getState().dispatch({ type: "delete-language-asset", languageAssetId: asset.id });
            }}
          >
            <DeleteIcon size={12} strokeWidth={ICON_STROKE} />
          </IconButton>
        </div>
      )}
      {!owned && (
        <button
          className="absolute right-0.5 top-0.5 hidden rounded bg-zinc-900/90 px-1 text-[9px] text-zinc-400 hover:text-zinc-100 group-hover:block"
          aria-label="Duplicate"
          title="Duplicate into your own library"
          onClick={() =>
            useEditorStore.getState().dispatch({ type: "duplicate-language-asset", languageAssetId: asset.id })
          }
        >
          ⧉
        </button>
      )}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="rounded bg-zinc-900/90 px-1 text-[9px] text-zinc-400 hover:text-zinc-100"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
