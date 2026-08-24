"use client";

/**
 * Coordinated multi-character generation, with review before placement.
 *
 * Two rules this surface exists to honour:
 *
 *  1. **One request, both references.** A hug is generated once, carrying every
 *     participant's own identity image. Describing one character in text while
 *     sending the other's picture is what makes a model blend two people.
 *  2. **Preview before replacing anything.** The actors are already composed on
 *     the page; a composite render must not silently take their place.
 *
 * The result is labelled as what it is — "friend + 豆包 · Hug" — rather than
 * pretending the combined image is still one of them.
 *
 * The drawing itself belongs to `services/interaction`, which the Agent
 * also calls. This file is preview and confirmation only: two pipelines would
 * drift until a hug meant different things depending on how it was asked for.
 */

import { useState } from "react";
import { assetRenderUrl } from "@/assets/renderSource";
import { interactionLabel } from "@/domain/interactions";
import { placeInteractionRender, renderInteraction } from "@/services/interaction";
import type { ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";

export function InteractionDialog() {
  const request = useUiStore((s) => s.interactionRequest);
  const close = useUiStore((s) => s.closeInteraction);
  if (!request) return null;
  return <InteractionDialogInner key={request.interactionId} interactionId={request.interactionId} onClose={close} />;
}

function InteractionDialogInner({ interactionId, onClose }: { interactionId: ID; onClose: () => void }) {
  const doc = useEditorStore((s) => s.doc);
  const dispatch = useEditorStore((s) => s.dispatch);
  const [phase, setPhase] = useState<"idle" | "generating" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<ID | null>(null);
  const [reused, setReused] = useState(false);

  const interaction = doc?.interactions[interactionId];
  if (!doc || !interaction) return null;

  const names = interaction.participantIds.map((id) => doc.characters[id]?.name ?? id);
  const title = `${names.join(" + ")} · ${interactionLabel(interaction.type)}`;
  const previewUrl = assetId ? assetRenderUrl(doc.assets[assetId]) : undefined;

  const generate = async () => {
    setPhase("generating");
    setError(null);
    try {
      // Reuse before generating: an identical Yuri+Mio hug already exists.
      const render = await renderInteraction(interactionId);
      setAssetId(render.assetId);
      setReused(render.reusedCache);
      setPhase("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Generation failed");
      setPhase("idle");
    }
  };

  const place = () => {
    if (!assetId) return;
    const placedId = placeInteractionRender(interactionId, assetId);
    if (placedId) useEditorStore.getState().select({ itemId: placedId, panelId: interaction.panelId });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60" onMouseDown={onClose}>
      <div
        className="w-[440px] rounded-lg bg-[var(--bg-elevated)] p-4 text-sm shadow-2xl shadow-black/50"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="mb-1 font-semibold text-zinc-100">Creating {interactionLabel(interaction.type)}</h2>
        <p className="mb-3 text-xs text-zinc-500">Using {names.join(" and ")}</p>

        <div className="mb-3 rounded-md bg-[var(--bg-elevated)] p-2 text-[11px] leading-4 text-zinc-400">
          A {interactionLabel(interaction.type).toLowerCase()} needs the characters to overlap and occlude each
          other, which cannot be produced by moving existing artwork. It is drawn once, using both characters as
          references so neither identity is blended into the other.
        </div>

        {previewUrl ? (
          <div className="mb-3">
            <div className="grid h-56 place-items-center overflow-hidden rounded border border-zinc-800 bg-[repeating-conic-gradient(#3f3f46_0%_25%,#27272a_0%_50%)] bg-[length:16px_16px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt={title} className="max-h-full max-w-full object-contain" />
            </div>
            <p className="mt-1 text-[10px] text-zinc-500">
              {reused ? "Reusing an existing render of this interaction." : title}
            </p>
          </div>
        ) : (
          <div className="mb-3 grid h-40 place-items-center rounded border border-dashed border-zinc-800 text-[11px] text-zinc-600">
            {phase === "generating" ? "Generating with both character references…" : "No preview yet"}
          </div>
        )}

        {error && <p className="mb-2 rounded border border-red-900/60 bg-red-950/30 p-2 text-[11px] text-red-300">{error}</p>}

        <div className="flex justify-between gap-2">
          <button
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
            onClick={() => {
              // Discarding removes the planned interaction: leaving a record
              // with no render would claim something happened that did not.
              if (!assetId) dispatch({ type: "remove-interaction", interactionId });
              onClose();
            }}
          >
            Discard
          </button>
          <div className="flex gap-2">
            <button
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              disabled={phase === "generating"}
              onClick={() => void generate()}
            >
              {phase === "generating" ? "Generating…" : previewUrl ? "Regenerate" : "Generate"}
            </button>
            <button
              className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-xs text-white hover:bg-[var(--accent-hover)] disabled:opacity-40"
              disabled={!assetId}
              onClick={place}
            >
              Use in Panel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

