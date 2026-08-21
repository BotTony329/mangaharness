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
 */

import { useState } from "react";
import { callGenerateApi, storeGeneratedAsset } from "@/ai/clientGeneration";
import { buildAssetPrompt } from "@/ai/promptTemplates";
import { assetRenderUrl } from "@/assets/renderSource";
import {
  INTERACTION_LABELS,
  buildMultiCharacterRequest,
  findInteractionRender,
  interactionCacheKey,
} from "@/domain/interactions";
import { stateFromInstance } from "@/characters/state";
import { getStyleGenerationContext, isMonochromeStyle, styleMetadata } from "@/styles/generation";
import type { AssetInstance, ID } from "@/domain/types";
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

  const interaction = doc?.interactions[interactionId];
  if (!doc || !interaction) return null;

  const names = interaction.participantIds.map((id) => doc.characters[id]?.name ?? id);
  const title = `${names.join(" + ")} · ${INTERACTION_LABELS[interaction.type]}`;
  const style = getStyleGenerationContext(doc);

  const cacheKey = interactionCacheKey({
    participantCharacterIds: interaction.participantIds,
    type: interaction.type,
    roles: interaction.roles,
    outfits: interaction.participantIds.map((id) => outfitOf(doc, interaction.panelId, id)),
    view: "front",
    styleProfileId: style.profile.id,
  });
  // Reuse before generating: an identical Yuri+Mio hug already exists.
  const cached = findInteractionRender(doc, cacheKey);
  const previewAssetId = assetId ?? cached?.generatedAssetId ?? null;
  const previewUrl = previewAssetId ? assetRenderUrl(doc.assets[previewAssetId]) : undefined;

  const generate = async () => {
    setPhase("generating");
    setError(null);
    try {
      const requestModel = buildMultiCharacterRequest(doc, interaction, {
        styleProfileId: style.profile.id,
        outfits: Object.fromEntries(
          interaction.participantIds.map((id) => [id, outfitOf(doc, interaction.panelId, id)]),
        ),
      });

      const prompt = [
        buildAssetPrompt({
          assetType: "character",
          description: requestModel.interactionConstraints.join(" "),
          style: style.profile,
          monochrome: isMonochromeStyle(style.profile),
        }),
        ...requestModel.identityConstraints,
        ...requestModel.outfitConstraints,
      ].join(" ");

      /**
       * Every participant's own reference goes to the provider, in order. This
       * is the whole point of the joint path.
       */
      const referenceUrls = requestModel.participantReferenceAssetIds
        .map((id) => assetRenderUrl(doc.assets[id]))
        .filter((url): url is string => Boolean(url));

      const result = await callGenerateApi({
        assetType: "character",
        prompt,
        negativePrompt: style.profile.negativePrompt,
        size: "portrait",
        expectMonochrome: isMonochromeStyle(style.profile),
        referenceUrls,
      });

      const created = await storeGeneratedAsset({
        result,
        assetType: "character",
        category: "character",
        name: title,
        prompt,
        metadata: styleMetadata(style),
      });

      // Provenance: this image contains BOTH characters, and the system needs
      // to know that for grounding, reuse and deletion safety.
      dispatch({
        type: "record-interaction-render",
        input: {
          interactionId,
          participantCharacterIds: [...interaction.participantIds],
          participantReferenceAssetIds: requestModel.participantReferenceAssetIds,
          generatedAssetId: created,
          cacheKey,
        },
      });
      setAssetId(created);
      setPhase("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Generation failed");
      setPhase("idle");
    }
  };

  const place = () => {
    if (!previewAssetId) return;
    const placed = dispatch({ type: "add-instance", panelId: interaction.panelId, assetId: previewAssetId });
    if (placed.createdId) useEditorStore.getState().select({ itemId: placed.createdId, panelId: interaction.panelId });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60" onMouseDown={onClose}>
      <div
        className="w-[440px] rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-sm shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="mb-1 font-semibold text-zinc-100">Creating {INTERACTION_LABELS[interaction.type]}</h2>
        <p className="mb-3 text-xs text-zinc-500">Using {names.join(" and ")}</p>

        <div className="mb-3 rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px] leading-4 text-zinc-400">
          A {INTERACTION_LABELS[interaction.type].toLowerCase()} needs the characters to overlap and occlude each
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
              {cached && !assetId ? "Reusing an existing render of this interaction." : title}
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
              if (!assetId && !cached) dispatch({ type: "remove-interaction", interactionId });
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
              className="rounded bg-indigo-600 px-4 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-40"
              disabled={!previewAssetId}
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

/** The outfit a participant is currently wearing in this panel, for the cache key. */
function outfitOf(
  doc: ReturnType<typeof useEditorStore.getState>["doc"] & object,
  panelId: ID,
  characterId: ID,
): string {
  const item = (doc.panels[panelId]?.itemIds ?? [])
    .map((id) => doc.items[id])
    .find((candidate): candidate is AssetInstance => {
      if (candidate?.kind !== "asset") return false;
      const owner = stateFromInstance(doc, candidate)?.characterId ?? doc.assets[candidate.sourceAssetId]?.metadata?.characterId;
      return owner === characterId;
    });
  return (item && stateFromInstance(doc, item)?.outfit) || "default outfit";
}
