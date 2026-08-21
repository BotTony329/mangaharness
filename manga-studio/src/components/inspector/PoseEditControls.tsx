"use client";

/**
 * Pose Edit Mode controls (§11).
 *
 * Nothing here generates while dragging. The draft rig lives in UI state and
 * only Apply consults the resolver — which then reuses an exact cached render
 * if the same pose has been made before, and generates only when it has not
 * (§5). Cancel discards the draft entirely; the document was never touched.
 */

import { useState } from "react";
import {
  BUILTIN_POSES,
  createPoseRigState,
  describePoseRig,
  isPoseEdited,
  resetPoseRig,
} from "@/characters/poseRig";
import { stateFromInstance } from "@/characters/state";
import { applyCharacterStateToInstance } from "@/characters/stateRuntime";
import { resolveInstancePatch } from "@/characters/stateResolver";
import type { AssetInstance } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";

export function PoseEditControls({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((state) => state.doc)!;
  const poseEditInstanceId = useUiStore((state) => state.poseEditInstanceId);
  const poseDraft = useUiStore((state) => state.poseDraft);
  const beginPoseEdit = useUiStore((state) => state.beginPoseEdit);
  const setPoseDraft = useUiStore((state) => state.setPoseDraft);
  const endPoseEdit = useUiStore((state) => state.endPoseEdit);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  const state = stateFromInstance(doc, item);
  if (!state) return null;
  const editing = poseEditInstanceId === item.id && poseDraft !== null;

  if (!editing) {
    return (
      <div className="mt-2">
        <button
          className="w-full rounded border border-zinc-700 bg-zinc-800 py-1.5 text-[11px] hover:bg-zinc-700"
          onClick={() => beginPoseEdit(item.id, state.poseRig ?? createPoseRigState(state.pose))}
        >
          Edit Pose
        </button>
        {isPoseEdited(state.poseRig) && (
          <p className="mt-1 text-[10px] text-indigo-300">{describePoseRig(state.poseRig, state.pose)}</p>
        )}
      </div>
    );
  }

  const draft = poseDraft!;
  // What Apply would cost, computed from the resolver rather than guessed.
  const preview = resolveInstancePatch(doc, item.id, { poseRig: draft });
  const cached = preview?.resolution.status === "cached";

  const apply = async () => {
    setBusy(true);
    setError(undefined);
    setStatus(cached ? "Reusing existing render…" : "Generating pose…");
    try {
      const result = await applyCharacterStateToInstance({ instanceId: item.id, patch: { poseRig: draft } });
      setStatus(result.source === "cache" ? "Reused an existing render." : `Generated from ${result.reference?.label ?? "reference"}.`);
      endPoseEdit();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not apply the pose");
      setStatus(undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-cyan-500/40 bg-cyan-950/20 p-2.5">
      <p className="mb-2 text-[10px] uppercase tracking-wider text-cyan-300">Pose edit</p>

      <label className="mb-1 block text-[10px] text-zinc-400">Base pose</label>
      <select
        aria-label="Base pose"
        disabled={busy}
        className="mb-2 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[11px]"
        value={draft.basePose}
        onChange={(event) => setPoseDraft(createPoseRigState(event.target.value))}
      >
        {BUILTIN_POSES.map((pose) => (
          <option key={pose.id} value={pose.id}>
            {pose.label}
          </option>
        ))}
        {!BUILTIN_POSES.some((pose) => pose.id === draft.basePose) && (
          <option value={draft.basePose}>{draft.basePose}</option>
        )}
      </select>

      <p className="mb-1 text-[10px] text-zinc-400">Pose description</p>
      <p className="mb-2 rounded bg-zinc-950 p-2 text-[11px] leading-4 text-zinc-300">
        {describePoseRig(draft, state.pose)}
      </p>

      <p className="mb-2 text-[10px] text-zinc-500">
        Drag the joints on the canvas. {cached ? "This pose already exists — Apply will reuse it." : "Apply will generate this pose."}
      </p>

      {status && <p className="mb-1 text-[10px] text-cyan-300">{status}</p>}
      {error && <p className="mb-1 text-[10px] text-red-300">{error}</p>}

      <div className="grid grid-cols-3 gap-1 text-[11px]">
        <button
          disabled={busy}
          className="rounded border border-zinc-700 py-1 hover:bg-zinc-800 disabled:opacity-50"
          onClick={() => setPoseDraft(resetPoseRig(draft))}
        >
          Reset
        </button>
        <button
          disabled={busy}
          className="rounded border border-zinc-700 py-1 hover:bg-zinc-800 disabled:opacity-50"
          onClick={() => endPoseEdit()}
        >
          Cancel
        </button>
        <button
          disabled={busy || !isPoseEdited(draft)}
          className="rounded bg-cyan-600 py-1 text-white hover:bg-cyan-500 disabled:opacity-40"
          onClick={() => void apply()}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
