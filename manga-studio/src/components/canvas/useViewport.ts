"use client";

/**
 * Workspace navigation: pan (drag empty space, space+drag, wheel) and zoom
 * (ctrl/cmd+wheel at the pointer, buttons, fit page / fit all). Zoom never
 * modifies the selection — it only changes the stage transform.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type Konva from "konva";
import type { Page, ProjectDocument } from "@/domain/types";

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 4;

interface UseViewportInput {
  containerRef: React.RefObject<HTMLDivElement | null>;
  page: Page | null;
  pageW: number;
  pageH: number;
  doc: ProjectDocument | null;
}

export function useViewport({ containerRef, page, pageW, pageH, doc }: UseViewportInput) {
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, scale: 0.4 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panning = useRef<{ startX: number; startY: number; viewX: number; viewY: number } | null>(null);
  const didInitialFit = useRef(false);

  // ── Container measurement ─────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef]);

  // ── Space-to-pan ──────────────────────────────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.code === "Space" && target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ── Fit helpers ───────────────────────────────────────────────────────────
  const fitBounds = useCallback(
    (x: number, y: number, width: number, height: number) => {
      const scale = clampScale(Math.min(containerSize.width / width, containerSize.height / height) * 0.92);
      setView({
        scale,
        x: (containerSize.width - width * scale) / 2 - x * scale,
        y: (containerSize.height - height * scale) / 2 - y * scale,
      });
    },
    [containerSize],
  );

  const fitPage = useCallback(() => {
    if (page) fitBounds(page.workspace.x, page.workspace.y, pageW, pageH);
  }, [page, pageW, pageH, fitBounds]);

  const fitAll = useCallback(() => {
    if (!doc || !page) return;
    let minX = page.workspace.x;
    let minY = page.workspace.y;
    let maxX = page.workspace.x + pageW;
    let maxY = page.workspace.y + pageH;
    for (const item of Object.values(doc.workspaceItems)) {
      minX = Math.min(minX, item.x - item.width / 2);
      minY = Math.min(minY, item.y - item.height / 2);
      maxX = Math.max(maxX, item.x + item.width / 2);
      maxY = Math.max(maxY, item.y + item.height / 2);
    }
    fitBounds(minX, minY, maxX - minX, maxY - minY);
  }, [doc, page, pageW, pageH, fitBounds]);

  // Fit the page once when the canvas first has real dimensions.
  useEffect(() => {
    if (!didInitialFit.current && page && containerSize.width > 100) {
      didInitialFit.current = true;
      fitPage();
    }
  }, [page, containerSize, fitPage]);

  // ── Zoom (buttons + wheel) ────────────────────────────────────────────────
  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setView((v) => {
      const scale = clampScale(v.scale * factor);
      const px = clientX - bounds.left;
      const py = clientY - bounds.top;
      // Keep the workspace point under the cursor stationary while zooming.
      const wx = (px - v.x) / v.scale;
      const wy = (py - v.y) / v.scale;
      return { scale, x: px - wx * scale, y: py - wy * scale };
    });
  }, [containerRef]);

  const zoomCentered = useCallback(
    (factor: number) => {
      const bounds = containerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      zoomAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, factor);
    },
    [containerRef, zoomAt],
  );

  const onWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      if (e.evt.ctrlKey || e.evt.metaKey) {
        zoomAt(e.evt.clientX, e.evt.clientY, e.evt.deltaY > 0 ? 0.92 : 1.08);
      } else {
        setView((v) => ({ ...v, x: v.x - e.evt.deltaX, y: v.y - e.evt.deltaY }));
      }
    },
    [zoomAt],
  );

  // ── Drag-to-pan (empty stage or space held) ───────────────────────────────
  const panHandlers = {
    onMouseDown: (e: Konva.KonvaEventObject<MouseEvent>) => {
      const onEmptySpace = e.target === e.target.getStage();
      if (!onEmptySpace && !spaceHeld) return;
      panning.current = { startX: e.evt.clientX, startY: e.evt.clientY, viewX: view.x, viewY: view.y };
    },
    onMouseMove: (e: Konva.KonvaEventObject<MouseEvent>) => {
      const pan = panning.current;
      if (!pan) return;
      setView((v) => ({
        ...v,
        x: pan.viewX + (e.evt.clientX - pan.startX),
        y: pan.viewY + (e.evt.clientY - pan.startY),
      }));
    },
    onMouseUp: () => {
      panning.current = null;
    },
  };

  return {
    view,
    containerSize,
    spaceHeld,
    onWheel,
    panHandlers,
    viewControls: {
      zoomIn: () => zoomCentered(1.2),
      zoomOut: () => zoomCentered(1 / 1.2),
      fitPage,
      fitAll,
    },
  };
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}
