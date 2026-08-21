"use client";

/**
 * Puppet controls for the selected actor (§15).
 *
 * Everything here is instant and local — no provider call, no new asset. The
 * cost hint is shown honestly (§18): an action is either immediate, immediate
 * but approximate, or genuinely needs AI, and the UI says which.
 */

import { canApplyExpression, canApplyJoint, describeCost } from "@/puppet/capability";
import { JOINT_LIMITS, PUPPET_JOINTS, type PuppetJoint } from "@/puppet/model";
import { puppetForInstance } from "@/domain/puppetOps";
import type { AssetInstance } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

const JOINT_LABELS: Record<PuppetJoint, string> = {
  head: "Head",
  shoulderLeft: "L shoulder",
  elbowLeft: "L elbow",
  wristLeft: "L wrist",
  shoulderRight: "R shoulder",
  elbowRight: "R elbow",
  wristRight: "R wrist",
};

export function PuppetControls({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((state) => state.doc)!;
  const dispatch = useEditorStore((state) => state.dispatch);
  const transientDispatch = useEditorStore((state) => state.transientDispatch);
  const commitTransient = useEditorStore((state) => state.commitTransient);

  const puppet = puppetForInstance(doc, item);
  if (!puppet || !item.puppet) return null;
  const state = item.puppet;

  return (
    <div className="mt-2 rounded-lg border border-fuchsia-500/30 bg-fuchsia-950/20 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider text-fuchsia-300">Puppet</p>
        <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[9px] text-emerald-300">Instant</span>
      </div>

      <p className="mb-1 text-[10px] text-zinc-400">Face</p>
      <div className="mb-3 flex flex-wrap gap-1">
        {Object.values(puppet.expressions).map((expression) => {
          const capability = canApplyExpression(puppet, expression.id);
          const active = state.expressionId === expression.id;
          return (
            <button
              key={expression.id}
              disabled={!capability.supported}
              title={capability.supported ? "Instant — swaps facial parts only" : capability.reason}
              className={`rounded-full border px-2 py-0.5 text-[10px] disabled:opacity-40 ${
                active
                  ? "border-fuchsia-500 bg-fuchsia-600/30 text-fuchsia-200"
                  : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-fuchsia-600"
              }`}
              onClick={() =>
                dispatch({ type: "set-puppet-expression", instanceId: item.id, expressionId: expression.id })
              }
            >
              {expression.name}
            </button>
          );
        })}
      </div>

      <p className="mb-1 text-[10px] text-zinc-400">Pose</p>
      <div className="space-y-1.5">
        {PUPPET_JOINTS.map((joint) => {
          const value = state.pose[joint] ?? 0;
          const capability = canApplyJoint(puppet, joint, value);
          const approximate = describeCost(capability) === "instant-approximate";
          return (
            <div key={joint}>
              <div className="flex justify-between text-[10px] text-zinc-500">
                <span>{JOINT_LABELS[joint]}</span>
                <span className={approximate ? "text-amber-400" : "text-zinc-400"}>{Math.round(value)}°</span>
              </div>
              <input
                type="range"
                min={JOINT_LIMITS[joint].min}
                max={JOINT_LIMITS[joint].max}
                step={1}
                value={value}
                className="w-full accent-fuchsia-500"
                onChange={(event) =>
                  transientDispatch({
                    type: "set-puppet-joint",
                    instanceId: item.id,
                    joint,
                    degrees: window.Number(event.target.value),
                  })
                }
                onPointerUp={() => commitTransient()}
                onKeyUp={() => commitTransient()}
              />
            </div>
          );
        })}
      </div>

      {Object.values(puppet.attachments).length > 0 && (
        <>
          <p className="mb-1 mt-3 text-[10px] text-zinc-400">Props</p>
          <div className="flex flex-wrap gap-1">
            {Object.values(puppet.attachments).map((attachment) => {
              const attached = (state.attachments ?? []).includes(attachment.id);
              return (
                <button
                  key={attachment.id}
                  className={`rounded-full border px-2 py-0.5 text-[10px] ${
                    attached
                      ? "border-fuchsia-500 bg-fuchsia-600/30 text-fuchsia-200"
                      : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-fuchsia-600"
                  }`}
                  onClick={() =>
                    dispatch({
                      type: "set-puppet-attachment",
                      instanceId: item.id,
                      attachmentId: attachment.id,
                      attached: !attached,
                    })
                  }
                >
                  {attachment.label}
                </button>
              );
            })}
          </div>
        </>
      )}

      <button
        className="mt-3 w-full rounded border border-zinc-700 py-1 text-[11px] hover:bg-zinc-800"
        onClick={() => dispatch({ type: "reset-puppet-pose", instanceId: item.id })}
      >
        Reset pose
      </button>
    </div>
  );
}
