"use client";

/**
 * The interactive page canvas. Everything drawn here is a projection of the
 * editor store; interactions dispatch domain mutations back through it.
 * Export reuses this same stage (same scene graph → WYSIWYG exports).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layer, Rect, Stage, Transformer } from "react-konva";
import type Konva from "konva";
import { panelRectToPx, rectContains } from "@/domain/geometry";
import { placeAsset, updateBubble, updateItemTransform } from "@/domain/itemOps";
import type { ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { PanelGhost, PanelRenderer, type PanelInteraction } from "@/render/PanelRenderer";
import { PAGE_STAGE_ID } from "@/render/constants";
import { BubbleTextEditor } from "./BubbleTextEditor";

export function CanvasStage() {
  const doc = useEditorStore((s) => s.doc);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const commit = useEditorStore((s) => s.commit);
  const transient = useEditorStore((s) => s.transient);
  const commitTransient = useEditorStore((s) => s.commitTransient);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [zoom, setZoom] = useState(1);
  const [editingBubbleId, setEditingBubbleId] = useState<ID | null>(null);

  // ── Sizing ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const page = doc && currentPageId ? doc.pages[currentPageId] : null;
  const pageW = doc?.project.settings.pageWidth ?? 1200;
  const pageH = doc?.project.settings.pageHeight ?? 1800;

  const fitScale = Math.min(containerSize.width / pageW, containerSize.height / pageH) * 0.92;
  const scale = fitScale * zoom;
  const stagePos = {
    x: (containerSize.width - pageW * scale) / 2,
    y: (containerSize.height - pageH * scale) / 2,
  };

  // ── Selection → transformer attachment ────────────────────────────────────
  useEffect(() => {
    const transformer = transformerRef.current;
    const stage = stageRef.current;
    if (!transformer || !stage) return;
    const node = selection.itemId ? stage.findOne(`#item-${selection.itemId}`) : null;
    const locked = selection.itemId && doc ? doc.items[selection.itemId]?.locked : false;
    transformer.nodes(node && !locked ? [node] : []);
  }, [selection.itemId, doc]);

  // ── Interaction callbacks shared by all panels ────────────────────────────
  const interaction: PanelInteraction = useMemo(
    () => ({
      selectedItemId: selection.itemId,
      onSelectPanel: (panelId) => select({ panelId }),
      onSelectItem: (itemId, panelId) => select({ itemId, panelId }),
      onItemDragMove: (itemId, cx, cy) => transient((d) => updateItemTransform(d, itemId, { cx, cy })),
      onItemDragEnd: (itemId, cx, cy) => {
        if (cx !== undefined && cy !== undefined) {
          transient((d) => updateItemTransform(d, itemId, { cx, cy }));
        }
        commitTransient();
      },
      onEditBubble: (itemId) => setEditingBubbleId(itemId),
      onTailMove: (itemId, x, y) => commit((d) => updateBubble(d, itemId, { tail: { x, y } })),
    }),
    [selection.itemId, select, transient, commit, commitTransient],
  );

  // ── Transform handles (resize/rotate) ─────────────────────────────────────
  const onTransformEnd = useCallback(() => {
    const stage = stageRef.current;
    const itemId = useEditorStore.getState().selection.itemId;
    if (!stage || !itemId) return;
    const node = stage.findOne(`#item-${itemId}`);
    if (!node) return;
    // Bake the transformer's scale into width/height and reset scale to 1 —
    // domain state stores rendered size, never accumulated scale factors.
    const width = Math.max(8, node.width() * node.scaleX());
    const height = Math.max(8, node.height() * node.scaleY());
    node.scaleX(1);
    node.scaleY(1);
    commit((d) =>
      updateItemTransform(d, itemId, {
        cx: node.x(),
        cy: node.y(),
        width,
        height,
        rotation: node.rotation(),
      }),
    );
  }, [commit]);

  // ── Library drag & drop ───────────────────────────────────────────────────
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const assetId = e.dataTransfer.getData("application/x-asset-id");
      if (!assetId || !doc || !page) return;
      const bounds = containerRef.current!.getBoundingClientRect();
      const pageX = (e.clientX - bounds.left - stagePos.x) / scale;
      const pageY = (e.clientY - bounds.top - stagePos.y) / scale;
      const panelId = page.panelIds.find((id) =>
        rectContains(panelRectToPx(doc.panels[id].rect, pageW, pageH), pageX, pageY),
      );
      if (!panelId) return;
      const isBackground = doc.assets[assetId]?.category === "background";
      const panelPx = panelRectToPx(doc.panels[panelId].rect, pageW, pageH);
      commit((d) => {
        const placed = placeAsset(d, panelId, assetId, {
          // Backgrounds snap to Fill; other assets land where dropped.
          at: isBackground ? undefined : { x: pageX - panelPx.x, y: pageY - panelPx.y },
        });
        // Select after placement so the transformer appears immediately.
        queueMicrotask(() => select({ itemId: placed.itemId, panelId }));
        return placed.doc;
      });
    },
    [doc, page, scale, stagePos.x, stagePos.y, pageW, pageH, commit, select],
  );

  if (!doc || !page) {
    return <div className="flex-1 grid place-items-center text-zinc-500">No page selected</div>;
  }

  const selectedPanel = selection.itemId && selection.panelId ? doc.panels[selection.panelId] : null;
  const editingBubble = editingBubbleId ? doc.items[editingBubbleId] : null;

  return (
    <div
      ref={containerRef}
      className="relative flex-1 overflow-hidden bg-zinc-950"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <Stage
        id={PAGE_STAGE_ID}
        ref={stageRef}
        width={containerSize.width}
        height={containerSize.height}
        scaleX={scale}
        scaleY={scale}
        x={stagePos.x}
        y={stagePos.y}
        onMouseDown={(e) => {
          if (e.target === e.target.getStage()) select({});
        }}
      >
        <Layer name="page-layer">
          {/* The page sheet. */}
          <Rect
            width={pageW}
            height={pageH}
            fill="#ffffff"
            shadowColor="#000000"
            shadowBlur={30}
            shadowOpacity={0.5}
            listening={false}
          />
          {page.panelIds.map((panelId) => {
            const panel = doc.panels[panelId];
            return panel ? (
              <PanelRenderer key={panelId} doc={doc} panel={panel} interactive interaction={interaction} />
            ) : null;
          })}
        </Layer>
        {/* Overlay: excluded from export by name. */}
        <Layer name="overlay-layer">
          {selectedPanel && selection.itemId && (
            <PanelGhost doc={doc} panel={selectedPanel} itemId={selection.itemId} />
          )}
          {selectedPanel && (
            <Rect
              {...panelRectToPx(selectedPanel.rect, pageW, pageH)}
              stroke="#6366f1"
              strokeWidth={2 / scale}
              dash={[8 / scale, 4 / scale]}
              listening={false}
            />
          )}
          <Transformer
            ref={transformerRef}
            rotateEnabled
            keepRatio={false}
            anchorSize={9}
            anchorCornerRadius={2}
            anchorStroke="#6366f1"
            anchorFill="#ffffff"
            borderStroke="#6366f1"
            onTransformEnd={onTransformEnd}
          />
        </Layer>
      </Stage>

      {editingBubble?.kind === "bubble" && selection.panelId && (
        <BubbleTextEditor
          bubble={editingBubble}
          panelRect={panelRectToPx(doc.panels[editingBubble.panelId].rect, pageW, pageH)}
          scale={scale}
          stagePos={stagePos}
          onCommit={(text) => {
            commit((d) => updateBubble(d, editingBubble.id, { text }));
            setEditingBubbleId(null);
          }}
          onCancel={() => setEditingBubbleId(null)}
        />
      )}

      <div className="absolute bottom-3 right-3 flex gap-1 rounded-md bg-zinc-900/90 border border-zinc-700 p-1 text-zinc-300">
        <ZoomButton label="−" onClick={() => setZoom((z) => Math.max(0.25, z / 1.2))} />
        <button
          className="px-2 text-xs tabular-nums hover:text-white"
          onClick={() => setZoom(1)}
          title="Reset zoom"
        >
          {Math.round(zoom * 100)}%
        </button>
        <ZoomButton label="+" onClick={() => setZoom((z) => Math.min(4, z * 1.2))} />
      </div>
    </div>
  );
}

function ZoomButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="w-7 h-7 rounded hover:bg-zinc-700 text-sm" onClick={onClick}>
      {label}
    </button>
  );
}
