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
import type { AssetInstance, ID, Page, Point, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { SOCKET_DRAG_TYPE, decodeSocketDrag, resolveSocketAt } from "@/characters/sockets";
import { LANGUAGE_DRAG_TYPE } from "@/language/library";
import { acceptableSockets, patchForSocketDrop, propsAfterDrop } from "@/characters/stateResolver";
import { applyCharacterStateToInstance } from "@/characters/stateRuntime";
import { useUiStore } from "@/editor/uiStore";
import { LooseAssetNode } from "@/render/LooseAssetNode";
import { assetRenderUrl } from "@/assets/renderSource";
import { PanelGhost, PanelRenderer, type PanelInteraction } from "@/render/PanelRenderer";
import { PAGE_STAGE_ID } from "@/render/constants";
import { BubbleTextEditor } from "./BubbleTextEditor";
import { FloatingToolbar } from "./FloatingToolbar";
import { ShapeEditOverlay } from "./ShapeEditOverlay";
import { PerspectiveOverlay } from "./PerspectiveOverlay";
import { usesStagePlacement } from "@/domain/stageOps";
import { PoseEditOverlay } from "./PoseEditOverlay";
import { PuppetOverlay } from "./PuppetOverlay";
import { puppetForInstance } from "@/domain/puppetOps";
import { canApplyExpression } from "@/puppet/capability";
import { EXPRESSION_DRAG_TYPE } from "@/puppet/dragTypes";
import { faceDropTarget, isOverFace, toPuppetUnits } from "@/puppet/interaction";
import { cycleHit, hitStack, type HitStackEntry } from "@/canvas/hitStack";
import { sampleAssetAlpha } from "@/render/alphaMask";
import { LayerContextMenu } from "./LayerContextMenu";
import { useViewport, type Viewport } from "./useViewport";

/** How far the pointer may move and still count as "the same spot" for cycling. */
const CYCLE_RADIUS_PX = 4;
/** Clicking the same spot again within this window walks down the stack. */
const CYCLE_WINDOW_MS = 1200;

export function CanvasStage() {
  const doc = useEditorStore((s) => s.doc);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const transientDispatch = useEditorStore((s) => s.transientDispatch);
  const commitTransient = useEditorStore((s) => s.commitTransient);
  const shapeEditPanelId = useUiStore((s) => s.shapeEditPanelId);
  const poseEditInstanceId = useUiStore((s) => s.poseEditInstanceId);
  const poseDraft = useUiStore((s) => s.poseDraft);
  const calibrating = useUiStore((s) => s.calibrating);
  const calibrationDraft = useUiStore((s) => s.calibrationDraft);
  const guideEditPanelId = useUiStore((s) => s.guideEditPanelId);
  const setShapeEditPanel = useUiStore((s) => s.setShapeEditPanel);
  const puppetFaceHover = useUiStore((s) => s.puppetFaceHover);
  const setPuppetFaceHover = useUiStore((s) => s.setPuppetFaceHover);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [editingBubbleId, setEditingBubbleId] = useState<ID | null>(null);
  const [hoveredPanelId, setHoveredPanelId] = useState<ID | null>(null);
  /** Last click, so repeating it in place cycles down the HitStack. */
  const lastClick = useRef<{ x: number; y: number; panelId: ID; at: number } | null>(null);
  const [layerMenu, setLayerMenu] = useState<{ x: number; y: number; panelId: ID; entries: HitStackEntry[] } | null>(null);

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
    const node = nodeId && !shapeEditPanelId && !poseEditInstanceId ? stage.findOne(nodeId) : null;
    // A locked or hidden layer stays selectable from the Layers panel so it can
    // be unlocked or shown again — but it must never get transform handles.
    const target = selection.itemId && doc ? doc.items[selection.itemId] : undefined;
    const manipulable = !target || (target.locked !== true && target.visible !== false);
    transformer.nodes(node && manipulable ? [node] : []);
  }, [selection.itemId, selection.workspaceItemId, shapeEditPanelId, poseEditInstanceId, doc]);

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
      // Selection is resolved at the stage, through the HitStack — nodes no
      // longer pick for themselves, so there is exactly one definition of what
      // is under the pointer.
      onPanelDoubleClick: (panelId) => {
        select({ panelId });
        setShapeEditPanel(panelId);
      },
      // A staged character dragged on a snapping panel walks the floor: its
      // vertical position becomes depth, so it shrinks and re-grounds live.
      onItemDragMove: (itemId, cx, cy) => {
        const current = useEditorStore.getState().doc;
        if (current && usesStagePlacement(current, itemId)) {
          transientDispatch({ type: "place-on-stage", instanceId: itemId, at: { x: cx, y: cy } });
          return;
        }
        transientDispatch({ type: "update-instance-transform", instanceId: itemId, patch: { cx, cy } });
      },
      onItemDragEnd: (itemId, cx, cy) => {
        if (cx !== undefined && cy !== undefined) {
          const current = useEditorStore.getState().doc;
          if (current && usesStagePlacement(current, itemId)) {
            transientDispatch({ type: "place-on-stage", instanceId: itemId, at: { x: cx, y: cy } });
          } else {
            transientDispatch({ type: "update-instance-transform", instanceId: itemId, patch: { cx, cy } });
          }
        }
        commitTransient();
        maybeReleaseFromPanel(itemId);
      },
      onEditBubble: (itemId) => setEditingBubbleId(itemId),
      onTailMove: (itemId, x, y) => useEditorStore.getState().dispatch({ type: "update-bubble", itemId, patch: { tail: { x, y } } }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection.itemId, select, transientDispatch, commitTransient, setShapeEditPanel],
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
      const result = state.dispatch({ type: "panel-to-workspace", instanceId: itemId });
      if (result.createdId) state.select({ workspaceItemId: result.createdId });
    },
    [page, pageW, pageH],
  );

  // ── Loose item interactions ───────────────────────────────────────────────
  const onLooseDragMove = useCallback(
    (itemId: ID, x: number, y: number) => {
      transientDispatch({ type: "update-workspace-instance", itemId, patch: { x, y } });
      setHoveredPanelId(panelAtWorkspacePoint({ x, y }));
    },
    [transientDispatch, panelAtWorkspacePoint],
  );

  const onLooseDragEnd = useCallback(
    (itemId: ID, x: number, y: number) => {
      transientDispatch({ type: "update-workspace-instance", itemId, patch: { x, y } });
      commitTransient();
      setHoveredPanelId(null);
      const targetPanel = panelAtWorkspacePoint({ x, y });
      if (!targetPanel) return;
      // Crossing into a panel converts the loose asset into a panel instance.
      const state = useEditorStore.getState();
      const result = state.dispatch({ type: "workspace-to-panel", itemId, panelId: targetPanel });
      if (result.createdId) state.select({ itemId: result.createdId, panelId: targetPanel });
    },
    [transientDispatch, commitTransient, panelAtWorkspacePoint],
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
      useEditorStore.getState().dispatch({ type: "update-workspace-instance", itemId: sel.workspaceItemId!, patch: { x: node.x(), y: node.y(), ...patch } });
    } else if (sel.itemId) {
      useEditorStore.getState().dispatch({ type: "update-instance-transform", instanceId: sel.itemId!, patch: { cx: node.x(), cy: node.y(), ...patch } });
    }
  }, []);

  /**
   * Semantic socket drop (§5/§6): dropping an expression card on a character's
   * face changes that character's expression. Nothing is overlaid — the state
   * resolver decides how the new state is rendered.
   */
  const onSocketDrop = useCallback(
    (raw: string, clientX: number, clientY: number): boolean => {
      const payload = decodeSocketDrag(raw);
      const current = useEditorStore.getState().doc;
      if (!payload || !current || !page) return false;
      const workspacePoint = pointerToWorkspace(clientX, clientY);
      const panelId = panelAtWorkspacePoint(workspacePoint);
      if (!panelId) return false;
      const local = pageToPanelLocal(workspaceToPage(workspacePoint, page), panelBoundsPx(current, current.panels[panelId]));
      const allowed = acceptableSockets(payload);

      // Topmost instance first: later items in the stack render above earlier ones.
      const panel = current.panels[panelId];
      for (let index = panel.itemIds.length - 1; index >= 0; index -= 1) {
        const item = current.items[panel.itemIds[index]];
        if (item?.kind !== "asset") continue;
        const asset = current.assets[item.sourceAssetId];
        const characterId = item.characterState?.characterId ?? asset?.metadata?.characterId;
        if (!characterId) continue;
        if (payload.characterId && payload.characterId !== characterId) continue;

        const socket = resolveSocketAt(item, local, asset?.focusRegions, allowed);
        if (!socket) continue;
        // Props accumulate on the character rather than replacing a value, so
        // they need the current held set rather than a single-value patch.
        const patch =
          payload.dimension === "props"
            ? { props: propsAfterDrop(item.characterState?.props, payload.value) }
            : patchForSocketDrop(socket, payload);
        if (!patch) continue;

        select({ itemId: item.id, panelId });
        void applyCharacterStateToInstance({ instanceId: item.id, patch }).catch(() => {
          // Generation failures surface in the inspector, which owns that status.
        });
        return true;
      }
      return false;
    },
    [page, pointerToWorkspace, panelAtWorkspacePoint, select],
  );

  /**
   * Screen pointer → panel-local point, and which panel it landed in.
   *
   * Camera roll rotates scene content about the panel centre while the frame
   * stays square, so the roll has to be undone here — otherwise every hit test
   * in a Dutch-angle panel would be off by the tilt.
   */
  const pointerToPanel = useCallback(
    (clientX: number, clientY: number): { panelId: ID; point: Point } | null => {
      if (!doc || !page) return null;
      const workspacePoint = pointerToWorkspace(clientX, clientY);
      const panelId = panelAtWorkspacePoint(workspacePoint);
      if (!panelId) return null;
      const bounds = panelBoundsPx(doc, doc.panels[panelId]);
      const local = pageToPanelLocal(workspaceToPage(workspacePoint, page), bounds);
      const roll = doc.panels[panelId].camera?.roll ?? 0;
      if (!roll) return { panelId, point: local };
      const cx = bounds.width / 2;
      const cy = bounds.height / 2;
      const radians = (-roll * Math.PI) / 180;
      const dx = local.x - cx;
      const dy = local.y - cy;
      return {
        panelId,
        point: {
          x: cx + dx * Math.cos(radians) - dy * Math.sin(radians),
          y: cy + dx * Math.sin(radians) + dy * Math.cos(radians),
        },
      };
    },
    [doc, page, pointerToWorkspace, panelAtWorkspacePoint],
  );

  /**
   * The unified selection entry point (§ Photoshop-style layer selection).
   *
   * Every canvas click resolves through the same HitStack the right-click menu
   * and the Layers panel use. A plain click takes the visually topmost eligible
   * item; Alt-click, or clicking again without moving, walks down the stack, so
   * an overlapped layer is reachable without pixel-perfect aim.
   */
  const selectAtPointer = useCallback(
    (clientX: number, clientY: number, cycle: boolean): boolean => {
      const target = pointerToPanel(clientX, clientY);
      if (!target || !doc) return false;
      const stack = hitStack(doc, target.panelId, target.point, { alpha: sampleAssetAlpha });
      if (stack.length === 0) {
        // Empty panel space selects the panel itself, as before.
        select({ panelId: target.panelId });
        lastClick.current = null;
        return true;
      }

      const previous = lastClick.current;
      const samePosition =
        previous !== null &&
        previous.panelId === target.panelId &&
        Math.hypot(previous.x - clientX, previous.y - clientY) <= CYCLE_RADIUS_PX;
      const shouldCycle = cycle || (samePosition && Date.now() - (previous?.at ?? 0) < CYCLE_WINDOW_MS);

      const chosen = shouldCycle
        ? cycleHit(stack, useEditorStore.getState().selection.itemId)
        : stack[0];
      if (!chosen) return false;
      lastClick.current = { x: clientX, y: clientY, panelId: target.panelId, at: Date.now() };
      select({ itemId: chosen.itemId, panelId: target.panelId });
      return true;
    },
    [doc, pointerToPanel, select],
  );

  /**
   * Resolve a pointer position to the puppet actor whose FACE is under it.
   *
   * Uses the puppet's real head geometry under its current pose, not a
   * percentage band, so a tilted head moves its own drop target.
   */
  const puppetFaceAt = useCallback(
    (clientX: number, clientY: number): AssetInstance | null => {
      if (!doc || !page) return null;
      const workspacePoint = pointerToWorkspace(clientX, clientY);
      const panelId = panelAtWorkspacePoint(workspacePoint);
      if (!panelId) return null;
      const local = pageToPanelLocal(workspaceToPage(workspacePoint, page), panelBoundsPx(doc, doc.panels[panelId]));
      for (const itemId of [...(doc.panels[panelId]?.itemIds ?? [])].reverse()) {
        const item = doc.items[itemId];
        if (item?.kind !== "asset" || !item.puppet) continue;
        const puppet = puppetForInstance(doc, item);
        if (!puppet) continue;
        if (isOverFace(faceDropTarget(puppet, item.puppet.pose), toPuppetUnits(item, local))) return item;
      }
      return null;
    },
    [doc, page, pointerToWorkspace, panelAtWorkspacePoint],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      // Only expression drags produce face feedback; an asset drag must not
      // light up a face it cannot be dropped onto.
      if (!e.dataTransfer.types.includes(EXPRESSION_DRAG_TYPE)) return;
      const host = puppetFaceAt(e.clientX, e.clientY);
      const current = useUiStore.getState().puppetFaceHover;
      if (host?.id === current?.instanceId) return;
      setPuppetFaceHover(host ? { instanceId: host.id, expressionId: "" } : null);
    },
    [puppetFaceAt, setPuppetFaceHover],
  );

  // ── Library drag & drop: into a panel, or anywhere on the workspace ───────
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const socketPayload = e.dataTransfer.getData(SOCKET_DRAG_TYPE);
      if (socketPayload && onSocketDrop(socketPayload, e.clientX, e.clientY)) return;
      /**
       * Expression drop (§1): a LOCAL face swap.
       *
       * This writes one string onto the instance. It replaces no asset, makes
       * no provider request, and creates no CharacterState render — the whole
       * point of the puppet representation.
       */
      const expressionId = e.dataTransfer.getData(EXPRESSION_DRAG_TYPE);
      if (expressionId) {
        setPuppetFaceHover(null);
        const host = puppetFaceAt(e.clientX, e.clientY);
        if (!host) return;
        const puppet = doc ? puppetForInstance(doc, host) : undefined;
        const capability = puppet ? canApplyExpression(puppet, expressionId) : undefined;
        if (!capability?.supported) {
          useUiStore.getState().showPuppetCapabilityPrompt({
            instanceId: host.id,
            reason: capability?.reason ?? "This puppet cannot show that face.",
            fallbackRecommendation: capability?.fallbackRecommendation,
          });
          return;
        }
        useEditorStore.getState().dispatch({ type: "set-puppet-expression", instanceId: host.id, expressionId });
        select({ itemId: host.id, panelId: host.panelId });
        return;
      }

      const languageAssetId = e.dataTransfer.getData(LANGUAGE_DRAG_TYPE);
      const assetId = e.dataTransfer.getData("application/x-asset-id");
      if ((!assetId && !languageAssetId) || !doc || !page) return;
      const workspacePoint = pointerToWorkspace(e.clientX, e.clientY);
      const panelId = panelAtWorkspacePoint(workspacePoint);

      /**
       * Manga language drops are contextual (§10): dropped on a character the
       * effect attaches to them and travels with them; dropped on empty panel
       * space it stays in panel space. The drop point decides, so "put the
       * sweat drop on Yuri's head" is a gesture rather than a settings dialog.
       */
      if (languageAssetId) {
        if (!panelId) return;
        const at = pageToPanelLocal(workspaceToPage(workspacePoint, page), panelBoundsPx(doc, doc.panels[panelId]));
        const host = characterItemAt(doc, panelId, at);
        const placed = useEditorStore.getState().dispatch({
          type: "place-language-asset",
          panelId,
          languageAssetId,
          at,
          attachToItemId: host?.id,
        });
        if (placed.createdId) select({ itemId: placed.createdId, panelId });
        return;
      }

      if (!panelId) {
        const result = useEditorStore.getState().dispatch({ type: "add-workspace-instance", assetId, at: workspacePoint });
        if (result.createdId) select({ workspaceItemId: result.createdId });
        return;
      }
      const isBackground = doc.assets[assetId]?.category === "background";
      const local = pageToPanelLocal(workspaceToPage(workspacePoint, page), panelBoundsPx(doc, doc.panels[panelId]));
      const placed = useEditorStore.getState().dispatch({ type: "add-instance", panelId, assetId, at: isBackground ? undefined : local });
      if (placed.createdId) select({ itemId: placed.createdId, panelId });
    },
    [doc, page, pointerToWorkspace, panelAtWorkspacePoint, select, onSocketDrop, puppetFaceAt, setPuppetFaceHover],
  );

  if (!doc || !page) {
    return <div className="flex-1 grid place-items-center text-zinc-500">No page selected</div>;
  }

  const selectedPanel = selection.panelId ? doc.panels[selection.panelId] : null;
  const editingBubble = editingBubbleId ? doc.items[editingBubbleId] : null;
  const hoveredPanel = hoveredPanelId ? doc.panels[hoveredPanelId] : null;
  const shapeEditPanel = shapeEditPanelId ? doc.panels[shapeEditPanelId] : null;
  const poseEditCandidate = poseEditInstanceId ? doc.items[poseEditInstanceId] : null;
  const poseEditInstance = poseEditCandidate?.kind === "asset" ? poseEditCandidate : null;
  // Calibration is stored on the rendered state, so the overlay reads it from
  // the graph node backing this instance's current asset.
  const poseCalibration = poseEditInstance
    ? Object.values(doc.characterStates).find((record) => record.assetId === poseEditInstance.sourceAssetId)
        ?.poseCalibration
    : undefined;
  const looseItems = doc.workspaceOrder.map((id) => doc.workspaceItems[id]).filter(Boolean);
  // Only the selected actor gets handles, but any actor can be a drop target,
  // so every puppet on the page needs an overlay.
  const puppetInstances = page.panelIds
    .flatMap((panelId) => doc.panels[panelId]?.itemIds ?? [])
    .map((itemId) => doc.items[itemId])
    .filter((item): item is AssetInstance => item?.kind === "asset" && Boolean(item.puppet));

  return (
    <div
      ref={containerRef}
      className={`relative flex-1 overflow-hidden bg-zinc-950 ${spaceHeld ? "cursor-grab" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={() => setPuppetFaceHover(null)}
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
          const native = e.evt as MouseEvent;
          setLayerMenu(null);
          if (!spaceHeld && native.button === 0) {
            const handled = selectAtPointer(native.clientX, native.clientY, native.altKey);
            if (!handled) {
              select({});
              setShapeEditPanel(null);
              lastClick.current = null;
            }
          }
          panHandlers.onMouseDown(e);
        }}
        onContextMenu={(e) => {
          e.evt.preventDefault();
          const native = e.evt as MouseEvent;
          const target = pointerToPanel(native.clientX, native.clientY);
          if (!target || !doc) return setLayerMenu(null);
          // Locked layers ARE listed here: the menu is a way back to something
          // the canvas deliberately refuses to select.
          const entries = hitStack(doc, target.panelId, target.point, {
            alpha: sampleAssetAlpha,
            includeLocked: true,
          });
          setLayerMenu({ x: native.clientX, y: native.clientY, panelId: target.panelId, entries });
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
              storageUrl={assetRenderUrl(doc.assets[item.sourceAssetId])}
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
          {page.panelIds.map((panelId) => {
            const panel = doc.panels[panelId];
            return panel ? (
              <PerspectiveOverlay
                key={`perspective-${panelId}`}
                doc={doc}
                page={page}
                panel={panel}
                scale={view.scale}
                editable={guideEditPanelId === panelId}
              />
            ) : null;
          })}
          {shapeEditPanel && <ShapeEditOverlay doc={doc} page={page} panel={shapeEditPanel} scale={view.scale} />}
          {/* Puppet direct manipulation: handles for the selected actor, and a
              face highlight for whichever actor a drag is currently over. */}
          {puppetInstances.map((instance) => (
            <PuppetOverlay
              key={`puppet-overlay-${instance.id}`}
              doc={doc}
              page={page}
              instance={instance}
              scale={view.scale}
              faceHovered={puppetFaceHover?.instanceId === instance.id}
              showHandles={selection.itemId === instance.id}
            />
          ))}
          {poseEditInstance && (poseDraft || calibrating) && (
            <PoseEditOverlay
              doc={doc}
              page={page}
              instance={poseEditInstance}
              intent={poseDraft}
              calibration={calibrating ? (calibrationDraft ?? undefined) : poseCalibration}
              calibrating={calibrating}
              scale={view.scale}
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

      {editingBubble?.kind === "bubble" && (
        <BubbleTextEditor
          bubble={editingBubble}
          panelRect={offsetRect(panelBoundsPx(doc, doc.panels[editingBubble.panelId]), page.workspace)}
          scale={view.scale}
          stagePos={{ x: view.x, y: view.y }}
          onCommit={(text) => {
            useEditorStore.getState().dispatch({ type: "update-bubble", itemId: editingBubble.id, patch: { text } });
            setEditingBubbleId(null);
          }}
          onCancel={() => setEditingBubbleId(null)}
        />
      )}

      {layerMenu && (
        <LayerContextMenu
          x={layerMenu.x}
          y={layerMenu.y}
          entries={layerMenu.entries}
          selectedItemId={selection.itemId}
          onPick={(itemId: ID) => {
            select({ itemId, panelId: layerMenu.panelId });
            setLayerMenu(null);
          }}
          onClose={() => setLayerMenu(null)}
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

/** The topmost character/asset instance under a panel-local point, if any. */
function characterItemAt(doc: ProjectDocument, panelId: string, at: { x: number; y: number }) {
  const panel = doc.panels[panelId];
  if (!panel) return undefined;
  for (let i = panel.itemIds.length - 1; i >= 0; i -= 1) {
    const item = doc.items[panel.itemIds[i]];
    if (item?.kind !== "asset") continue;
    if (doc.assets[item.sourceAssetId]?.category === "background") continue;
    if (
      Math.abs(at.x - item.cx) <= item.width / 2 &&
      Math.abs(at.y - item.cy) <= item.height / 2
    ) {
      return item;
    }
  }
  return undefined;
}
