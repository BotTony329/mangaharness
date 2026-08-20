"use client";

/**
 * Context-sensitive inspector: shows the controls for whatever is selected.
 * Every control dispatches the same domain commands the agent uses.
 */

import { supportsFaceFocus } from "@/domain/geometry";
import {
  availableCharacterStateValues,
  stateFromInstance,
  type CharacterStatePatch,
} from "@/characters/state";
import { applyCharacterStateToInstance } from "@/characters/stateRuntime";
import {
  duplicateItem,
  removeItem,
  reorderItem,
  setCropMode,
  swapInstanceAsset,
  updateBubble,
  updateItemProps,
  updateItemTransform,
  type ReorderDirection,
} from "@/domain/itemOps";
import type { AssetInstance, BubbleType, CharacterState, CropMode, PanelItem, SourceAsset } from "@/domain/types";
import { useEditorStore, type DocMutation } from "@/editor/store";
import { useState } from "react";

const CROP_MODES: { mode: CropMode; label: string }[] = [
  { mode: "fit", label: "Fit" },
  { mode: "fill", label: "Fill" },
  { mode: "upper-body", label: "Upper Body" },
  { mode: "face", label: "Face" },
];

export function InspectorPanel() {
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  if (!doc) return null;

  const item = selection.itemId ? doc.items[selection.itemId] : null;
  if (item) return <ItemInspector item={item} asset={item.kind === "asset" ? doc.assets[item.sourceAssetId] : undefined} />;

  if (selection.panelId && doc.panels[selection.panelId]) {
    return (
      <Hint>
        Panel selected. Drag assets from the library into it, or use + Bubble / + Effect in the toolbar.
      </Hint>
    );
  }
  return (
    <Hint>
      Select a panel or an object on the canvas.
      <br />
      <br />
      Drag any library asset into a panel — the panel is a viewport: only what&apos;s inside its frame renders, and every
      placement is an independent, non-destructive instance.
    </Hint>
  );
}

