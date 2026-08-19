"use client";

/**
 * Character library: each character is a structured collection of reusable
 * assets browsable by pose / expression / view — not a folder of files.
 */

import { useRef, useState } from "react";
import { addCharacter, setCharacterReference } from "@/domain/libraryOps";
import type { Character, SourceAsset } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { AssetThumb } from "./AssetThumb";
import { uploadImageFile } from "./uploadAsset";

export function CharactersTab() {
  const doc = useEditorStore((s) => s.doc);
  const [creating, setCreating] = useState(false);
  if (!doc) return null;

  const characters = Object.values(doc.characters);
  return (
    <div className="space-y-3">
      <button
        className="w-full rounded border border-indigo-600 bg-indigo-600/20 py-1.5 text-xs text-indigo-300 hover:bg-indigo-600/40"
        onClick={() => setCreating(true)}
      >
        + New Character
      </button>
      {characters.length === 0 && (
        <p className="mt-6 text-center text-xs text-zinc-600">
          Create a character, then generate poses and expressions you can reuse in every panel.
        </p>
      )}
      {characters.map((character) => (
        <CharacterCard key={character.id} character={character} />
      ))}
      {creating && <CreateCharacterDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Slot sections: how the browser groups a character's assets. */
const SECTIONS = [
  { key: "pose", label: "Poses", generator: "character-pose" as const },
  { key: "expression", label: "Expressions", generator: "character-expression" as const },
] as const;

function CharacterCard({ character }: { character: Character }) {
  const doc = useEditorStore((s) => s.doc)!;
  const openGenerator = useUiStore((s) => s.openGenerator);
  const [open, setOpen] = useState(true);

  const assets = character.assetIds.map((id) => doc.assets[id]).filter(Boolean) as SourceAsset[];
  const reference = character.referenceAssetId ? doc.assets[character.referenceAssetId] : undefined;
  const bySection = (key: "pose" | "expression") => assets.filter((a) => a.metadata?.[key]);
  const other = assets.filter(
    (a) => !a.metadata?.pose && !a.metadata?.expression && a.id !== character.referenceAssetId,
  );

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        <span className="text-zinc-500">{open ? "▾" : "▸"}</span>
        <span className="text-sm font-medium text-zinc-200">{character.name}</span>
        <span className="ml-auto text-[10px] text-zinc-500">{assets.length} assets</span>
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {character.description && <p className="text-[11px] leading-4 text-zinc-500">{character.description}</p>}
          {reference ? (
            <AssetThumb asset={reference} subtitle="Reference" />
          ) : (
            <button
              className="w-full rounded border border-dashed border-zinc-700 py-2 text-xs text-zinc-500 hover:border-indigo-600 hover:text-indigo-300"
              onClick={() => openGenerator({ assetType: "character", characterId: character.id })}
            >
              Generate character reference
            </button>
          )}
          {SECTIONS.map(({ key, label, generator }) => (
            <div key={key}>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
              <div className="flex flex-wrap gap-2">
                {groupVariations(bySection(key), key).map(({ slot, variants }) => (
                  <AssetThumb
                    key={variants[0].id}
                    asset={variants[variants.length - 1]}
                    subtitle={variants.length > 1 ? `${slot} · ${variants.length} variants` : slot}
                  />
                ))}
                <button
                  className="h-[104px] w-[104px] rounded-md border border-dashed border-zinc-700 text-xs text-zinc-500 hover:border-indigo-600 hover:text-indigo-300"
                  onClick={() => openGenerator({ assetType: generator, characterId: character.id })}
                >
                  + Generate
                </button>
              </div>
            </div>
          ))}
          {other.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Other</p>
              <div className="flex flex-wrap gap-2">
                {other.map((asset) => (
                  <AssetThumb key={asset.id} asset={asset} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Regenerations of the same slot stack as variations instead of clutter. */
function groupVariations(assets: SourceAsset[], key: "pose" | "expression") {
  const groups = new Map<string, SourceAsset[]>();
  for (const asset of assets) {
    const slot = String(asset.metadata?.[key] ?? "unnamed");
    groups.set(slot, [...(groups.get(slot) ?? []), asset]);
  }
  return Array.from(groups.entries()).map(([slot, variants]) => ({ slot, variants }));
}

function CreateCharacterDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const openGenerator = useUiStore((s) => s.openGenerator);

  const create = async (generateAfter: boolean) => {
    if (!name.trim()) {
      setError("Give the character a name");
      return;
    }
    let characterId = "";
    useEditorStore.getState().commit((d) => {
      const result = addCharacter(d, name.trim(), description.trim() || undefined);
      characterId = result.characterId;
      return result.doc;
    });
    const referenceFile = fileInput.current?.files?.[0];
    if (referenceFile) {
      try {
        const assetId = await uploadImageFile(referenceFile, "character", {
          name: `${name} reference`,
          metadata: { characterId },
        });
        useEditorStore.getState().commit((d) => setCharacterReference(d, characterId, assetId));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Reference upload failed");
        return;
      }
    }
    onClose();
    if (generateAfter) openGenerator({ assetType: "character", characterId });
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60" onMouseDown={onClose}>
      <div
        className="w-[380px] rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-zinc-100">New Character</h2>
        <label className="mb-1 block text-xs text-zinc-400">Name</label>
        <input
          className="mb-3 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Akari"
          autoFocus
        />
        <label className="mb-1 block text-xs text-zinc-400">Description</label>
        <textarea
          className="mb-3 h-20 w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Japanese high school girl, short black hair, winter school uniform, manga style."
        />
        <label className="mb-1 block text-xs text-zinc-400">Reference image (optional)</label>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="mb-3 w-full text-xs" />
        {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 text-xs">
          <button className="rounded px-3 py-1.5 text-zinc-400 hover:text-zinc-200" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded border border-zinc-600 bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700"
            onClick={() => create(false)}
          >
            Create
          </button>
          <button
            className="rounded bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-500"
            onClick={() => create(true)}
          >
            Create &amp; Generate
          </button>
        </div>
      </div>
    </div>
  );
}
