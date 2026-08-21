"use client";

/**
 * "Put this tone on the shirt."
 *
 * The creator brushes over what they can see, and the tone appears only there.
 * Nothing is painted into the artwork: the result is a MASK stored alongside
 * the tone's parameters, so hiding the layer brings the white shirt straight
 * back and the character asset in the library is never touched.
 *
 * The selection surface is the shared `SelectionPainter` — the same brush and
 * rectangle behaviour as local generative editing, not a second mask editor.
 */

import { useMemo, useState } from "react";
import { Group, Layer, Stage } from "react-konva";
import { panelBoundsPx } from "@/domain/coords";
import { maskIsEmpty, type ToneMask, type ToneMaskShape } from "@/domain/tones";
import { describeTone } from "@/domain/toneDescribe";
import type { ProjectDocument, ToneItem } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { PanelRenderer } from "@/render/PanelRenderer";
import { CloseIcon, ICON_STROKE } from "../ui/icons";
import { SelectionPainter, type SelectionTool } from "./SelectionPainter";

const MAX_PREVIEW = 520;

export function ToneMaskDialog() {
  const itemId = useUiStore((s) => s.toneMaskItemId);
  const close = useUiStore((s) => s.closeToneMask);
  const doc = useEditorStore((s) => s.doc);
  const item = itemId && doc ? doc.items[itemId] : undefined;
  if (!doc || !item || item.kind !== "tone") return null;
  return <MaskEditor key={item.id} doc={doc} item={item} onClose={close} />;
}

function MaskEditor({ doc, item, onClose }: { doc: ProjectDocument; item: ToneItem; onClose: () => void }) {
  const dispatch = useEditorStore((s) => s.dispatch);
  const [tool, setTool] = useState<SelectionTool>("brush");
  const [brushSize, setBrushSize] = useState(64);
  const [invert, setInvert] = useState(Boolean(item.invert));
  const [shapes, setShapes] = useState<ToneMaskShape[]>(item.mask?.shapes ?? []);

  const panel = doc.panels[item.panelId];
  const bounds = panel ? panelBoundsPx(doc, panel) : undefined;

  /**
   * A live preview built by substituting the draft mask into a COPY of the
   * document. Dispatching on every brush stroke would fill the undo history
   * with one entry per wiggle and make Cancel meaningless.
   */
  const previewDoc = useMemo<ProjectDocument>(
    () => ({
      ...doc,
      items: { ...doc.items, [item.id]: { ...item, mask: { shapes }, invert } as ToneItem },
    }),
    [doc, item, shapes, invert],
  );

  if (!panel || !bounds) return null;
  const scale = Math.min(MAX_PREVIEW / bounds.width, MAX_PREVIEW / bounds.height, 1.6);
  const viewW = bounds.width * scale;
  const viewH = bounds.height * scale;

  const apply = () => {
    dispatch({
      type: "update-tone",
      itemId: item.id,
      patch: { mask: shapes.length > 0 ? ({ shapes } satisfies ToneMask) : null, invert },
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" role="dialog" aria-modal>
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-panel)]">
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Where should “{describeTone(doc, item)}” go?
            </h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              Paint over the part you want toned. Your drawing underneath is never changed.
            </p>
          </div>
          <button className="rounded p-1 text-zinc-400 hover:text-zinc-200" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} strokeWidth={ICON_STROKE} />
          </button>
        </header>

        <div className="flex flex-1 gap-4 overflow-auto p-4">
          <div className="w-40 shrink-0 space-y-3">
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Tool</p>
              <div className="flex gap-1">
                {(["brush", "rectangle"] as SelectionTool[]).map((option) => (
                  <button
                    key={option}
                    className={`flex-1 rounded-md border px-2 py-1 text-[11px] capitalize ${
                      tool === option
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]"
                        : "border-[var(--border-subtle)] text-zinc-400 hover:border-zinc-600"
                    }`}
                    onClick={() => setTool(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>

            {tool === "brush" && (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Brush {brushSize}px</p>
                <input
                  type="range"
                  min={8}
                  max={260}
                  value={brushSize}
                  className="w-full"
                  aria-label="Brush size"
                  onChange={(event) => setBrushSize(Number(event.target.value))}
                />
              </div>
            )}

            <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
              <input type="checkbox" checked={invert} onChange={(event) => setInvert(event.target.checked)} />
              Everywhere except
            </label>

            <div className="flex gap-1">
              <button
                className="flex-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-[11px] text-zinc-400 hover:border-zinc-600 disabled:opacity-40"
                disabled={shapes.length === 0}
                onClick={() => setShapes((current) => current.slice(0, -1))}
              >
                Undo
              </button>
              <button
                className="flex-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-[11px] text-zinc-400 hover:border-zinc-600 disabled:opacity-40"
                disabled={shapes.length === 0}
                onClick={() => setShapes([])}
              >
                Clear
              </button>
            </div>

            <p className="text-[10px] leading-4 text-[var(--text-muted)]">
              {shapes.length === 0
                ? "With nothing selected, the tone covers the whole panel."
                : invert
                  ? "The tone will appear everywhere except what you painted."
                  : "The tone will appear only where you painted."}
            </p>
          </div>

          <div className="min-w-0 flex-1">
            <SelectionPainter
              className="relative mx-auto overflow-hidden rounded border border-[var(--border-subtle)] bg-white"
              style={{ width: viewW, height: viewH }}
              contentWidth={bounds.width}
              contentHeight={bounds.height}
              tool={tool}
              brushSize={brushSize}
              onShape={(shape) => setShapes((current) => [...current, shape])}
            >
              {/* The real renderer, so the preview IS the result. */}
              <Stage width={viewW} height={viewH} scaleX={scale} scaleY={scale} listening={false}>
                <Layer listening={false}>
                  <PanelRendererAtOrigin doc={previewDoc} panelId={panel.id} />
                </Layer>
              </Stage>
            </SelectionPainter>
            {maskIsEmpty({ shapes }) && (
              <p className="mt-2 text-center text-[11px] text-[var(--text-muted)]">
                Nothing painted yet — drag across the artwork above.
              </p>
            )}
          </div>
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--border-subtle)] px-4 py-3">
          <button className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded-md px-3 py-1.5 text-xs font-medium"
            style={{ background: "var(--accent)", color: "var(--accent-on)" }}
            onClick={apply}
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * One panel, drawn at the origin.
 *
 * `PanelRenderer` positions itself on the page; here only this panel exists, so
 * the page offset is cancelled out to fill the preview box.
 */
function PanelRendererAtOrigin({ doc, panelId }: { doc: ProjectDocument; panelId: string }) {
  const panel = doc.panels[panelId];
  const bounds = panelBoundsPx(doc, panel);
  return (
    <Group x={-bounds.x} y={-bounds.y}>
      <PanelRenderer doc={doc} panel={panel} interactive={false} />
    </Group>
  );
}