function ItemInspector({ item, asset }: { item: PanelItem; asset?: SourceAsset }) {
  const commit = (mutation: DocMutation) => useEditorStore.getState().commit(mutation);
  const id = item.id;

  return (
    <div className="space-y-4 p-3 text-xs">
      <SectionTitle>
        {item.kind === "asset" ? (asset?.name ?? "Asset") : item.kind === "bubble" ? "Speech bubble" : "Effect"}
      </SectionTitle>

      {item.kind === "asset" && asset && (
        <>
          {asset.metadata?.characterId && <CharacterStateControls item={item} />}
        <div>
          <Label>Framing</Label>
          <div className="grid grid-cols-2 gap-1">
            {CROP_MODES.map(({ mode, label }) => {
              const faceUnavailable = mode === "face" && !supportsFaceFocus(asset);
              return (
                <button
                  key={mode}
                  disabled={faceUnavailable}
                  title={faceUnavailable ? "Needs face region metadata on this asset" : undefined}
                  className={`rounded border px-2 py-1.5 ${
                    item.cropMode === mode
                      ? "border-indigo-500 bg-indigo-600/30 text-indigo-200"
                      : "border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30"
                  }`}
                  onClick={() => commit((d) => setCropMode(d, id, mode))}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {item.cropMode === "custom" && <p className="mt-1 text-[10px] text-zinc-500">Custom framing (manually adjusted)</p>}
        </div>
        </>
      )}

      {item.kind === "bubble" && (
        <>
          <div>
            <Label>Text</Label>
            <textarea
              className="h-20 w-full resize-none rounded border border-zinc-700 bg-zinc-800 p-2"
              value={item.text}
              onChange={(e) => commit((d) => updateBubble(d, id, { text: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Type</Label>
              <select
                className="w-full rounded border border-zinc-700 bg-zinc-800 px-1 py-1.5"
                value={item.bubbleType}
                onChange={(e) => commit((d) => updateBubble(d, id, { bubbleType: e.target.value as BubbleType }))}
              >
                <option value="speech">Speech</option>
                <option value="thought">Thought</option>
                <option value="shout">Shout</option>
                <option value="narration">Narration</option>
              </select>
            </div>
            <div>
              <Label>Font size</Label>
              <input
                type="number"
                min={8}
                max={96}
                className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5"
                value={item.fontSize}
                onChange={(e) => commit((d) => updateBubble(d, id, { fontSize: Number(e.target.value) || 22 }))}
              />
            </div>
          </div>
        </>
      )}

      <div>
        <Label>Opacity {Math.round(item.opacity * 100)}%</Label>
        <input
          type="range"
          min={0.05}
          max={1}
          step={0.05}
          value={item.opacity}
          className="w-full accent-indigo-500"
          onChange={(e) => commit((d) => updateItemProps(d, id, { opacity: Number(e.target.value) }))}
        />
      </div>

      {item.kind === "asset" && asset && (
        <div>
          <Label>Scale</Label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={5}
              max={200}
              step={1}
              value={Math.max(5, Math.min(200, Math.round((item.height / Math.max(asset.height, 1)) * 100)))}
              className="min-w-0 flex-1 accent-indigo-500"
              onChange={(event) => {
                const scale = Number(event.target.value) / 100;
                commit((doc) => updateItemTransform(doc, id, {
                  width: asset.width * scale,
                  height: asset.height * scale,
                }));
              }}
            />
            <span className="w-10 text-right text-[10px] text-zinc-500">
              {Math.round((item.height / Math.max(asset.height, 1)) * 100)}%
            </span>
          </div>
        </div>
      )}

      <div>
        <Label>Rotation</Label>
        <input
          type="number"
          className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5"
          value={Math.round(item.rotation)}
          onChange={(e) => commit((d) => updateItemTransform(d, id, { rotation: Number(e.target.value) || 0 }))}
        />
      </div>

      {item.kind === "asset" && (
        <button
          className="w-full rounded border border-zinc-700 bg-zinc-800 py-1.5 hover:bg-zinc-700"
          onClick={() => commit((d) => updateItemProps(d, id, { flipX: !item.flipX }))}
        >
          Flip horizontally {item.flipX ? "(flipped)" : ""}
        </button>
      )}

      <div>
        <Label>Layer order</Label>
        <div className="grid grid-cols-4 gap-1">
          {(
            [
              ["back", "⤓"],
              ["backward", "↓"],
              ["forward", "↑"],
              ["front", "⤒"],
            ] as [ReorderDirection, string][]
          ).map(([direction, glyph]) => (
            <button
              key={direction}
              title={`Send ${direction}`}
              className="rounded border border-zinc-700 bg-zinc-800 py-1.5 hover:bg-zinc-700"
              onClick={() => commit((d) => reorderItem(d, id, direction))}
            >
              {glyph}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          className="flex-1 rounded border border-zinc-700 bg-zinc-800 py-1.5 hover:bg-zinc-700"
          onClick={() => commit((d) => duplicateItem(d, id).doc)}
        >
          Duplicate
        </button>
        <button
          className="flex-1 rounded border border-red-900 bg-red-950/60 py-1.5 text-red-300 hover:bg-red-900/60"
          onClick={() => {
            useEditorStore.getState().select({ panelId: item.panelId });
            commit((d) => removeItem(d, id));
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function CharacterStateControls({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((state) => state.doc);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [review, setReview] = useState<{
    previousAssetId: string;
    previousState: CharacterState;
    generatedState: CharacterState;
  }>();
  if (!doc) return null;
  const current = stateFromInstance(doc, item);
  const character = current ? doc.characters[current.characterId] : undefined;
  if (!current || !character) return null;

  const change = async (patch: CharacterStatePatch, forceRegenerate = false) => {
    setBusy(true);
    setError(undefined);
    setStatus("Checking character library…");
    try {
      const result = await applyCharacterStateToInstance({
        instanceId: item.id,
        patch,
        forceRegenerate,
        onProgress: ({ stage, state }) => {
          if (stage === "generating") setStatus(`Generating ${title(state.expression)} + ${title(state.pose)}…`);
          if (stage === "saving") setStatus("Saving reusable character state…");
          if (stage === "complete") setStatus(undefined);
        },
      });
      if (result.source === "generated") {
        setReview({
          previousAssetId: result.previousAssetId,
          previousState: result.previousState,
          generatedState: result.state,
        });
      } else {
        setReview(undefined);
      }
    } catch (caught) {
      setStatus(undefined);
      setError(caught instanceof Error ? caught.message : "Character generation failed");
    } finally {
      setBusy(false);
    }
  };

  const controls: { key: keyof CharacterStatePatch; label: string }[] = [
    { key: "pose", label: "Pose" },
    { key: "expression", label: "Expression" },
    { key: "outfit", label: "Outfit" },
    { key: "view", label: "View" },
  ];

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-indigo-950/20 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <Label>Character state</Label>
        <span className="text-[10px] text-indigo-300">{character.name}</span>
      </div>
      <div className="space-y-2">
        {controls.map(({ key, label }) => (
          <div key={key}>
            <label className="mb-1 block text-[10px] text-zinc-400">{label}</label>
            <select
              aria-label={label}
              disabled={busy}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 disabled:opacity-50"
              value={current[key]}
              onChange={(event) => void change({ [key]: event.target.value })}
            >
              {availableCharacterStateValues(doc, character, key).map((value) => (
                <option key={value} value={value}>{title(value)}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      {status && <p className="mt-2 text-[10px] text-indigo-300">{status}</p>}
      {error && <p className="mt-2 text-[10px] text-red-300">{error}</p>}
      {review && (
        <div className="mt-2 border-t border-zinc-700 pt-2">
          <p className="mb-1.5 text-[10px] text-zinc-400">Review generated variation</p>
          <div className="grid grid-cols-3 gap-1">
            <button className="rounded bg-indigo-600 py-1 hover:bg-indigo-500" onClick={() => setReview(undefined)}>
              Keep
            </button>
            <button
              disabled={busy}
              className="rounded border border-zinc-700 py-1 hover:bg-zinc-800 disabled:opacity-50"
              onClick={() => void change(review.generatedState, true)}
            >
              Regenerate
            </button>
            <button
              disabled={busy}
              className="rounded border border-zinc-700 py-1 hover:bg-zinc-800 disabled:opacity-50"
              onClick={() => {
                useEditorStore.getState().commit((next) => swapInstanceAsset(next, item.id, review.previousAssetId));
                setReview(undefined);
              }}
            >
              Previous
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function title(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-zinc-100">{children}</h3>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">{children}</p>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="p-4 text-xs leading-5 text-zinc-500">{children}</p>;
}
