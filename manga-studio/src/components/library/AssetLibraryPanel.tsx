"use client";

/**
 * Left dock: the asset library. Visual thumbnails only — users never see
 * filenames. Tabs per category; characters get a structured browser.
 */

import { useRef, useState } from "react";
import type { AssetCategory, SourceAsset } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { AssetThumb } from "./AssetThumb";
import { CharactersTab } from "./CharactersTab";
import { MangaFxTab } from "./MangaFxTab";
import { TonesTab } from "./TonesTab";
import { ProjectsPanel } from "./ProjectsPanel";
import { uploadImageFile } from "./uploadAsset";
import { AssetDeleteDialog } from "./LifecycleDialogs";

/**
 * Creator-facing categories.
 *
 * "Backgrounds" was too narrow — a classroom, a street and a train station are
 * SCENES. And a lamp or a notebook is an OBJECT, not a background: it is a
 * reusable cutout that belongs on top of a scene. The distinction the creator
 * sees is what the thing IS; underneath, Scenes map to the background asset
 * category (kept whole) and Objects to prop (extracted).
 */
type LibraryTab = "characters" | "scenes" | "objects" | "mangafx" | "tones" | "uploads";

const TABS: { id: LibraryTab; label: string }[] = [
  { id: "characters", label: "Characters" },
  { id: "scenes", label: "Scenes" },
  { id: "objects", label: "Objects" },
  { id: "mangafx", label: "Manga FX" },
  { id: "tones", label: "Tones" },
  { id: "uploads", label: "Uploads" },
];

const TAB_CATEGORY: Record<Exclude<LibraryTab, "characters" | "mangafx" | "tones">, AssetCategory> = {
  scenes: "background",
  objects: "prop",
  uploads: "upload",
};

/**
 * The left dock: navigation and asset discovery (§15).
 *
 * Two questions, in order — which project am I in, and what exists in it. It is
 * deliberately NOT a second editing surface: the duplicate Pose / Face / Outfit
 * / View matrix that used to live here has been removed, because the selected
 * actor's controls belong to the right inspector and having both meant two
 * paths to the same edit at different cost.
 */
export function AssetLibraryPanel() {
  const [tab, setTab] = useState<LibraryTab>("characters");
  const doc = useEditorStore((s) => s.doc);

  return (
    <aside className="flex w-[280px] shrink-0 flex-col" style={{ background: "var(--bg-panel)" }}>
      <ProjectsPanel />
      {!doc ? (
        <p className="p-3 text-center text-[11px] text-zinc-600">Open or create a project to see its assets.</p>
      ) : (
        <>
      <p className="px-2 pt-2 text-[10px] uppercase tracking-wider text-zinc-500">
        {doc.project.name} · Assets
      </p>
      <nav className="flex border-b text-xs" style={{ borderColor: "var(--border-subtle)" }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 px-0.5 py-2 text-[11px] ${
              tab === t.id ? "border-b-2 border-[var(--accent)] text-[var(--text-primary)]" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto p-3">
        {tab === "characters" ? (
          <CharactersTab />
        ) : tab === "mangafx" ? (
          <MangaFxTab />
        ) : tab === "tones" ? (
          <TonesTab />
        ) : (
          <CategoryGrid category={TAB_CATEGORY[tab]} />
        )}
      </div>
        </>
      )}
    </aside>
  );
}

function CategoryGrid({ category }: { category: AssetCategory }) {
  const doc = useEditorStore((s) => s.doc);
  const openGenerator = useUiStore((s) => s.openGenerator);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SourceAsset | null>(null);

  if (!doc) return null;
  const assets = Object.values(doc.assets).filter((a) => a.category === category && a.status !== "archived");
  const archived = Object.values(doc.assets).filter((a) => a.category === category && a.status === "archived");
  const generatorType = category === "background" ? "background" : category === "prop" ? "prop" : null;

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) await uploadImageFile(file, category);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-3 flex gap-2">
        <button
          className="flex-1 rounded-md py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)]" style={{ background: "var(--bg-elevated)" }}
          onClick={() => fileInput.current?.click()}
          disabled={busy}
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
        {generatorType && (
          <button
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)]" style={{ background: "var(--accent)" }}
            onClick={() => openGenerator({ assetType: generatorType })}
          >
            {category === "background" ? "+ Generate Scene" : category === "prop" ? "+ Generate Object" : "+ Generate"}
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>
      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      {assets.length === 0 ? (
        <div className="mt-6 rounded-md p-3 text-center text-[11px] leading-5" style={{ background: "var(--bg-elevated)", color: "var(--text-muted)" }}>
          {category === "background" ? (
            <>
              <p className="text-zinc-400">No scenes yet.</p>
              <p className="mt-1 text-zinc-600">
                Generate an environment — a classroom, a cyberpunk street, a bedroom — and drop it into a panel.
              </p>
            </>
          ) : category === "prop" ? (
            <>
              <p className="text-zinc-400">No objects yet.</p>
              <p className="mt-1 text-zinc-600">
                Generate reusable items such as lamps, books, phones, bags and furniture. Objects are cut out, so
                they sit on top of a scene.
              </p>
            </>
          ) : (
            <p className="text-zinc-600">Nothing here yet. Upload files to reuse them across panels.</p>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {assets.map((asset) => (
            <AssetThumb
              key={asset.id}
              asset={asset}
              onUse={() => {
                const store = useEditorStore.getState();
                const page = store.currentPageId ? store.doc?.pages[store.currentPageId] : undefined;
                const panelId = store.selection.panelId ?? page?.panelIds[0];
                if (panelId) store.dispatch({ type: "add-instance", panelId, assetId: asset.id });
              }}
              onRename={() => {
                const name = prompt("Rename asset", asset.name);
                if (name?.trim()) useEditorStore.getState().dispatch({ type: "rename-asset", assetId: asset.id, name });
              }}
              onRegenerate={generatorType ? () => openGenerator({
                assetType: generatorType,
                replaceAssetId: asset.id,
                prefill: { description: asset.provenance?.prompt ?? asset.name },
              }) : undefined}
              onArchive={() => useEditorStore.getState().dispatch({ type: "archive-asset", assetId: asset.id })}
              onDelete={() => setDeleteTarget(asset)}
            />
          ))}
        </div>
      )}
      {archived.length > 0 && (
        <details className="mt-4 border-t pt-3" style={{ borderColor: "var(--border-subtle)" }}>
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-zinc-500">Archived ({archived.length})</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {archived.map((asset) => (
              <AssetThumb
                key={asset.id}
                asset={asset}
                subtitle="Archived"
                onRestore={() => useEditorStore.getState().dispatch({ type: "restore-asset", assetId: asset.id })}
                onDelete={() => setDeleteTarget(asset)}
              />
            ))}
          </div>
        </details>
      )}
      {deleteTarget && <AssetDeleteDialog asset={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </div>
  );
}
