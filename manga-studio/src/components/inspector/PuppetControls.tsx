"use client";

/**
 * Puppet controls for the selected actor (V3.2 §4).
 *
 * This is the WHOLE editing surface for a puppet-backed instance. The legacy
 * Pose Edit / Calibrate Rig flow is deliberately absent: those exist to author
 * a request that eventually gets regenerated, and offering them beside instant
 * local controls would mix two paradigms with wildly different cost.
 *
 * Sections are FACE / POSE / HANDS & PROPS / PUPPET, and everything in them is
 * instant, local, and generation-free. Anything the puppet cannot do says so
 * and hands the request to the AI path explicitly rather than by accident.
 */

import { canApplyExpression, canApplyJoint, describeCost } from "@/puppet/capability";
import { JOINT_LIMITS, PUPPET_JOINTS, type PuppetJoint } from "@/puppet/model";
import { EXPRESSION_DRAG_TYPE } from "@/puppet/dragTypes";
import { puppetForInstance } from "@/domain/puppetOps";
import type { AssetInstance } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";

const JOINT_LABELS: Record<PuppetJoint, string> = {
  head: "Head",
  shoulderLeft: "L shoulder",
  elbowLeft: "L elbow",
  wristLeft: "L wrist",
  shoulderRight: "R shoulder",
  elbowRight: "R elbow",
  wristRight: "R wrist",
};

const ARM_JOINTS: PuppetJoint[] = PUPPET_JOINTS.filter((joint) => joint !== "head");

export function PuppetControls({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((state) => state.doc)!;
  const dispatch = useEditorStore((state) => state.dispatch);
  const transientDispatch = useEditorStore((state) => state.transientDispatch);
  const commitTransient = useEditorStore((state) => state.commitTransient);
  const showPrompt = useUiStore((state) => state.showPuppetCapabilityPrompt);

  const puppet = puppetForInstance(doc, item);
  if (!puppet || !item.puppet) return null;
  const state = item.puppet;

  const jointRow = (joint: PuppetJoint) => {
    const value = state.pose[joint] ?? 0;
    const capability = canApplyJoint(puppet, joint, value);
    const approximate = describeCost(capability) === "instant-approximate";
    return (
      <div key={joint}>
        <div className="flex justify-between text-[10px] text-zinc-500">
          <span>{JOINT_LABELS[joint]}</span>
          <span
            className={approximate ? "text-amber-400" : "text-zinc-400"}
            title={approximate ? capability.reason : undefined}
          >
            {Math.round(value)}°{approximate ? " ~" : ""}
          </span>
        </div>
        <input
          type="range"
          aria-label={JOINT_LABELS[joint]}
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
  };

  return (
    <div className="mt-2 rounded-lg border border-fuchsia-500/30 bg-fuchsia-950/20 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider text-fuchsia-300">Puppet</p>
        <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[9px] text-emerald-300">Instant</span>
      </div>

      {/* ── FACE ── */}
      <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Face</p>
      <div className="mb-1 flex flex-wrap gap-1">
        {Object.values(puppet.expressions).map((expression) => {
          const capability = canApplyExpression(puppet, expression.id);
          const active = state.expressionId === expression.id;
          return (
            <button
              key={expression.id}
              disabled={!capability.supported}
              // Draggable so the same chip works as a canvas gesture (§1):
              // drag it onto the actor's face and drop to swap locally.
              draggable={capability.supported}
              onDragStart={(event) => {
                event.dataTransfer.setData(EXPRESSION_DRAG_TYPE, expression.id);
                event.dataTransfer.effectAllowed = "copy";
              }}
              title={
                capability.supported
                  ? "Instant — swaps facial parts only. Drag onto the face on canvas."
                  : capability.reason
              }
              className={`cursor-grab rounded-full border px-2 py-0.5 text-[10px] active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40 ${
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
      <p className="mb-3 text-[9px] text-zinc-600">Drag a face onto the character on canvas, or click to apply.</p>

      {/* ── POSE ── */}
      <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Pose</p>
      <div className="mb-3 space-y-1.5">
        {jointRow("head")}
        {ARM_JOINTS.map(jointRow)}
      </div>
      <p className="mb-3 text-[9px] text-zinc-600">Or drag the joint handles directly on canvas.</p>

      {/* ── HANDS & PROPS ── */}
      {Object.values(puppet.attachments).length > 0 && (
        <>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Hands &amp; props</p>
          <div className="mb-3 flex flex-wrap gap-1">
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

      {/* ── PUPPET ── */}
      <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Puppet</p>
      <PuppetReadiness item={item} />
      <button
        className="mt-1.5 w-full rounded border border-zinc-700 py-1 text-[11px] hover:bg-zinc-800"
        onClick={() => dispatch({ type: "reset-puppet-pose", instanceId: item.id })}
      >
        Reset pose
      </button>
      <button
        className="mt-1.5 w-full rounded border border-zinc-800 py-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        onClick={() =>
          showPrompt({
            instanceId: item.id,
            reason: "You asked for artwork this puppet cannot represent.",
            fallbackRecommendation: "Generate a new render for this state, then compile it into the puppet.",
          })
        }
      >
        Need something the puppet can&apos;t do?
      </button>
    </div>
  );
}

/**
 * Honest readiness (§8).
 *
 * Naming the parts whose hidden material was never reconstructed is what keeps
 * the "instant" badge truthful: those parts are instant to move, and a large
 * movement may still expose a gap.
 */
function PuppetReadiness({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((state) => state.doc)!;
  const puppet = puppetForInstance(doc, item);
  if (!puppet) return null;
  const incomplete = Object.values(puppet.parts).filter((part) => !part.readiness.hiddenRegionComplete);
  const source = puppet.compilerMetadata.source;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/60 p-1.5 text-[10px] leading-4 text-zinc-500">
      <p>
        Source: <span className="text-zinc-400">{source}</span> · {Object.keys(puppet.parts).length} parts
      </p>
      {incomplete.length > 0 ? (
        <p className="text-amber-400/90">
          {incomplete.length} part{incomplete.length === 1 ? "" : "s"} have unreconstructed hidden regions — large
          movements are approximate.
        </p>
      ) : (
        <p className="text-emerald-400/80">Hidden regions complete.</p>
      )}
    </div>
  );
}
