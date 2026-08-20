"use client";

/**
 * Character library: each character is a structured collection of reusable
 * assets browsable by pose / expression / view — not a folder of files.
 */

import { useEffect, useRef, useState } from "react";
import { addCharacter, removeCharacter, setCharacterReference } from "@/domain/libraryOps";
import type { Character, SourceAsset } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { AssetThumb } from "./AssetThumb";
import { uploadImageFile } from "./uploadAsset";
import {
  inspectReferenceImage,
  REFERENCE_ACCEPT,
  type ReferenceImageSelection,
} from "./referenceImage";

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
  const [reference, setReference] = useState<ReferenceImageSelection | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [providerStatus, setProviderStatus] = useState<{
    configured: boolean;
    storage?: { configured?: boolean };
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const openGenerator = useUiStore((s) => s.openGenerator);

  useEffect(() => {
    fetch("/api/provider/status")
      .then((response) => response.json())
      .then(setProviderStatus)
      .catch(() => setProviderStatus({ configured: false }));
  }, []);

  useEffect(() => () => {
    if (reference) URL.revokeObjectURL(reference.previewUrl);
  }, [reference]);

  const chooseReference = async (file?: File) => {
    if (!file) return;
    setError(null);
    try {
      const inspected = await inspectReferenceImage(file);
      const previewUrl = URL.createObjectURL(file);
      setReference((previous) => {
        if (previous) URL.revokeObjectURL(previous.previewUrl);
        return { ...inspected, previewUrl };
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reference image could not be read.");
    }
  };

  const removeReference = () => {
    setReference((previous) => {
      if (previous) URL.revokeObjectURL(previous.previewUrl);
      return null;
    });
    if (fileInput.current) fileInput.current.value = "";
  };

  const create = async (generateAfter: boolean) => {
    if (!name.trim()) {
      setError("Give the character a name");
      return;
    }
    if (generateAfter && providerStatus?.configured !== true) {
      onClose();
      useUiStore.getState().openSettings();
      return;
    }
    if (generateAfter && providerStatus?.storage?.configured === false) {
      setError("Generation is unavailable until persistent asset storage is connected by the Manga Studio operator.");
      return;
    }
    setIsBusy(true);
    setError(null);
    let characterId = "";
    useEditorStore.getState().commit((d) => {
      const result = addCharacter(d, name.trim(), description.trim() || undefined);
      characterId = result.characterId;
      return result.doc;
    });
    const referenceFile = reference?.file;
    if (referenceFile) {
      try {
        const assetId = await uploadImageFile(referenceFile, "character", {
          name: `${name} reference`,
          metadata: { characterId },
        });
        useEditorStore.getState().commit((d) => setCharacterReference(d, characterId, assetId));
      } catch (e) {
        useEditorStore.getState().commit((d) => removeCharacter(d, characterId));
        setError(e instanceof Error ? e.message : "Reference upload failed");
        setIsBusy(false);
        return;
      }
    }
    onClose();
    if (generateAfter) openGenerator({ assetType: "character", characterId });
  };

  const generationUnavailable = providerStatus?.configured === false || providerStatus?.storage?.configured === false;

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
        <input
          ref={fileInput}
          type="file"
          accept={REFERENCE_ACCEPT.join(",")}
          className="hidden"
          onChange={(event) => chooseReference(event.target.files?.[0])}
        />
        {reference ? (
          <div className="mb-3 rounded-md border border-zinc-700 bg-zinc-950 p-2">
            <div className="flex gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={reference.previewUrl} alt="Character reference preview" className="h-24 w-24 rounded object-cover" />
              <div className="min-w-0 flex-1 text-xs">
                <p className="truncate font-medium text-zinc-200">{reference.file.name}</p>
                <p className="mt-1 text-zinc-500">{reference.width} × {reference.height}px</p>
                <p className="text-zinc-500">{(reference.file.size / 1024 / 1024).toFixed(2)} MB</p>
                <div className="mt-3 flex gap-2">
                  <button className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800" onClick={() => fileInput.current?.click()}>
                    Replace
                  </button>
                  <button className="rounded px-2 py-1 text-red-400 hover:bg-red-950/40" onClick={removeReference}>
                    Remove
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="mb-3 flex w-full flex-col items-center rounded-md border border-dashed border-zinc-600 bg-zinc-950/60 px-4 py-5 text-center hover:border-indigo-500 hover:bg-indigo-950/20"
            onClick={() => fileInput.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              chooseReference(event.dataTransfer.files[0]);
            }}
          >
            <span className="text-sm text-zinc-300">Drop an image here</span>
            <span className="mt-1 text-xs text-zinc-500">or click to browse · PNG, JPG, WEBP · max 10 MB</span>
          </button>
        )}
        {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 text-xs">
          <button disabled={isBusy} className="rounded px-3 py-1.5 text-zinc-400 hover:text-zinc-200 disabled:opacity-40" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded border border-zinc-600 bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700"
            disabled={isBusy}
            onClick={() => create(false)}
          >
            {isBusy ? "Creating…" : "Create"}
          </button>
          {generationUnavailable ? (
            <button
              className="rounded bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-500"
              onClick={() => {
                if (providerStatus?.configured === false) {
                  onClose();
                  useUiStore.getState().openSettings();
                } else {
                  setError("Generation is unavailable until persistent asset storage is connected by the Manga Studio operator.");
                }
              }}
            >
              {providerStatus?.configured === false ? "Connect Image Model" : "Storage Required"}
            </button>
          ) : (
            <button
              className="rounded bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-500 disabled:opacity-40"
              disabled={isBusy || providerStatus === null}
              onClick={() => create(true)}
            >
              Create &amp; Generate
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
