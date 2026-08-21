"use client";

/**
 * Character library: each character is a structured collection of reusable
 * assets browsable by pose / expression / view — not a folder of files.
 */

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_CHARACTER_STATE,
  characterReferenceId,
  findExactCharacterAsset,
  stateFromAsset,
} from "@/characters/state";
import { generateCharacterAssetForState, starterPackStates } from "@/characters/stateRuntime";
import type { Character, SourceAsset } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { RelationshipEditor } from "../inspector/RelationshipEditor";
import {
  AlertIcon,
  ChevronRightIcon,
  DeleteIcon,
  DoneIcon,
  ICON_SIZE_SM,
  ICON_STROKE,
  PendingIcon,
  RenameIcon,
  SpinnerIcon,
} from "../ui/icons";
import { AssetThumb } from "./AssetThumb";
import { AssetDeleteDialog, CharacterDeleteDialog } from "./LifecycleDialogs";
import { uploadImageFile } from "./uploadAsset";
import { repairAssetTransparency, type RepairProgress } from "@/assets/clientProcessing";
import { getActiveStyleProfile } from "@/styles/profiles";
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
        className="w-full rounded-md bg-[var(--accent-soft)] py-1.5 text-xs text-[var(--accent-text)] transition-colors hover:bg-[var(--accent)] hover:text-white"
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

