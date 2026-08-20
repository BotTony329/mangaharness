"use client";

/**
 * The infinite workspace canvas. The manga page is ONE object inside it —
 * loose reference assets live beside it, the stage pans and zooms, and
 * everything drawn here is a projection of the editor store.
 *
 * Layers (bottom → top):
 *   page-layer      — the page sheet + polygon-clipped panels (what exports)
 *   workspace-layer — loose assets (working material; never exported)
 *   overlay-layer   — selection, ghosts, shape-edit anchors, transformer
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Layer, Line, Rect, Stage, Transformer } from "react-konva";
import type Konva from "konva";
import { pageToPanelLocal, panelBoundsPx, panelPolygonPx, workspaceToPage } from "@/domain/coords";
import { pointInPolygon } from "@/domain/geometry";
import { placeAsset, updateBubble, updateItemTransform } from "@/domain/itemOps";
import {
  addWorkspaceItem,
  instanceToWorkspaceItem,
  updateWorkspaceItem,
  workspaceItemToInstance,
} from "@/domain/workspaceOps";
import type { ID, Page, Point, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { LooseAssetNode } from "@/render/LooseAssetNode";
import { PanelGhost, PanelRenderer, type PanelInteraction } from "@/render/PanelRenderer";
import { PAGE_STAGE_ID } from "@/render/constants";
import { BubbleTextEditor } from "./BubbleTextEditor";
import { FloatingToolbar } from "./FloatingToolbar";
import { ShapeEditOverlay } from "./ShapeEditOverlay";
import { useViewport, type Viewport } from "./useViewport";

export function CanvasStage() {
  const doc = useEditorStore((s) => s.doc);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const commit = useEditorStore((s) => s.commit);
  const transient = useEditorStore((s) => s.transient);
  const commitTransient = useEditorStore((s) => s.commitTransient);
  const shapeEditPanelId = useUiStore((s) => s.shapeEditPanelId);
  const setShapeEditPanel = useUiStore((s) => s.setShapeEditPanel);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [editingBubbleId, setEditingBubbleId] = useState<ID | null>(null);
  const [hoveredPanelId, setHoveredPanelId] = useState<ID | null>(null);

  const page = doc && currentPageId ? doc.pages[currentPageId] : null;
  const pageW = doc?.project.settings.pageWidth ?? 1200;
  const pageH = doc?.project.settings.pageHeight ?? 1800;

  const { view, containerSize, spaceHeld, viewControls, panHandlers, onWheel } = useViewport({
    containerRef,
    page,
    pageW,
    pageH,
    doc,
  });

  // Dev-only: coordinate mapping for browser-automation tests.
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    (window as unknown as Record<string, unknown>).__mangaCanvas = {
      view,
      workspaceToScreen(wx: number, wy: number) {
        const bounds = containerRef.current?.getBoundingClientRect();
        return bounds
          ? { x: bounds.left + view.x + wx * view.scale, y: bounds.top + view.y + wy * view.scale }
          : null;
      },
    };
  }, [view]);

  // ── Shared geometry helpers (workspace space) ─────────────────────────────
  const panelAtWorkspacePoint = useCallback(
    (point: Point): ID | null => {
      if (!doc || !page) return null;
      const inPage = workspaceToPage(point, page);
      return (
        page.panelIds.find((id) => {
          const panel = doc.panels[id];
          return panel && pointInPolygon(inPage.x, inPage.y, panelPolygonPx(doc, panel));
        }) ?? null
      );
    },
    [doc, page],
  );

  const pointerToWorkspace = useCallback(
    (clientX: number, clientY: number): Point => {
      const bounds = containerRef.current!.getBoundingClientRect();
      return {
        x: (clientX - bounds.left - view.x) / view.scale,
        y: (clientY - bounds.top - view.y) / view.scale,
      };
    },
    [view],
  );

  // ── Selection → transformer attachment ────────────────────────────────────
  useEffect(() => {
    const transformer = transformerRef.current;
    const stage = stageRef.current;
    if (!transformer || !stage) return;
    const nodeId = selection.itemId ? `#item-${selection.itemId}` : selection.workspaceItemId ? `#loose-${selection.workspaceItemId}` : null;
    const node = nodeId && !shapeEditPanelId ? stage.findOne(nodeId) : null;
    const locked = selection.itemId && doc ? doc.items[selection.itemId]?.locked : false;
    transformer.nodes(node && !locked ? [node] : []);
  }, [selection.itemId, selection.workspaceItemId, shapeEditPanelId, doc]);

  // ── Escape leaves shape-edit mode ─────────────────────────────────────────
  useEffect(() => {
    if (!shapeEditPanelId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShapeEditPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shapeEditPanelId, setShapeEditPanel]);

  // ── Panel item interactions ───────────────────────────────────────────────
  const interaction: PanelInteraction = useMemo(
    () => ({
      selectedItemId: selection.itemId,
      onSelectPanel: (panelId) => select({ panelId }),
      onSelectItem: (itemId, panelId) => select({ itemId, panelId }),
      onPanelDoubleClick: (panelId) => {
        select({ panelId });
        setShapeEditPanel(panelId);
      },
      onItemDragMove: (itemId, cx, cy) => transient((d) => updateItemTransform(d, itemId, { cx, cy })),
      onItemDragEnd: (itemId, cx, cy) => {
        if (cx !== undefined && cy !== undefined) {
          transient((d) => updateItemTransform(d, itemId, { cx, cy }));
        }
        commitTransient();
        maybeReleaseFromPanel(itemId);
      },
      onEditBubble: (itemId) => setEditingBubbleId(itemId),
      onTailMove: (itemId, x, y) => commit((d) => updateBubble(d, itemId, { tail: { x, y } })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection.itemId, select, transient, commit, commitTransient, setShapeEditPanel],
  );

  /** Dragging an instance clearly off the page releases it to the workspace. */
  const maybeReleaseFromPanel = useCallback(
    (itemId: ID) => {
      const state = useEditorStore.getState();
      const d = state.doc;
      if (!d || !page) return;
      const item = d.items[itemId];
      if (!item || item.kind !== "asset") return;
      const bounds = panelBoundsPx(d, d.panels[item.panelId]);
      const inPageX = bounds.x + item.cx;
      const inPageY = bounds.y + item.cy;
      const margin = 40;
      const offPage = inPageX < -margin || inPageY < -margin || inPageX > pageW + margin || inPageY > pageH + margin;
      if (!offPage) return;
      state.commit((docNow) => {
        const result = instanceToWorkspaceItem(docNow, itemId);
        queueMicrotask(() => state.select({ workspaceItemId: result.itemId }));
        return result.doc;
      });
    },
    [page, pageW, pageH],
  );

  // ── Loose item interactions ───────────────────────────────────────────────
  const onLooseDragMove = useCallback(
    (itemId: ID, x: number, y: number) => {
      transient((d) => updateWorkspaceItem(d, itemId, { x, y }));
      setHoveredPanelId(panelAtWorkspacePoint({ x, y }));
    },
    [transient, panelAtWorkspacePoint],
  );

  const onLooseDragEnd = useCallback(
    (itemId: ID, x: number, y: number) => {
      transient((d) => updateWorkspaceItem(d, itemId, { x, y }));
      commitTransient();
      setHoveredPanelId(null);
      const targetPanel = panelAtWorkspacePoint({ x, y });
      if (!targetPanel) return;
      // Crossing into a panel converts the loose asset into a panel instance.
      const state = useEditorStore.getState();
      state.commit((d) => {
        const result = workspaceItemToInstance(d, itemId, targetPanel);
        queueMicrotask(() => state.select({ itemId: result.instanceId, panelId: targetPanel }));
        return result.doc;
      });
    },
    [transient, commitTransient, panelAtWorkspacePoint],
  );

  // ── Transformer end (panel items + loose items) ───────────────────────────
  const onTransformEnd = useCallback(() => {
    const stage = stageRef.current;
    const { selection: sel } = useEditorStore.getState();
    if (!stage) return;
    const isLoose = Boolean(sel.workspaceItemId);
    const node = stage.findOne(isLoose ? `#loose-${sel.workspaceItemId}` : `#item-${sel.itemId}`);
    if (!node) return;
    const width = Math.max(8, node.width() * node.scaleX());
    const height = Math.max(8, node.height() * node.scaleY());
    node.scaleX(1);
    node.scaleY(1);
    const patch = { width, height, rotation: node.rotation() };
    if (isLoose) {
      commit((d) => updateWorkspaceItem(d, sel.workspaceItemId!, { x: node.x(), y: node.y(), ...patch }));
    } else if (sel.itemId) {
      commit((d) => updateItemTransform(d, sel.itemId!, { cx: node.x(), cy: node.y(), ...patch }));
    }
  }, [commit]);

  // ── Library drag & drop: into a panel, or anywhere on the workspace ───────
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const assetId = e.dataTransfer.getData("application/x-asset-id");
      if (!assetId || !doc || !page) return;
      const workspacePoint = pointerToWorkspace(e.clientX, e.clientY);
      const panelId = panelAtWorkspacePoint(workspacePoint);

      if (!panelId) {
        commit((d) => {
          const result = addWorkspaceItem(d, assetId, workspacePoint);
          queueMicrotask(() => select({ workspaceItemId: result.itemId }));
          return result.doc;
        });
        return;
      }
      const isBackground = doc.assets[assetId]?.category === "background";
      const local = pageToPanelLocal(workspaceToPage(workspacePoint, page), panelBoundsPx(doc, doc.panels[panelId]));
      commit((d) => {
        const placed = placeAsset(d, panelId, assetId, { at: isBackground ? undefined : local });
        queueMicrotask(() => select({ itemId: placed.itemId, panelId }));
        return placed.doc;
      });
    },
    [doc, page, pointerToWorkspace, panelAtWorkspacePoint, commit, select],
  );

  if (!doc || !page) {
    return <div className="flex-1 grid place-items-center text-zinc-500">No page selected</div>;
  }

  const selectedPanel = selection.panelId ? doc.panels[selection.panelId] : null;
  const editingBubble = editingBubbleId ? doc.items[editingBubbleId] : null;
  const hoveredPanel = hoveredPanelId ? doc.panels[hoveredPanelId] : null;
  const shapeEditPanel = shapeEditPanelId ? doc.panels[shapeEditPanelId] : null;
  const looseItems = doc.workspaceOrder.map((id) => doc.workspaceItems[id]).filter(Boolean);

  return (
    <div
      ref={containerRef}
      className={`relative flex-1 overflow-hidden bg-zinc-950 ${spaceHeld ? "cursor-grab" : ""}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <Stage
        id={PAGE_STAGE_ID}
        ref={stageRef}
        width={containerSize.width}
        height={containerSize.height}
        scaleX={view.scale}
        scaleY={view.scale}
        x={view.x}
        y={view.y}
        onWheel={onWheel}
        onMouseDown={(e) => {
          if (e.target === e.target.getStage()) {
            select({});
            setShapeEditPanel(null);
          }
          panHandlers.onMouseDown(e);
        }}
        onMouseMove={panHandlers.onMouseMove}
        onMouseUp={panHandlers.onMouseUp}
      >
        <Layer name="page-layer" listening={!spaceHeld}>
          <PageSheet doc={doc} page={page} pageW={pageW} pageH={pageH} interaction={interaction} />
        </Layer>

        <Layer name="workspace-layer" listening={!spaceHeld}>
          {looseItems.map((item) => (
            <LooseAssetNode
              key={item.id}
              item={item}
              storageUrl={doc.assets[item.sourceAssetId]?.storageUrl}
              onSelect={() => select({ workspaceItemId: item.id })}
              onDragMove={(x, y) => onLooseDragMove(item.id, x, y)}
              onDragEnd={(x, y) => onLooseDragEnd(item.id, x, y)}
            />
          ))}
        </Layer>

        <Layer name="overlay-layer">
          {selectedPanel && selection.itemId && (
            <PageSpace page={page}>
              <PanelGhost doc={doc} panel={selectedPanel} itemId={selection.itemId} />
            </PageSpace>
          )}
          {selectedPanel && !shapeEditPanel && (
            <PanelOutline doc={doc} page={page} panelId={selectedPanel.id} color="#6366f1" scale={view.scale} dashed />
          )}
          {hoveredPanel && (
            <PanelOutline doc={doc} page={page} panelId={hoveredPanel.id} color="#22d3ee" scale={view.scale} />
          )}
          {shapeEditPanel && <ShapeEditOverlay doc={doc} page={page} panel={shapeEditPanel} scale={view.scale} />}
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

      {editingBubble?.kind === "bubble" && (
        <BubbleTextEditor
          bubble={editingBubble}
          panelRect={offsetRect(panelBoundsPx(doc, doc.panels[editingBubble.panelId]), page.workspace)}
          scale={view.scale}
          stagePos={{ x: view.x, y: view.y }}
          onCommit={(text) => {
            commit((d) => updateBubble(d, editingBubble.id, { text }));
            setEditingBubbleId(null);
          }}
          onCancel={() => setEditingBubbleId(null)}
        />
      )}

      <FloatingToolbar view={view} onEditBubble={(id) => setEditingBubbleId(id)} />
      <ViewControls view={view} controls={viewControls} />
    </div>
  );
}

// ─── Small presentational pieces ────────────────────────────────────────────

/** Positions children in page coordinates at the page's workspace location. */
function PageSpace({ page, children }: { page: Page; children: React.ReactNode }) {
  return (
    <Group x={page.workspace.x} y={page.workspace.y}>
      {children}
    </Group>
  );
}

function PageSheet({
  doc,
  page,
  pageW,
  pageH,
  interaction,
}: {
  doc: ProjectDocument;
  page: Page;
  pageW: number;
  pageH: number;
  interaction: PanelInteraction;
}) {
  return (
    <PageSpace page={page}>
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
    </PageSpace>
  );
}

function PanelOutline({
  doc,
  page,
  panelId,
  color,
  scale,
  dashed,
}: {
  doc: ProjectDocument;
  page: Page;
  panelId: ID;
  color: string;
  scale: number;
  dashed?: boolean;
}) {
  const panel = doc.panels[panelId];
  if (!panel) return null;
  const points = panelPolygonPx(doc, panel).flatMap((p) => [p.x, p.y]);
  return (
    <PageSpace page={page}>
      <Line
        points={points}
        closed
        stroke={color}
        strokeWidth={2 / scale}
        dash={dashed ? [8 / scale, 4 / scale] : undefined}
        listening={false}
      />
    </PageSpace>
  );
}

function ViewControls({
  view,
  controls,
}: {
  view: Viewport;
  controls: { zoomIn(): void; zoomOut(): void; fitPage(): void; fitAll(): void };
}) {
  return (
    <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900/90 p-1 text-zinc-300">
      <ZoomButton label="−" onClick={controls.zoomOut} />
      <button className="px-1.5 text-xs tabular-nums hover:text-white" onClick={controls.fitPage} title="Fit page">
        {Math.round(view.scale * 100)}%
      </button>
      <ZoomButton label="+" onClick={controls.zoomIn} />
      <div className="mx-1 h-4 w-px bg-zinc-700" />
      <button className="px-2 py-1 text-xs hover:text-white" onClick={controls.fitPage}>
        Fit page
      </button>
      <button className="px-2 py-1 text-xs hover:text-white" onClick={controls.fitAll}>
        Fit all
      </button>
    </div>
  );
}

function ZoomButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="h-7 w-7 rounded text-sm hover:bg-zinc-700" onClick={onClick}>
      {label}
    </button>
  );
}

function offsetRect(rect: { x: number; y: number; width: number; height: number }, by: Point) {
  return { ...rect, x: rect.x + by.x, y: rect.y + by.y };
}
