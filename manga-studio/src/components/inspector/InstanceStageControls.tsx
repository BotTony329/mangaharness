"use client";

/**
 * Stage controls for a placed character (§11).
 *
 * Dragging Depth updates the canvas immediately — the slider dispatches
 * transiently so the character resizes and re-grounds live, and commits one
 * undo entry on release rather than one per pixel of drag.
 */

import { DEFAULT_STAGE } from "@/domain/stage";
import { isAirborne } from "@/domain/staging";
import type { AssetInstance } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

export function InstanceStageControls({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((state) => state.doc)!;
  const dispatch = useEditorStore((state) => state.dispatch);
  const transientDispatch = useEditorStore((state) => state.transientDispatch);
  const commitTransient = useEditorStore((state) => state.commitTransient);

  const stage = item.stage;
  const panel = doc.panels[item.panelId];
  const state = item.characterState;
  const airborne = isAirborne(state?.pose, state?.poseRig?.descriptors);

  if (!stage) {
    return (
      <div className="mt-2">
        <button
          className="w-full rounded border border-zinc-700 bg-zinc-800 py-1.5 text-[11px] hover:bg-zinc-700"
          title="Place this character on the panel's ground plane"
          onClick={() => dispatch({ type: "set-instance-stage", instanceId: item.id, patch: { depth: DEFAULT_STAGE.depth } })}
        >
          Place on Stage
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-2.5">
      <p className="mb-2 text-[10px] uppercase tracking-wider text-emerald-300">Stage</p>

      <div className="mb-2">
        <div className="mb-1 flex justify-between text-[10px] text-zinc-500">
          <span>Depth</span>
          <span className="text-zinc-400">{Math.round(stage.depth * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={stage.depth}
          className="w-full accent-emerald-500"
          onChange={(event) =>
            transientDispatch({
              type: "set-instance-stage",
              instanceId: item.id,
              patch: { depth: window.Number(event.target.value), scaleLocked: false },
            })
          }
          onPointerUp={() => commitTransient()}
          onKeyUp={() => commitTransient()}
        />
        <div className="flex justify-between text-[9px] text-zinc-600">
          <span>Near</span>
          <span>Far</span>
        </div>
      </div>

      {stage.scaleLocked && (
        <p className="mb-2 text-[10px] text-amber-400">
          Size is pinned by a manual resize or camera framing. Move the depth slider to release it.
        </p>
      )}
      {airborne && (
        <p className="mb-2 text-[10px] text-sky-300">Airborne pose — depth changes size but not ground contact.</p>
      )}

      <div className="grid grid-cols-2 gap-1 text-[11px]">
        <button
          className="rounded border border-zinc-700 py-1 hover:bg-zinc-800"
          title="Re-align this character's feet to the panel ground plane"
          onClick={() =>
            dispatch({
              type: "set-instance-stage",
              instanceId: item.id,
              patch: { anchor: "feet", scaleLocked: false, groundY: undefined },
            })
          }
        >
          Snap to Ground
        </button>
        <button
          className="rounded border border-zinc-700 py-1 hover:bg-zinc-800"
          title="Return to free transform"
          onClick={() => dispatch({ type: "clear-instance-stage", instanceId: item.id })}
        >
          Leave Stage
        </button>
      </div>

      <label className="mt-2 flex items-center gap-2 text-[10px] text-zinc-400">
        <input
          type="checkbox"
          checked={panel?.focalItemId === item.id}
          onChange={(event) =>
            dispatch({
              type: "set-panel-focal-item",
              panelId: item.panelId,
              itemId: event.target.checked ? item.id : undefined,
            })
          }
        />
        Focal subject for camera framing
      </label>
    </div>
  );
}
