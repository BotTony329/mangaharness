"use client";

/**
 * AI Asset Generator: semantic inputs (character/pose/expression/scene) →
 * real generation via the server API → result lands in the library only when
 * the creator accepts it. Generation never touches the canvas directly.
 */

import { useEffect, useMemo, useState } from "react";
import {
  callGenerateApi,
  GenerationApiError,
  recordFailedGeneration,
  storeGeneratedAsset,
  type GenerateApiResult,
} from "@/ai/clientGeneration";
import { buildAssetPrompt, defaultAspect } from "@/ai/promptTemplates";
import { DEFAULT_CHARACTER_STATE, characterIdentityDescription, characterReferenceId } from "@/characters/state";
import { getStyleGenerationContext, styleMetadata } from "@/styles/generation";
import type { AssetCategory } from "@/domain/types";
import {
  BACKGROUND_REMOVAL_FAILED_MESSAGE,
  validateCharacterTransparency,
} from "@/assets/characterAssetContract";
import { useEditorStore } from "@/editor/store";
import { useUiStore, type GeneratorRequest } from "@/editor/uiStore";
import { assetRenderUrl } from "@/assets/renderSource";

interface ProviderInfo {
  configured: boolean;
  capabilities?: { referenceImage?: boolean; supportsTransparentBackground?: boolean };
  storage?: { configured?: boolean; backend?: string };
}

const TYPE_LABEL: Record<GeneratorRequest["assetType"], string> = {
  character: "Character reference",
  "character-pose": "Character pose",
  "character-expression": "Character expression",
  background: "Background",
  prop: "Prop",
};

export function GeneratorDialog() {
  const request = useUiStore((s) => s.generator);
  const close = useUiStore((s) => s.closeGenerator);
  if (!request) return null;
  return <GeneratorDialogInner key={`${request.assetType}-${request.characterId ?? ""}`} request={request} onClose={close} />;
}

