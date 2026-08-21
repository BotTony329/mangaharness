"use client";

/**
 * Application shell: bootstraps the project (load last or create fresh),
 * wires autosave and keyboard shortcuts, and lays out the studio chrome.
 */

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "@/editor/store";
import { useProjectsStore } from "@/editor/projectsStore";
import { useUiStore } from "@/editor/uiStore";
import { indexedDbPersistence } from "@/storage/projectStore";
import { AiSettingsDialog } from "./dialogs/AiSettingsDialog";
import { ArtStyleDialog } from "./dialogs/ArtStyleDialog";
import { GeneratorDialog } from "./dialogs/GeneratorDialog";
import { PuppetCapabilityDialog } from "./dialogs/PuppetCapabilityDialog";
import { PuppetCompilerDialog } from "./dialogs/PuppetCompilerDialog";
import { InteractionDialog } from "./dialogs/InteractionDialog";
import { AssetDetailEditor } from "./dialogs/AssetDetailEditor";
import { AssetLibraryPanel } from "./library/AssetLibraryPanel";
import { NewProjectDialog } from "./library/ProjectsPanel";
import { PagesBar } from "./PagesBar";
import { RightPanel } from "./RightPanel";
import { TopBar } from "./TopBar";
import { KumangaMark } from "./brand/KumangaMark";

// Konva touches `window` — the canvas must never render on the server.
const CanvasStage = dynamic(() => import("./canvas/CanvasStage").then((m) => m.CanvasStage), {
  ssr: false,
  loading: () => <div className="flex-1 grid place-items-center text-zinc-500">Loading canvas…</div>,
});

const AUTOSAVE_MS = 2500;

export function Studio() {
  const doc = useEditorStore((s) => s.doc);
  const dirty = useEditorStore((s) => s.dirty);
  const projectsLoading = useProjectsStore((s) => s.loading);
  const [ready, setReady] = useState(false);

  // Dev-only: expose the stores for browser-automation tests.
  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      const w = window as unknown as Record<string, unknown>;
      w.__editorStore = useEditorStore;
      w.__uiStore = useUiStore;
    }
  }, []);

  /**
   * Bootstrap the project list and resume the last project.
   *
   * A brand-new install lands on the welcome state rather than being handed a
   * project it never asked for — but an EXISTING single-project user is
   * migrated by simply being listed: their document already carries a stable
   * project id, so it becomes the first entry with no conversion and no risk of
   * losing work (§14).
   */
  useEffect(() => {
    let cancelled = false;
    void useProjectsStore
      .getState()
      .bootstrap()
      .finally(() => {
        if (!cancelled) setReady(true);
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
        .then(() => {
          useEditorStore.getState().markSaved();
          // Keeps the project list's name and "last edited" honest without a
          // separate index that could drift from the stored documents.
          void useProjectsStore.getState().refresh();
        })
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
        store.dispatch({ type: "duplicate-instance", instanceId: itemId });
      } else if ((e.key === "Delete" || e.key === "Backspace") && store.selection.itemId) {
        e.preventDefault();
        const itemId = store.selection.itemId;
        store.dispatch({ type: "delete-instance", instanceId: itemId });
        store.select({ panelId: store.selection.panelId });
      } else if ((e.key === "Delete" || e.key === "Backspace") && store.selection.workspaceItemId) {
        e.preventDefault();
        const looseId = store.selection.workspaceItemId;
        store.dispatch({ type: "delete-workspace-instance", itemId: looseId });
        store.select({});
      } else if (e.key === "Escape") {
        store.select({});
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!ready || projectsLoading) {
    return (
      <div
        className="grid h-screen place-items-center"
        style={{ background: "var(--bg-app)", color: "var(--text-muted)" }}
      >
        <div className="flex flex-col items-center gap-3">
          <KumangaMark size={40} className="animate-pulse" decorative />
          <span className="text-xs">Opening Kumanga…</span>
        </div>
      </div>
    );
  }

  // §12: no projects means a clean welcome, never a broken empty editor.
  if (!doc) return <WelcomeState />;

  return (
    <div
      className="flex h-screen select-none flex-col overflow-hidden"
      style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
    >
      <TopBar />
      <div className="flex flex-1 min-h-0">
        <AssetLibraryPanel />
        {/* The canvas keeps its boundary: it is a real edge, not decoration. */}
        <main
          className="flex min-w-0 flex-1 flex-col border-x"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <CanvasStage />
        </main>
        <RightPanel />
      </div>
      <PagesBar />
      <GeneratorDialog />
      <AiSettingsDialog />
      <ArtStyleDialog />
      <PuppetCapabilityDialog />
      <PuppetCompilerDialog />
      <InteractionDialog />
      <AssetDetailEditor />
    </div>
  );
}

/**
 * The empty state: a clean invitation, not a broken editor (§12).
 *
 * This is the one place the full lockup earns its space — the mark, the name and
 * the tagline, once, before the creator is inside the tool. It stays a door, not
 * a landing page: no feature grid, no marketing copy.
 */
function WelcomeState() {
  const [creating, setCreating] = useState(false);
  return (
    <div
      className="grid h-screen place-items-center"
      style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
    >
      <div className="flex w-[320px] flex-col items-center text-center">
        <KumangaMark size={64} className="mb-4" decorative />
        <h1 className="text-3xl font-bold tracking-tight">Kumanga</h1>
        <p
          className="mt-1.5 text-[11px] uppercase tracking-[0.28em]"
          style={{ color: "var(--text-muted)" }}
        >
          AI Manga Studio
        </p>
        <p className="mt-6 text-sm leading-6" style={{ color: "var(--text-secondary)" }}>
          Every project keeps its own pages, characters, puppets and manga-language library.
        </p>
        <button
          className="mt-6 rounded-md bg-[var(--accent)] px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)]"
          onClick={() => setCreating(true)}
        >
          Create Project
        </button>
      </div>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
