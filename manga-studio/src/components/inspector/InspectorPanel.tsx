"use client";

/**
 * Context-sensitive inspector: shows the controls for whatever is selected.
 * Every control dispatches the same domain commands the agent uses.
 */

import { supportsFaceFocus } from "@/domain/geometry";
import {
  duplicateItem,
  removeItem,
  reorderItem,
  setCropMode,
  updateBubble,
  updateItemProps,
  updateItemTransform,
  type ReorderDirection,
} from "@/domain/itemOps";
import type { BubbleType, CropMode, PanelItem, SourceAsset } from "@/domain/types";
import { useEditorStore, type DocMutation } from "@/editor/store";

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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-zinc-100">{children}</h3>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">{children}</p>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="p-4 text-xs leading-5 text-zinc-500">{children}</p>;
}