function CharacterCard({ character }: { character: Character }) {
  const doc = useEditorStore((s) => s.doc)!;
  const openGenerator = useUiStore((s) => s.openGenerator);
  const [open, setOpen] = useState(true);
  const [deleteAssetTarget, setDeleteAssetTarget] = useState<SourceAsset | null>(null);
  const [deleteCharacterOpen, setDeleteCharacterOpen] = useState(false);

  const allAssets = character.assetIds.map((id) => doc.assets[id]).filter(Boolean) as SourceAsset[];
  const assets = allAssets.filter((asset) => asset.status !== "archived");
  const archivedAssets = allAssets.filter((asset) => asset.status === "archived");
  const referenceId = characterReferenceId(character);
  const referenceCandidate = referenceId ? doc.assets[referenceId] : undefined;
  const reference = referenceCandidate?.status !== "archived" ? referenceCandidate : undefined;
  const stateAssets = assets.filter((asset) => asset.metadata?.characterAssetRole !== "canonical");
  const stateGroups = groupCharacterStates(stateAssets, character.id);

  return (
    <section className="rounded-md p-2" style={{ background: "var(--bg-elevated)" }}>
      <div className="flex items-center gap-1">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)}>
          <ChevronRightIcon
            size={13}
            strokeWidth={ICON_STROKE}
            className={`shrink-0 text-[var(--text-muted)] transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className="truncate text-sm font-medium text-zinc-200">{character.name}</span>
          <span className="ml-auto text-[10px] text-zinc-500">{assets.length} assets</span>
        </button>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          title={`Rename ${character.name}`}
          aria-label={`Rename ${character.name}`}
          onClick={() => {
            const name = prompt("Rename Character", character.name);
            if (name?.trim()) useEditorStore.getState().dispatch({ type: "rename-character", characterId: character.id, name });
          }}
        >
          <RenameIcon size={ICON_SIZE_SM} strokeWidth={ICON_STROKE} />
        </button>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
          title={`Delete ${character.name}`}
          aria-label={`Delete ${character.name}`}
          onClick={() => setDeleteCharacterOpen(true)}
        >
          <DeleteIcon size={ICON_SIZE_SM} strokeWidth={ICON_STROKE} />
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-3">
          {(character.appearance ?? character.description) && <p className="text-[11px] leading-4 text-zinc-500">{character.appearance ?? character.description}</p>}
          {character.personalityNotes && <p className="text-[10px] italic leading-4 text-zinc-600">{character.personalityNotes}</p>}
          {reference ? (
            <AssetThumb
              asset={reference}
              subtitle="Reference"
              onRegenerate={() => openGenerator({ assetType: "character", characterId: character.id, replaceAssetId: reference.id })}
              onArchive={() => useEditorStore.getState().dispatch({ type: "archive-asset", assetId: reference.id })}
              onDelete={() => setDeleteAssetTarget(reference)}
            />
          ) : (
            <button
              className="w-full rounded border border-dashed border-zinc-700 py-2 text-xs text-zinc-500 hover:border-[var(--accent)] hover:text-[var(--accent-text)]"
              onClick={() => openGenerator({ assetType: "character", characterId: character.id })}
            >
              Generate character reference
            </button>
          )}
          <PuppetStatusRow character={character} />
          <TransparencyRepairRow character={character} />
          {/* A shortcut, not the primary surface: relationships are authored in
              the Inspector where the selected character lives. Keeping a second
              full editor here is how two copies drift. */}
          <RelationshipEditor character={character} compact />
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Rendered states</p>
            <div className="flex flex-wrap gap-2">
              {stateGroups.map(({ label, variants }) => (
                <AssetThumb
                  key={label}
                  asset={variants[variants.length - 1]}
                  subtitle={variants.length > 1 ? `${label} · ${variants.length} variations` : label}
                  onUse={() => {
                    const store = useEditorStore.getState();
                    const page = store.currentPageId ? store.doc?.pages[store.currentPageId] : undefined;
                    const panelId = store.selection.panelId ?? page?.panelIds[0];
                    if (panelId) store.dispatch({ type: "add-instance", panelId, assetId: variants[variants.length - 1].id });
                  }}
                  onRename={() => {
                    const asset = variants[variants.length - 1];
                    const name = prompt("Rename visual state", asset.name);
                    if (name?.trim()) useEditorStore.getState().dispatch({ type: "rename-asset", assetId: asset.id, name });
                  }}
                  onRegenerate={() => {
                    const asset = variants[variants.length - 1];
                    const state = stateFromAsset(asset, character.id);
                    openGenerator({
                      assetType: "character-pose",
                      characterId: character.id,
                      replaceAssetId: asset.id,
                      prefill: { pose: state?.pose ?? "standing", expression: state?.expression ?? "neutral" },
                    });
                  }}
                  onArchive={() => useEditorStore.getState().dispatch({ type: "archive-asset", assetId: variants[variants.length - 1].id })}
                  onDelete={() => setDeleteAssetTarget(variants[variants.length - 1])}
                />
              ))}
              <button
                className="h-[104px] w-[104px] rounded-md border border-dashed border-zinc-700 text-xs text-zinc-500 hover:border-[var(--accent)] hover:text-[var(--accent-text)]"
                onClick={() => openGenerator({ assetType: "character-pose", characterId: character.id })}
              >
                + Variation
              </button>
            </div>
          </div>
          {archivedAssets.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-zinc-500">Archived states ({archivedAssets.length})</summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {archivedAssets.map((asset) => (
                  <AssetThumb
                    key={asset.id}
                    asset={asset}
                    subtitle="Archived"
                    onRestore={() => useEditorStore.getState().dispatch({ type: "restore-asset", assetId: asset.id })}
                    onDelete={() => setDeleteAssetTarget(asset)}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {deleteAssetTarget && <AssetDeleteDialog asset={deleteAssetTarget} onClose={() => setDeleteAssetTarget(null)} />}
      {deleteCharacterOpen && <CharacterDeleteDialog character={character} onClose={() => setDeleteCharacterOpen(false)} />}
    </section>
  );
}

/** Regenerations of one complete state stack instead of becoming duplicates. */
function groupCharacterStates(assets: SourceAsset[], characterId: string) {
  const groups = new Map<string, SourceAsset[]>();
  for (const asset of assets) {
    const state = stateFromAsset(asset, characterId);
    if (!state) continue;
    const label = [state.pose, state.expression, state.outfit, state.view].map(title).join(" · ");
    groups.set(label, [...(groups.get(label) ?? []), asset]);
  }
  return Array.from(groups.entries()).map(([label, variants]) => ({ label, variants }));
}

type PackMode = "starter" | "reference";
type PackItem = { label: string; status: "pending" | "running" | "done" | "failed"; error?: string };

function CreateCharacterDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [appearance, setAppearance] = useState("");
  const [personalityNotes, setPersonalityNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<ReferenceImageSelection | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [mode, setMode] = useState<PackMode>("starter");
  const [packItems, setPackItems] = useState<PackItem[]>([]);
  const cancelRequested = useRef(false);
  const [providerStatus, setProviderStatus] = useState<{
    configured: boolean;
    storage?: { configured?: boolean };
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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
      setError("Generation is unavailable until persistent asset storage is connected by the Kumanga operator.");
      return;
    }
    setIsBusy(true);
    setError(null);
    const created = useEditorStore.getState().dispatch({
      type: "create-character",
      name: name.trim(),
      appearance: appearance.trim() || undefined,
      personalityNotes: personalityNotes.trim() || undefined,
    });
    const characterId = created.createdId;
    if (!characterId) throw new Error("Character creation failed");
    const referenceFile = reference?.file;
    if (referenceFile) {
      try {
        const assetId = await uploadImageFile(referenceFile, "character", {
          name: `${name} reference`,
          metadata: {
            characterId,
            ...DEFAULT_CHARACTER_STATE,
            characterAssetRole: "canonical",
          },
        });
        useEditorStore.getState().dispatch({ type: "set-character-reference", characterId, assetId });
      } catch (e) {
        useEditorStore.getState().dispatch({ type: "delete-character", characterId, mode: "delete-all" });
        setError(e instanceof Error ? e.message : "Reference upload failed");
        setIsBusy(false);
        return;
      }
    }
    if (!generateAfter) {
      onClose();
      return;
    }

    cancelRequested.current = false;
    try {
      await generatePack(characterId, mode, referenceFile !== undefined);
      if (!cancelRequested.current) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Starter pack generation failed");
    } finally {
      setIsBusy(false);
    }
  };

  const generatePack = async (characterId: string, selectedMode: PackMode, hasUploadedReference: boolean) => {
    const character = useEditorStore.getState().doc?.characters[characterId];
    if (!character) throw new Error("Character creation failed");
    const states = selectedMode === "starter" ? starterPackStates(character) : [];
    const initial: PackItem[] = [
      { label: hasUploadedReference ? "Canonical reference (uploaded)" : "Canonical reference", status: hasUploadedReference ? "done" : "pending" },
      ...states.map((state) => ({
        label: `${title(state.pose)} · ${title(state.expression)}`,
        status: "pending" as const,
      })),
    ];
    setPackItems(initial);

    const run = async (index: number, action: () => Promise<unknown>) => {
      if (cancelRequested.current) return false;
      setPackItems((items) => items.map((item, i) => i === index ? { ...item, status: "running" } : item));
      try {
        await action();
        setPackItems((items) => items.map((item, i) => i === index ? { ...item, status: "done" } : item));
        return true;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Generation failed";
        setPackItems((items) => items.map((item, i) => i === index ? { ...item, status: "failed", error: message } : item));
        throw cause;
      }
    };

    const offset = 1;
    if (!hasUploadedReference) {
      const canonicalState = { characterId, ...DEFAULT_CHARACTER_STATE };
      const continued = await run(0, () => generateCharacterAssetForState({ characterId, state: canonicalState, role: "canonical" }));
      if (!continued) return;
    }
    if (selectedMode === "reference") return;

    for (let index = 0; index < states.length; index++) {
      if (cancelRequested.current) return;
      const state = states[index];
      const latestDoc = useEditorStore.getState().doc;
      const latestCharacter = latestDoc?.characters[characterId];
      if (!latestDoc || !latestCharacter) throw new Error("Character no longer exists");
      const cached = findExactCharacterAsset(latestDoc, latestCharacter, state);
      if (cached) {
        setPackItems((items) => items.map((item, i) => i === index + offset ? { ...item, status: "done" } : item));
        continue;
      }
      await run(index + offset, () => generateCharacterAssetForState({ characterId, state, role: "state" }));
    }
  };

  const generationUnavailable = providerStatus?.configured === false || providerStatus?.storage?.configured === false;
  const activeStyle = getActiveStyleProfile(useEditorStore.getState().doc!);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60" onMouseDown={onClose}>
      <div
        className="max-h-[92vh] w-[380px] overflow-y-auto rounded-lg bg-[var(--bg-elevated)] p-4 shadow-2xl shadow-black/50"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-zinc-100">New Character</h2>
        <label htmlFor="character-name" className="mb-1 block text-xs text-zinc-400">Name</label>
        <input
          id="character-name"
          className="mb-3 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Akari"
          autoFocus
        />
        <label htmlFor="character-appearance" className="mb-1 block text-xs text-zinc-400">Appearance</label>
        <textarea
          id="character-appearance"
          className="mb-3 h-20 w-full resize-none rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 text-sm"
          value={appearance}
          onChange={(e) => setAppearance(e.target.value)}
          placeholder="Young girl with long sleek hair, calm eyes and a polished appearance."
        />
        <label htmlFor="character-personality" className="mb-1 block text-xs text-zinc-400">Personality / visual identity (optional)</label>
        <textarea
          id="character-personality"
          className="mb-3 h-16 w-full resize-none rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 text-sm"
          value={personalityNotes}
          onChange={(e) => setPersonalityNotes(e.target.value)}
          placeholder="Cool, composed and slightly aloof."
        />
        <p className="mb-3 rounded border border-violet-800/50 bg-violet-950/20 p-2 text-[11px] text-violet-200">
          Project Art Style: <strong>{activeStyle.name}</strong>. Describe who the character is here; drawing style is applied automatically.
        </p>
        <label htmlFor="character-reference" className="mb-1 block text-xs text-zinc-400">Reference image (optional)</label>
        <input
          id="character-reference"
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
            className="mb-3 flex w-full flex-col items-center rounded-md border border-dashed border-zinc-600 bg-zinc-950/60 px-4 py-5 text-center hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
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
        <div className="mb-3 rounded-md border border-zinc-700 bg-zinc-950/60 p-2.5">
          <p className="mb-2 text-xs font-medium text-zinc-300">Character generation</p>
          <label className="mb-2 flex cursor-pointer gap-2 text-xs">
            <input type="radio" checked={mode === "starter"} disabled={isBusy} onChange={() => setMode("starter")} />
            <span><strong className="text-zinc-200">Asset Pack</strong><br /><span className="text-zinc-500">1 canonical reference + 8 poses + 7 additional expressions (16 generations without an upload)</span></span>
          </label>
          <label className="flex cursor-pointer gap-2 text-xs">
            <input type="radio" checked={mode === "reference"} disabled={isBusy} onChange={() => setMode("reference")} />
            <span><strong className="text-zinc-200">Reference Only</strong><br /><span className="text-zinc-500">Create identity now and add states later</span></span>
          </label>
        </div>
        {packItems.length > 0 && (
          <div className="mb-3 max-h-44 space-y-1 overflow-y-auto rounded border border-zinc-700 p-2 text-[11px]">
            {packItems.map((item, index) => (
              <div key={`${item.label}-${index}`} className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">
                  {item.status === "done" && <DoneIcon size={12} strokeWidth={2} className="text-[var(--success)]" />}
                  {item.status === "failed" && <AlertIcon size={12} strokeWidth={2} className="text-[var(--danger)]" />}
                  {item.status === "running" && (
                    <SpinnerIcon size={12} strokeWidth={2} className="animate-spin text-[var(--accent-text)]" />
                  )}
                  {item.status !== "done" && item.status !== "failed" && item.status !== "running" && (
                    <PendingIcon size={12} strokeWidth={2} className="text-[var(--text-muted)]" />
                  )}
                </span>
                <span>{item.label}{item.error ? ` — ${item.error}` : ""}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2 text-xs">
          <button
            className="rounded px-3 py-1.5 text-zinc-400 hover:text-zinc-200"
            onClick={() => {
              if (isBusy) {
                cancelRequested.current = true;
                setError("Remaining generations cancelled. Completed assets were kept.");
              } else onClose();
            }}
          >
            {isBusy ? "Cancel remaining" : "Cancel"}
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
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-white hover:bg-[var(--accent-hover)]"
              onClick={() => {
                if (providerStatus?.configured === false) {
                  onClose();
                  useUiStore.getState().openSettings();
                } else {
                  setError("Generation is unavailable until persistent asset storage is connected by the Kumanga operator.");
                }
              }}
            >
              {providerStatus?.configured === false ? "Connect Image Model" : "Storage Required"}
            </button>
          ) : (
            <button
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-white hover:bg-[var(--accent-hover)] disabled:opacity-40"
              disabled={isBusy || providerStatus === null}
              onClick={() => create(true)}
            >
              Create {mode === "starter" ? "Asset Pack" : "Reference"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function title(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Puppet availability for one character (§9).
 *
 * The left dock reports whether a puppet EXISTS and offers the on-ramp; it does
 * not edit one. Puppet controls belong to the selected actor in the right
 * inspector, and duplicating them here is what made the old left dock a second,
 * competing editing surface.
 */
function PuppetStatusRow({ character }: { character: Character }) {
  const doc = useEditorStore((s) => s.doc)!;
  const openCompiler = useUiStore((s) => s.openCompiler);
  const advanced = useUiStore((s) => s.advancedMode);
  const puppet = character.puppetId ? doc.puppets[character.puppetId] : undefined;
  const hasCanonical = Boolean(characterReferenceId(character));

  /**
   * Rigging is an implementation detail, so the compiler is an Advanced tool.
   * A creator who never opens Advanced still gets every local puppet benefit
   * for characters that have one — they simply never have to build one.
   */
  if (!advanced) return null;

  return (
    <div className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5">
      <span className="text-[10px] text-zinc-500">
        Puppet:{" "}
        {puppet ? (
          <span className="text-fuchsia-300">
            {Object.keys(puppet.parts).length} parts · {puppet.compilerMetadata.source}
          </span>
        ) : (
          <span className="text-zinc-600">none</span>
        )}
      </span>
      <button
        className="rounded border border-fuchsia-700/70 px-2 py-0.5 text-[10px] text-fuchsia-300 hover:bg-fuchsia-950/40 disabled:opacity-40"
        disabled={!hasCanonical}
        title={hasCanonical ? undefined : "Generate a canonical reference first — the compiler cuts parts out of it."}
        onClick={() => openCompiler(character.id)}
      >
        {puppet ? "Recompile" : "Convert to Puppet"}
      </button>
    </div>
  );
}

/**
 * Rebuild every render of this character with the current transparency
 * pipeline.
 *
 * A pipeline fix only reaches images processed after it shipped — the
 * derivative already in object storage keeps whatever bytes it was written
 * with. Characters generated before edge decontamination existed therefore
 * keep their coloured fringe until they are rebuilt from their originals, and
 * without this there is no way to do that: the existing Retry only appears for
 * assets that FAILED, and a contaminated asset is "ready".
 */
function TransparencyRepairRow({ character }: { character: Character }) {
  const doc = useEditorStore((s) => s.doc)!;
  const [progress, setProgress] = useState<RepairProgress | null>(null);
  const [error, setError] = useState<string>();
  const ids = Object.values(doc.assets)
    .filter(
      (asset) =>
        asset.status !== "archived" &&
        (asset.category === "character" || asset.category === "prop") &&
        (asset.metadata?.characterId === character.id || character.assetIds.includes(asset.id)),
    )
    .map((asset) => asset.id);
  if (ids.length === 0) return null;

  const running = progress !== null && progress.done < progress.total;
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-zinc-500">
          {running
            ? `Rebuilding ${progress.done}/${progress.total}…`
            : progress
              ? `Rebuilt ${progress.total - progress.failed}/${progress.total}${progress.failed ? ` · ${progress.failed} failed` : ""}`
              : "Edges look tinted?"}
        </span>
        <button
          className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-violet-600 hover:text-violet-300 disabled:opacity-40"
          disabled={running}
          title="Re-runs background removal and edge decontamination on every render of this character. Originals are never modified."
          onClick={() => {
            setError(undefined);
            setProgress({ done: 0, total: ids.length, failed: 0 });
            void repairAssetTransparency(ids, setProgress).catch((cause) =>
              setError(cause instanceof Error ? cause.message : "Repair failed"),
            );
          }}
        >
          {running ? "Fixing…" : `Fix transparency (${ids.length})`}
        </button>
      </div>
      {error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
    </div>
  );
}

