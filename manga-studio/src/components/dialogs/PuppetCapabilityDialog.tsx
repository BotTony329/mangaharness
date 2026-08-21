"use client";

/**
 * The capability boundary, made visible (V3.2 §3).
 *
 * A puppet that cannot hold a pose must not quietly distort itself, and it must
 * not quietly escalate to a paid generation either. When the boundary is hit,
 * the creator gets the reason and three explicit choices — and the difference
 * between "instant and local" and "this costs a generation" stays obvious.
 */

import { puppetForInstance } from "@/domain/puppetOps";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { stateFromInstance } from "@/characters/state";

export function PuppetCapabilityDialog() {
  const prompt = useUiStore((s) => s.puppetCapabilityPrompt);
  const dismiss = useUiStore((s) => s.showPuppetCapabilityPrompt);
  const openGenerator = useUiStore((s) => s.openGenerator);
  const openCompiler = useUiStore((s) => s.openCompiler);
  const doc = useEditorStore((s) => s.doc);

  if (!prompt || !doc) return null;
  const instance = doc.items[prompt.instanceId];
  if (instance?.kind !== "asset") return null;
  const puppet = puppetForInstance(doc, instance);
  const state = stateFromInstance(doc, instance);
  const characterId = state?.characterId ?? puppet?.characterId;

  const close = () => dismiss(null);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60" onMouseDown={close}>
      <div
        className="w-[420px] rounded-lg border border-amber-800/70 bg-zinc-900 p-4 text-sm shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-label="Puppet capability"
      >
        <h2 className="mb-1 font-semibold text-amber-200">Pose exceeds this puppet&apos;s local range.</h2>
        <p className="mb-2 text-xs leading-5 text-zinc-400">{prompt.reason}</p>
        {prompt.fallbackRecommendation && (
          <p className="mb-3 rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px] leading-4 text-zinc-500">
            {prompt.fallbackRecommendation}
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <button
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            onClick={close}
          >
            Cancel — keep the puppet as it is
          </button>
          <button
            className="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-40"
            disabled={!characterId}
            onClick={() => {
              close();
              // Explicitly generative: a new render for this character state.
              if (characterId) {
                openGenerator({
                  assetType: "character-pose",
                  characterId,
                  targetInstanceId: instance.id,
                  prefill: { pose: state?.pose ?? "standing" },
                });
              }
            }}
          >
            AI Redraw — generate this pose (costs a generation)
          </button>
          <button
            className="rounded border border-fuchsia-700 px-3 py-1.5 text-xs text-fuchsia-300 hover:bg-fuchsia-950/40 disabled:opacity-40"
            disabled={!characterId}
            onClick={() => {
              close();
              if (characterId) openCompiler(characterId);
            }}
          >
            Create New Puppet State — compile artwork that can hold it
          </button>
        </div>
      </div>
    </div>
  );
}
