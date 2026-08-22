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
import { pagePanelTree, panelLayers } from "@/canvas/hitStack";
import type { ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import {
  DeleteIcon,
  DownIcon,
  HiddenIcon,
  ICON_SIZE_SM,
  ICON_STROKE,
  LockedIcon,
  UnlockedIcon,
  UpIcon,
  VisibleIcon,
} from "../ui/icons";

export function LayersPanel({ panelId }: { panelId: ID }) {
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const dispatch = useEditorStore((s) => s.dispatch);
  const select = useEditorStore((s) => s.select);
  /** Co-selected actors, so a pair reads as a pair in the list. */
  const alsoSelected = new Set(selection.alsoItemIds ?? []);
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
                /* Selection is the accent, not a border: the list reads as rows,
                   not as a grid of boxes. */
                className={`flex items-center gap-0.5 rounded px-1 py-1 ${
                  active || alsoSelected.has(layer.itemId)
                    ? "bg-[var(--accent-soft)]"
                    : "hover:bg-[var(--bg-hover)]"
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
                  {layer.hidden ? (
                    <HiddenIcon size={ICON_SIZE_SM} strokeWidth={ICON_STROKE} />
                  ) : (
                    <VisibleIcon size={ICON_SIZE_SM} strokeWidth={ICON_STROKE} />
                  )}
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
                  {layer.locked ? (
                    <LockedIcon size={ICON_SIZE_SM} strokeWidth={ICON_STROKE} />
                  ) : (
                    <UnlockedIcon size={ICON_SIZE_SM} strokeWidth={ICON_STROKE} />
                  )}
                </IconToggle>

                <button
                  className="min-w-0 flex-1 text-left"
                  // A locked layer is still selectable from here on purpose:
                  // otherwise nothing could ever unlock it.
                  title="Click to select · Shift-click to add a second actor"
                  onClick={(event) => {
                    /**
                     * Shift-click adds a second actor.
                     *
                     * The canvas gesture depends on hit testing two overlapping
                     * characters apart; this list never has that problem, so it
                     * is the reliable way to reach a two-character interaction.
                     */
                    if (event.shiftKey) {
                      const current = useEditorStore.getState().selection;
                      if (current.itemId && current.itemId !== layer.itemId) {
                        const also = new Set(current.alsoItemIds ?? []);
                        if (also.has(layer.itemId)) also.delete(layer.itemId);
                        else also.add(layer.itemId);
                        select({ itemId: current.itemId, panelId, alsoItemIds: [...also] });
                        return;
                      }
                    }
                    select({ itemId: layer.itemId, panelId });
                  }}
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
                    <UpIcon size={12} strokeWidth={2} />
                  </MicroButton>
                  <MicroButton
                    label="Move layer down"
                    disabled={row === count - 1}
                    onClick={() => dispatch({ type: "reorder-instance", instanceId: layer.itemId, direction: "backward" })}
                  >
                    <DownIcon size={12} strokeWidth={2} />
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
                  <DeleteIcon size={ICON_SIZE_SM} strokeWidth={ICON_STROKE} />
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
 * The page-level object navigator: Page → Panel → Objects.
 *
 * Panels covered by their own content are unreachable on the canvas — the
 * hit-test lands on the background/character/bubble on top. This tree is the
 * always-reliable way to select the PANEL itself (Camera / Stage / panel
 * settings) without touching the canvas.
 *
 * Selection goes through the SAME `select()` the canvas uses — one source of
 * truth, so canvas highlight, inspector routing and this tree can never
 * disagree. Hierarchy is derived from the document (`pagePanelTree`); nothing
 * here persists or duplicates structure.
 */
export function PageLayersTree() {
  const doc = useEditorStore((s) => s.doc);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  /** Collapsed panels are view state, not document state. */
  const [collapsed, setCollapsed] = useState<Set<ID>>(new Set());

  if (!doc || !currentPageId) return null;
  const tree = pagePanelTree(doc, currentPageId);
  if (tree.length === 0) return null;

  const toggle = (panelId: ID) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(panelId)) next.delete(panelId);
      else next.add(panelId);
      return next;
    });

  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Page</p>
      <ul className="overflow-hidden rounded border border-zinc-800">
        {tree.map((node) => {
          const panelSelected = selection.panelId === node.panelId && !selection.itemId;
          const isCollapsed = collapsed.has(node.panelId);
          return (
            <li key={node.panelId}>
              <div
                className={`flex items-center gap-1 px-1 py-1 ${
                  panelSelected ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--bg-hover)]"
                }`}
              >
                <button
                  aria-label={isCollapsed ? `Expand panel ${node.panelNumber}` : `Collapse panel ${node.panelNumber}`}
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[9px] text-zinc-500 hover:text-zinc-200"
                  onClick={() => toggle(node.panelId)}
                >
                  {isCollapsed ? "▸" : "▾"}
                </button>
                <button
                  className="min-w-0 flex-1 text-left"
                  title="Select this panel (Camera / Stage controls)"
                  onClick={() => select({ panelId: node.panelId })}
                >
                  <span className={`block truncate text-[11px] ${panelSelected ? "text-zinc-100" : "text-zinc-300"}`}>
                    Panel {node.panelNumber}
                  </span>
                </button>
              </div>
              {!isCollapsed && node.children.length > 0 && (
                <ul>
                  {node.children.map((layer) => {
                    const active = selection.itemId === layer.itemId;
                    return (
                      <li key={layer.itemId}>
                        <button
                          className={`block w-full py-0.5 pl-8 pr-1 text-left ${
                            active ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--bg-hover)]"
                          }`}
                          onClick={() => select({ itemId: layer.itemId, panelId: node.panelId })}
                        >
                          <span className={`block truncate text-[11px] ${layer.hidden ? "text-zinc-600 line-through" : "text-zinc-200"}`}>
                            {layer.label}
                          </span>
                          <span className="block truncate text-[9px] text-zinc-500">{layer.kind}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
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
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors ${
        on ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)]"
      } hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]`}
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
      className={`inline-flex h-5 w-6 shrink-0 items-center justify-center rounded transition-colors disabled:opacity-20 ${
        danger
          ? "text-[var(--text-muted)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
          : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
