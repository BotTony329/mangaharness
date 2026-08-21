"use client";

/**
 * PROJECTS: the top of the left dock.
 *
 * Answers question 1 of the left sidebar's job — "which project am I working
 * in?" — and nothing else. Editing controls for the selected actor live in the
 * right inspector; this surface is navigation.
 */

import { useState } from "react";
import { LAYOUT_PRESETS } from "@/domain/layouts";
import type { LayoutPresetId } from "@/domain/types";
import { useProjectsStore } from "@/editor/projectsStore";
import { BUILTIN_STYLE_PROFILES } from "@/styles/profiles";

export function ProjectsPanel() {
  const projects = useProjectsStore((s) => s.projects);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const openProject = useProjectsStore((s) => s.openProject);
  const [creating, setCreating] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setBusy(false);
      setMenuFor(null);
    }
  };

  return (
    <section className="border-b border-zinc-800 p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider text-zinc-500">Projects</p>
        <button
          className="rounded border border-indigo-600 bg-indigo-600/20 px-2 py-0.5 text-[10px] text-indigo-300 hover:bg-indigo-600/40"
          onClick={() => setCreating(true)}
          disabled={busy}
        >
          + New
        </button>
      </div>

      {error && <p className="mb-1.5 text-[10px] text-red-400">{error}</p>}

      <ul className="max-h-44 space-y-0.5 overflow-y-auto">
        {projects.length === 0 && <li className="py-2 text-center text-[10px] text-zinc-600">No projects yet.</li>}
        {projects.map((project) => {
          const active = project.id === activeProjectId;
          return (
            <li key={project.id} className="group relative">
              <button
                className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] ${
                  active ? "bg-indigo-600/25 text-indigo-100 ring-1 ring-indigo-500/60" : "text-zinc-400 hover:bg-zinc-800"
                }`}
                onClick={() => void run(() => openProject(project.id))}
                disabled={busy}
                aria-current={active ? "true" : undefined}
              >
                <span className="h-7 w-7 shrink-0 overflow-hidden rounded bg-zinc-800">
                  {project.coverUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={project.coverUrl} alt="" className="h-full w-full object-cover" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{project.name}</span>
                  <span className="block truncate text-[9px] text-zinc-500">
                    {project.pageCount} page{project.pageCount === 1 ? "" : "s"}
                    {project.updatedAt ? ` · ${relativeTime(project.updatedAt)}` : ""}
                  </span>
                </span>
              </button>
              <button
                className="absolute right-1 top-1.5 hidden rounded px-1 text-[11px] text-zinc-500 hover:text-zinc-200 group-hover:block"
                aria-label={`Project options for ${project.name}`}
                onClick={() => setMenuFor(menuFor === project.id ? null : project.id)}
              >
                ⋯
              </button>
              {menuFor === project.id && (
                <div className="absolute right-1 top-7 z-10 w-36 rounded border border-zinc-700 bg-zinc-900 py-0.5 text-[11px] shadow-xl">
                  <MenuItem
                    onClick={() => {
                      const name = window.prompt("Rename project", project.name);
                      if (name?.trim()) void run(() => useProjectsStore.getState().renameProject(project.id, name));
                      else setMenuFor(null);
                    }}
                  >
                    Rename
                  </MenuItem>
                  <MenuItem onClick={() => void run(() => useProjectsStore.getState().duplicateProject(project.id))}>
                    Duplicate
                  </MenuItem>
                  <MenuItem
                    danger
                    onClick={() => {
                      setMenuFor(null);
                      setConfirmDelete({ id: project.id, name: project.name });
                    }}
                  >
                    Delete
                  </MenuItem>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
      {confirmDelete && (
        <DeleteProjectDialog
          project={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            const id = confirmDelete.id;
            setConfirmDelete(null);
            void run(() => useProjectsStore.getState().deleteProject(id));
          }}
        />
      )}
    </section>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      className={`block w-full px-2 py-1 text-left hover:bg-zinc-800 ${danger ? "text-red-300" : "text-zinc-300"}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Minimal by design (§3): a name is enough to start drawing. */
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const createProject = useProjectsStore((s) => s.createProject);
  const [name, setName] = useState("");
  const [layout, setLayout] = useState<LayoutPresetId>("four-grid");
  const [styleId, setStyleId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await createProject({ name: name.trim() || "Untitled project", layout, styleId: styleId || undefined });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the project");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onMouseDown={onClose}>
      <div
        className="w-[380px] rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-sm shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 font-semibold text-zinc-100">New Project</h2>

        <label className="mb-1 block text-xs text-zinc-400" htmlFor="project-name">
          Project name
        </label>
        <input
          id="project-name"
          autoFocus
          className="mb-3 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5"
          placeholder="Tokyo Story"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />

        <label className="mb-1 block text-xs text-zinc-400" htmlFor="project-layout">
          Page format
        </label>
        <select
          id="project-layout"
          className="mb-3 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5"
          value={layout}
          onChange={(e) => setLayout(e.target.value as LayoutPresetId)}
        >
          {Object.values(LAYOUT_PRESETS).map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>

        <label className="mb-1 block text-xs text-zinc-400" htmlFor="project-style">
          Art style <span className="text-zinc-600">(optional)</span>
        </label>
        <select
          id="project-style"
          className="mb-4 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5"
          value={styleId}
          onChange={(e) => setStyleId(e.target.value)}
        >
          <option value="">Project default</option>
          {BUILTIN_STYLE_PROFILES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>

        {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded bg-indigo-600 px-4 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-40"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Deletion is destructive and irreversible, so it says exactly that (§6). */
function DeleteProjectDialog({
  project,
  onClose,
  onConfirm,
}: {
  project: { id: string; name: string };
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onMouseDown={onClose}>
      <div
        className="w-[400px] rounded-lg border border-red-900/70 bg-zinc-900 p-4 text-sm shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="alertdialog"
      >
        <h2 className="mb-2 font-semibold text-red-200">Delete “{project.name}”?</h2>
        <p className="mb-4 text-xs leading-5 text-zinc-400">
          This removes the project and its project-scoped document data — pages, panels, character states, puppets and
          the manga-language library. This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800" onClick={onClose}>
            Cancel
          </button>
          <button className="rounded bg-red-700 px-4 py-1.5 text-xs text-white hover:bg-red-600" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
