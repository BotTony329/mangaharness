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
import { findRenderedStateRecord } from "@/characters/stateGraph";
import { applyCharacterStateToInstance } from "@/characters/stateRuntime";
import { resolveInstancePatch } from "@/characters/stateResolver";
import type { AssetInstance } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";

export function PoseEditControls({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((state) => state.doc)!;
  const dispatch = useEditorStore((state) => state.dispatch);
  const poseEditInstanceId = useUiStore((state) => state.poseEditInstanceId);
  const poseDraft = useUiStore((state) => state.poseDraft);
  const beginPoseEdit = useUiStore((state) => state.beginPoseEdit);
  const setPoseDraft = useUiStore((state) => state.setPoseDraft);
  const endPoseEdit = useUiStore((state) => state.endPoseEdit);
  const calibrating = useUiStore((state) => state.calibrating);
  const calibrationDraft = useUiStore((state) => state.calibrationDraft);
  const beginCalibration = useUiStore((state) => state.beginCalibration);
  const setCalibrationDraft = useUiStore((state) => state.setCalibrationDraft);
  const endCalibration = useUiStore((state) => state.endCalibration);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  const state = stateFromInstance(doc, item);
  if (!state) return null;
  // Calibration belongs to the rendered state, so it is read from the graph
  // node backing this instance's current asset.
  const record = findRenderedStateRecord(doc, state);
  const savedCalibration = record?.poseCalibration;
  const editing = poseEditInstanceId === item.id && poseDraft !== null;
  const isCalibrating = poseEditInstanceId === item.id && calibrating;

  if (isCalibrating) {
    const draft = calibrationDraft ?? savedCalibration ?? { anchors: {}, updatedAt: new Date().toISOString() };
    const anchorCount = Object.keys(draft.anchors).length;
    return (
      <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-950/20 p-2.5">
        <p className="mb-2 text-[10px] uppercase tracking-wider text-amber-300">Calibrate rig</p>
        <p className="mb-2 text-[10px] leading-4 text-zinc-400">
          Drag the anchors so the skeleton lines up with this drawing. This only changes where the editor shows the
          rig — the character is not regenerated.
        </p>
        <p className="mb-2 text-[10px] text-zinc-500">{anchorCount} anchor{anchorCount === 1 ? "" : "s"} adjusted</p>
        <div className="grid grid-cols-3 gap-1 text-[11px]">
          <button
            className="rounded border border-zinc-700 py-1 hover:bg-zinc-800"
            onClick={() => setCalibrationDraft({ anchors: {}, updatedAt: new Date().toISOString() })}
          >
            Reset
          </button>
          <button className="rounded border border-zinc-700 py-1 hover:bg-zinc-800" onClick={() => endCalibration()}>
            Cancel
          </button>
          <button
            disabled={!record}
            title={record ? undefined : "This render has no state record yet"}
            className="rounded bg-amber-600 py-1 text-white hover:bg-amber-500 disabled:opacity-40"
            onClick={() => {
              if (record) {
                dispatch({
                  type: "set-state-calibration",
                  stateId: record.id,
                  calibration: anchorCount > 0 ? draft : undefined,
                });
              }
              endCalibration();
            }}
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  if (!editing) {
    return (
      <div className="mt-2 grid grid-cols-2 gap-1">
        <button
          className="rounded border border-zinc-700 bg-zinc-800 py-1.5 text-[11px] hover:bg-zinc-700"
          onClick={() => beginPoseEdit(item.id, state.poseRig ?? createPoseRigState(state.pose))}
        >
          Edit Pose
        </button>
        <button
          className="rounded border border-zinc-700 bg-zinc-800 py-1.5 text-[11px] hover:bg-zinc-700"
          title="Fit the skeleton to this drawing"
          onClick={() =>
            beginCalibration(item.id, savedCalibration ?? { anchors: {}, updatedAt: new Date().toISOString() })
          }
        >
          Calibrate Rig
        </button>
        {isPoseEdited(state.poseRig) && (
          <p className="col-span-2 mt-1 text-[10px] text-indigo-300">{describePoseRig(state.poseRig, state.pose)}</p>
        )}
        {savedCalibration && (
          <p className="col-span-2 text-[10px] text-amber-400/80">Rig calibrated for this render.</p>
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