function GeneratorDialogInner({ request, onClose }: { request: GeneratorRequest; onClose: () => void }) {
  const doc = useEditorStore((s) => s.doc);
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [description, setDescription] = useState(request.prefill?.description ?? "");
  const [pose, setPose] = useState(request.prefill?.pose ?? "");
  const [expression, setExpression] = useState(request.prefill?.expression ?? "");
  const [phase, setPhase] = useState<"idle" | "generating" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<GenerationApiError | null>(null);
  const [result, setResult] = useState<GenerateApiResult | null>(null);

  useEffect(() => {
    fetch("/api/provider/status")
      .then((r) => r.json())
      .then(setProvider)
      .catch(() => setProvider({ configured: false }));
  }, []);

  const character = request.characterId && doc ? doc.characters[request.characterId] : undefined;
  const referenceId = character ? characterReferenceId(character) : undefined;
  const referenceAsset = referenceId && doc ? doc.assets[referenceId] : undefined;
  const style = doc ? getStyleGenerationContext(doc) : undefined;
  const isCharacterType = request.assetType.startsWith("character");
  const canUseReference = Boolean(provider?.capabilities?.referenceImage && referenceAsset);

  const prompt = useMemo(
    () =>
      buildAssetPrompt({
        assetType: request.assetType,
        description: description || undefined,
        characterName: character?.name,
        characterDescription: character ? characterIdentityDescription(character) : undefined,
        pose: pose || undefined,
        expression: expression || undefined,
        hasReference: canUseReference,
        style: style?.profile,
        supportsNativeTransparency: Boolean(provider?.capabilities?.supportsTransparentBackground),
      }),
    [
      request.assetType,
      description,
      character,
      pose,
      expression,
      canUseReference,
      style?.profile,
      provider?.capabilities?.supportsTransparentBackground,
    ],
  );

  // Whether this result may become a library asset at all. Backgrounds always
  // pass; characters and props must carry a validated transparent derivative.
  const contract = validateCharacterTransparency({
    category: isCharacterType ? "character" : (request.assetType as AssetCategory),
    processingStatus: result?.processingStatus,
    hasAlpha: result?.hasAlpha,
    processedImageUrl: result?.processedImageUrl,
  });

  const generate = async () => {
    setPhase("generating");
    setError(null);
    setErrorDetails(null);
    try {
      const referenceAssets = provider?.capabilities?.referenceImage
        ? [isCharacterType ? referenceAsset : undefined, style?.referenceAsset].filter(
            (asset, index, list) => Boolean(asset) && list.findIndex((candidate) => candidate?.id === asset?.id) === index,
          )
        : [];
      const output = await callGenerateApi({
        assetType: request.assetType,
        prompt,
        negativePrompt: style?.profile.negativePrompt,
        size: defaultAspect(request.assetType),
        referenceUrls: referenceAssets.length > 0 ? referenceAssets.map((asset) => assetRenderUrl(asset)!).filter(Boolean) : undefined,
      });
      setResult(output);
      setPhase("done");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Generation failed";
      setError(message);
      setErrorDetails(e instanceof GenerationApiError ? e : null);
      setPhase("idle");
      recordFailedGeneration(request.assetType, prompt, message);
    }
  };

  const addToLibrary = async () => {
    if (!result || !doc) return;
    const category: AssetCategory = isCharacterType ? "character" : (request.assetType as AssetCategory);
    const assetId = await storeGeneratedAsset({
      result,
      assetType: request.assetType,
      category,
      name: isCharacterType
        ? `${character?.name ?? "Character"} ${pose || expression || "reference"}`.trim()
        : description.slice(0, 40) || TYPE_LABEL[request.assetType],
      prompt,
      metadata: {
        characterId: request.characterId,
        pose: pose || DEFAULT_CHARACTER_STATE.pose,
        expression: expression || DEFAULT_CHARACTER_STATE.expression,
        outfit: DEFAULT_CHARACTER_STATE.outfit,
        view: DEFAULT_CHARACTER_STATE.view,
        characterAssetRole: request.assetType === "character" ? "canonical" : "state",
        canonicalReferenceAssetId: request.assetType === "character" ? undefined : referenceId,
        referenceAssetIds: result.referenceUsed
          ? [isCharacterType ? referenceAsset?.id : undefined, style?.referenceAsset?.id].filter(
              (id): id is string => Boolean(id),
            )
          : undefined,
        ...(style ? styleMetadata(style) : {}),
      },
    });
    // "Generate missing slot" flows started from a selected instance also
    // swap that instance to the new asset — composition stays intact.
    if (request.targetInstanceId) {
      const store = useEditorStore.getState();
      if (store.doc?.items[request.targetInstanceId]) {
        store.dispatch({ type: "swap-instance-asset", instanceId: request.targetInstanceId, assetId });
      }
    }
    if (request.replaceAssetId && useEditorStore.getState().doc?.assets[request.replaceAssetId]) {
      useEditorStore.getState().dispatch({ type: "replace-asset", oldAssetId: request.replaceAssetId, newAssetId: assetId });
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60" onMouseDown={onClose}>
      <div
        className="max-h-[90vh] w-[460px] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-sm shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 font-semibold text-zinc-100">AI Asset Generator</h2>
        <p className="mb-3 text-xs text-zinc-500">
          {TYPE_LABEL[request.assetType]}
          {character ? ` · ${character.name}` : ""}
        </p>

        {provider && !provider.configured && (
          <div className="mb-3 rounded border border-zinc-700 bg-zinc-950/80 p-3 text-center text-xs">
            <p className="mb-2 text-zinc-400">Connect an image model to generate assets.</p>
            <button
              className="rounded bg-indigo-600 px-4 py-1.5 text-white hover:bg-indigo-500"
              onClick={() => {
                onClose();
                useUiStore.getState().openSettings();
              }}
            >
              Connect Image Model
            </button>
          </div>
        )}

        {provider?.storage?.configured === false && (
          <div className="mb-3 rounded border border-amber-900/70 bg-amber-950/30 p-3 text-xs text-amber-300">
            Persistent asset storage is not connected. The Manga Studio operator must connect storage before generated images can be saved.
          </div>
        )}

        {phase !== "done" && (
          <>
            {request.assetType === "character-pose" && (
              <Field label="Pose" value={pose} onChange={setPose} placeholder="running" />
            )}
            {request.assetType === "character-expression" && (
              <Field label="Expression" value={expression} onChange={setExpression} placeholder="crying" />
            )}
            {request.assetType === "character-pose" && (
              <Field label="Expression (optional)" value={expression} onChange={setExpression} placeholder="happy" />
            )}
            <label className="mb-1 block text-xs text-zinc-400">
              {isCharacterType ? "Extra instruction (optional)" : "Description"}
            </label>
            <textarea
              className="mb-3 h-20 w-full resize-none rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                request.assetType === "background"
                  ? "Empty Japanese high school classroom, afternoon sunlight"
                  : request.assetType === "prop"
                    ? "Japanese school bag, isolated object"
                    : "Running toward camera while carrying a school bag"
              }
            />

            {isCharacterType && (
              <p className="mb-3 rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px] leading-4 text-zinc-500">
                {canUseReference
                  ? "The character reference image will be sent to the provider to help preserve identity. Consistency is provider-dependent and not guaranteed."
                  : referenceAsset
                    ? "The configured provider does not support reference images — identity will rely on the text description only."
                    : "No reference image yet — the first generated image becomes this character's reference."}
              </p>
            )}

            <details className="mb-3 text-[11px] text-zinc-500">
              <summary className="cursor-pointer">Prompt preview</summary>
              <p className="mt-1 rounded bg-zinc-950 p-2 leading-4">{prompt}</p>
            </details>

            {error && (
              <div className="mb-2 rounded border border-red-900/60 bg-red-950/30 p-2 text-xs text-red-300">
                <p className="font-medium">Generation failed</p>
                <p className="mt-1 text-red-400">{error}</p>
                {(errorDetails?.requestId || errorDetails?.details) && (
                  <details className="mt-2 text-[11px] text-zinc-400">
                    <summary className="cursor-pointer">Show safe details</summary>
                    <dl className="mt-1 grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 rounded bg-zinc-950 p-2">
                      {errorDetails.details?.provider && <><dt>Provider</dt><dd>{errorDetails.details.provider}</dd></>}
                      {errorDetails.details?.model && <><dt>Model</dt><dd>{errorDetails.details.model}</dd></>}
                      {errorDetails.details?.endpoint && <><dt>Endpoint</dt><dd>{errorDetails.details.endpoint}</dd></>}
                      {errorDetails.details?.httpStatus && <><dt>HTTP</dt><dd>{errorDetails.details.httpStatus}</dd></>}
                      {errorDetails.details?.stage && <><dt>Stage</dt><dd>{errorDetails.details.stage}</dd></>}
                      {errorDetails.requestId && <><dt>Request ID</dt><dd className="break-all">{errorDetails.requestId}</dd></>}
                    </dl>
                  </details>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button className="rounded px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200" onClick={onClose}>
                Cancel
              </button>
              <button
                className="rounded bg-indigo-600 px-4 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-40"
                disabled={
                  phase === "generating" ||
                  provider?.configured === false ||
                  provider?.storage?.configured === false
                }
                onClick={generate}
              >
                {phase === "generating" ? `Generating${character ? ` ${character.name}` : " asset"}…` : "Generate"}
              </button>
            </div>
          </>
        )}

        {phase === "done" && result && (
          <div>
            {contract.valid ? (
              <>
                <p className="mb-2 text-xs text-zinc-400">Generated result</p>
                {/* The checkerboard is a CSS backdrop BEHIND a transparent PNG.
                    It is never part of the bitmap. `result.url` is the stored
                    derivative, so this preview is byte-identical to what the
                    library keeps and the canvas composites. */}
                <div className="mb-3 grid place-items-center rounded border border-zinc-700 bg-[repeating-conic-gradient(#3f3f46_0%_25%,#27272a_0%_50%)] bg-[length:16px_16px] p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={result.url} alt="Generated asset" className="max-h-[360px] rounded" />
                </div>
                {result.referenceUsed && (
                  <p className="mb-2 text-[11px] text-zinc-500">Generated with the character reference image.</p>
                )}
                <div className="flex justify-end gap-2 text-xs">
                  <button
                    className="rounded px-3 py-1.5 text-zinc-400 hover:text-zinc-200"
                    onClick={() => {
                      setResult(null);
                      setPhase("idle");
                    }}
                  >
                    Discard
                  </button>
                  <button
                    className="rounded border border-zinc-600 bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700"
                    onClick={() => {
                      setResult(null);
                      generate();
                    }}
                  >
                    Regenerate
                  </button>
                  <button className="rounded bg-indigo-600 px-4 py-1.5 text-white hover:bg-indigo-500" onClick={addToLibrary}>
                    Add to Library
                  </button>
                </div>
              </>
            ) : (
              // One concise recoverable state. No raw preview: showing the
              // un-keyed image on a checkerboard backdrop is what made a failed
              // extraction look like a transparent asset.
              <div className="rounded border border-amber-800/60 bg-amber-950/30 p-3">
                <p className="mb-1 text-xs font-medium text-amber-300">{BACKGROUND_REMOVAL_FAILED_MESSAGE}</p>
                <p className="mb-3 text-[11px] leading-4 text-zinc-400">
                  This image could not be turned into a transparent layer, so it was not added to your library.
                </p>
                <div className="flex justify-end gap-2 text-xs">
                  <button
                    className="rounded px-3 py-1.5 text-zinc-400 hover:text-zinc-200"
                    onClick={() => {
                      setResult(null);
                      setPhase("idle");
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="rounded bg-indigo-600 px-4 py-1.5 text-white hover:bg-indigo-500"
                    onClick={() => {
                      setResult(null);
                      generate();
                    }}
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-xs text-zinc-400">{label}</label>
      <input
        className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
