"use client";

/**
 * Application shell: bootstraps the project (load last or create fresh),
 * wires autosave and keyboard shortcuts, and lays out the studio chrome.
 */

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { createProjectDocument } from "@/domain/factory";
import { duplicateItem, removeItem } from "@/domain/itemOps";
import { useEditorStore } from "@/editor/store";
import { indexedDbPersistence } from "@/storage/projectStore";
import { GeneratorDialog } from "./dialogs/GeneratorDialog";
import { AssetLibraryPanel } from "./library/AssetLibraryPanel";
import { PagesBar } from "./PagesBar";
import { RightPanel } from "./RightPanel";
import { TopBar } from "./TopBar";

// Konva touches `window` — the canvas must never render on the server.
const CanvasStage = dynamic(() => import("./canvas/CanvasStage").then((m) => m.CanvasStage), {
  ssr: false,
  loading: () => <div className="flex-1 grid place-items-center text-zinc-500">Loading canvas…</div>,
});

const AUTOSAVE_MS = 2500;

export function Studio() {
  const doc = useEditorStore((s) => s.doc);
  const dirty = useEditorStore((s) => s.dirty);
  const [ready, setReady] = useState(false);

  // Dev-only: expose the store for browser-automation tests.
  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      (window as unknown as Record<string, unknown>).__editorStore = useEditorStore;
    }
  }, []);

  // ── Bootstrap: resume the last project or start a fresh one ───────────────
  useEffect(() => {
    let cancelled = false;
    indexedDbPersistence
      .loadLastProject()
      .catch(() => null)
      .then((loaded) => {
        if (cancelled) return;
        useEditorStore.getState().loadDocument(loaded ?? createProjectDocument("My Manga"));
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Autosave (debounced on change) ────────────────────────────────────────
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!doc || !dirty) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      indexedDbPersistence
        .saveProject(doc)
        .then(() => useEditorStore.getState().markSaved())
        .catch((error) => console.error("Autosave failed", error));
    }, AUTOSAVE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [doc, dirty]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      const store = useEditorStore.getState();
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if ((mod && e.key === "z" && e.shiftKey) || (mod && e.key === "y")) {
        e.preventDefault();
        store.redo();
      } else if (mod && e.key === "d" && store.selection.itemId) {
        e.preventDefault();
        const itemId = store.selection.itemId;
        store.commit((d) => duplicateItem(d, itemId).doc);
      } else if ((e.key === "Delete" || e.key === "Backspace") && store.selection.itemId) {
        e.preventDefault();
        const itemId = store.selection.itemId;
        store.commit((d) => removeItem(d, itemId));
        store.select({ panelId: store.selection.panelId });
      } else if (e.key === "Escape") {
        store.select({});
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!ready) {
    return <div className="h-screen grid place-items-center bg-zinc-950 text-zinc-400">Opening studio…</div>;
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-200 overflow-hidden select-none">
      <TopBar />
      <div className="flex flex-1 min-h-0">
        <AssetLibraryPanel />
        <main className="flex flex-1 min-w-0 flex-col border-x border-zinc-800">
          <CanvasStage />
        </main>
        <RightPanel />
      </div>
      <PagesBar />
      <GeneratorDialog />
    </div>
  );
}
