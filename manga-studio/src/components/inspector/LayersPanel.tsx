"use client";

/**
 * The Layers panel for the selected panel.
 *
 * A PROJECTION of `panel.itemIds`, never a second tree. Every row is derived by
 * `panelLayers`, the same function the HitStack uses without a point filter, so
 * the list order is the render order by construction rather than by convention.
 * Reordering dispatches a document command; nothing here holds layer state of
 * its own that could drift from what is drawn.
 *
 * Locked rows stay fully interactive HERE — this is the surface that can unlock
 * them, so refusing to select a locked layer in this list would strand it.
 */

import { useState } from "react";
import { panelLayers } from "@/canvas/hitStack";
import type { ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

export function LayersPanel({ panelId }: { panelId: ID }) {
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const dispatch = useEditorStore((s) => s.dispatch);
  const select = useEditorStore((s) => s.select);
  const [dragging, setDragging] = useState<ID | null>(null);

  if (!doc?.panels[panelId]) return null;
  const layers = panelLayers(doc, panelId);
  const count = layers.length;

  /** Rows are top-first; `itemIds` is back-first, so the index inverts. */
  const indexForRow = (row: number) => count - 1 - row;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <p className="text-[10px] uppercase tracking-wider text-zinc-500">Layers</p>
        <span className="text-[10px] text-zinc-600">{count}</span>
      </div>

      {count === 0 ? (
        <p className="rounded border border-zinc-800 bg-zinc-950 px-2 py-3 text-center text-[11px] text-zinc-600">
          This panel is empty.
        </p>
      ) : (
        <ul className="overflow-hidden rounded border border-zinc-800">
          {layers.map((layer, row) => {
            const active = selection.itemId === layer.itemId;
            return (
              <li
                key={layer.itemId}
                draggable
                onDragStart={() => setDragging(layer.itemId)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging && dragging !== layer.itemId) {
                    dispatch({ type: "move-item-to-index", itemId: dragging, index: indexForRow(row) });
                  }
                  setDragging(null);
                }}
                onDragEnd={() => setDragging(null)}
                className={`flex items-center gap-1 border-b border-zinc-800/70 px-1.5 py-1 last:border-b-0 ${
                  active ? "bg-indigo-600/20" : "hover:bg-zinc-800/60"
                } ${dragging === layer.itemId ? "opacity-40" : ""}`}
              >
                <IconToggle
                  label={layer.hidden ? "Show layer" : "Hide layer"}
                  on={!layer.hidden}
                  onClick={() =>
                    dispatch({
                      type: "set-instance-props",
                      instanceId: layer.itemId,
                      patch: { visible: layer.hidden },
                    })
                  }
                >
                  {layer.hidden ? "🚫" : "👁"}
                </IconToggle>
                <IconToggle
                  label={layer.locked ? "Unlock layer" : "Lock layer"}
                  on={layer.locked}
                  onClick={() =>
                    dispatch({
                      type: "set-instance-props",
                      instanceId: layer.itemId,
                      patch: { locked: !layer.locked },
                    })
                  }
                >
                  {layer.locked ? "🔒" : "🔓"}
                </IconToggle>

                <button
                  className="min-w-0 flex-1 text-left"
                  // A locked layer is still selectable from here on purpose:
                  // otherwise nothing could ever unlock it.
                  onClick={() => select({ itemId: layer.itemId, panelId })}
                  onDoubleClick={() => renameLayer(layer.itemId)}
                >
                  <span className={`block truncate text-[11px] ${layer.hidden ? "text-zinc-600 line-through" : "text-zinc-200"}`}>
                    {layer.label}
                  </span>
                  <span className="block truncate text-[9px] text-zinc-500">{layer.kind}</span>
                </button>

                <div className="flex shrink-0 flex-col">
                  <MicroButton
                    label="Move layer up"
                    disabled={row === 0}
                    onClick={() => dispatch({ type: "reorder-instance", instanceId: layer.itemId, direction: "forward" })}
                  >
                    ▴
                  </MicroButton>
                  <MicroButton
                    label="Move layer down"
                    disabled={row === count - 1}
                    onClick={() => dispatch({ type: "reorder-instance", instanceId: layer.itemId, direction: "backward" })}
                  >
                    ▾
                  </MicroButton>
                </div>
                <MicroButton
                  label="Delete layer"
                  danger
                  onClick={() => {
                    dispatch({ type: "delete-instance", instanceId: layer.itemId });
                    if (active) select({ panelId });
                  }}
                >
                  ✕
                </MicroButton>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-1 text-[9px] leading-3 text-zinc-600">
        Drag to reorder. Alt-click on canvas cycles through overlapping layers.
      </p>
    </div>
  );
}

/**
 * Renaming is only meaningful where the name is the item's own data: a bubble
 * owns its text, and an asset instance borrows its source asset's name. Renaming
 * an instance therefore renames the shared asset, which is the honest behaviour
 * rather than inventing a per-instance label that nothing else would show.
 */
function renameLayer(itemId: ID): void {
  const store = useEditorStore.getState();
  const doc = store.doc;
  const item = doc?.items[itemId];
  if (!doc || !item) return;
  if (item.kind === "bubble") {
    const text = window.prompt("Bubble text", item.text);
    if (text !== null) store.dispatch({ type: "update-bubble", itemId, patch: { text } });
    return;
  }
  if (item.kind === "asset") {
    const asset = doc.assets[item.sourceAssetId];
    if (!asset) return;
    const name = window.prompt(`Rename asset (affects every panel using it)`, asset.name);
    if (name?.trim()) store.dispatch({ type: "rename-asset", assetId: asset.id, name });
  }
}

function IconToggle({
  label,
  on,
  onClick,
  children,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      aria-pressed={on}
      className="shrink-0 rounded px-0.5 text-[10px] leading-none opacity-70 hover:opacity-100"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MicroButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`shrink-0 px-1 text-[9px] leading-tight disabled:opacity-20 ${
        danger ? "text-red-400 hover:text-red-300" : "text-zinc-500 hover:text-zinc-200"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
