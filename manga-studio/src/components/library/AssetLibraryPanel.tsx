"use client";

/**
 * Left dock: the asset library. Visual thumbnails only — users never see
 * filenames. Tabs per category; characters get a structured browser.
 */

import { useRef, useState } from "react";
import { removeAsset } from "@/domain/libraryOps";
import type { AssetCategory } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { AssetThumb } from "./AssetThumb";
import { CharactersTab } from "./CharactersTab";
import { uploadImageFile } from "./uploadAsset";

type LibraryTab = "characters" | "backgrounds" | "props" | "uploads";

const TABS: { id: LibraryTab; label: string }[] = [
  { id: "characters", label: "Characters" },
  { id: "backgrounds", label: "Backgrounds" },
  { id: "props", label: "Props" },
  { id: "uploads", label: "Uploads" },
];

const TAB_CATEGORY: Record<Exclude<LibraryTab, "characters">, AssetCategory> = {
  backgrounds: "background",
  props: "prop",
  uploads: "upload",
};

export function AssetLibraryPanel() {
  const [tab, setTab] = useState<LibraryTab>("characters");

  return (
    <aside className="flex w-[280px] shrink-0 flex-col bg-zinc-900">
      <nav className="flex border-b border-zinc-800 text-xs">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 px-1 py-2 ${
              tab === t.id ? "border-b-2 border-indigo-500 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto p-3">
        {tab === "characters" ? <CharactersTab /> : <CategoryGrid category={TAB_CATEGORY[tab]} />}
      </div>
    </aside>
  );
}

function CategoryGrid({ category }: { category: AssetCategory }) {
  const doc = useEditorStore((s) => s.doc);
  const openGenerator = useUiStore((s) => s.openGenerator);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!doc) return null;
  const assets = Object.values(doc.assets).filter((a) => a.category === category);
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
          className="flex-1 rounded border border-zinc-700 bg-zinc-800 py-1.5 text-xs hover:bg-zinc-700"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
        {generatorType && (
          <button
            className="flex-1 rounded border border-indigo-600 bg-indigo-600/20 py-1.5 text-xs text-indigo-300 hover:bg-indigo-600/40"
            onClick={() => openGenerator({ assetType: generatorType })}
          >
            + Generate
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
        <p className="mt-8 text-center text-xs text-zinc-600">
          Nothing here yet.
          <br />
          Upload {generatorType ? "or generate " : ""}assets, then drag them into panels.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {assets.map((asset) => (
            <AssetThumb
              key={asset.id}
              asset={asset}
              onDelete={() => {
                if (confirm(`Remove "${asset.name}" and all its panel instances?`)) {
                  useEditorStore.getState().commit((d) => removeAsset(d, asset.id));
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
