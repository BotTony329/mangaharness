"use client";

/**
 * AI Asset Generator: semantic inputs (character/pose/expression/scene) →
 * real generation via the server API → result lands in the library only when
 * the creator accepts it. Generation never touches the canvas directly.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  callGenerateApi,
  GenerationApiError,
  recordFailedGeneration,
  storeGeneratedAsset,
  type GenerateApiResult,
} from "@/ai/clientGeneration";
import { buildAssetPrompt, defaultAspect } from "@/ai/promptTemplates";
import { DEFAULT_CHARACTER_STATE, characterIdentityDescription, characterReferenceId } from "@/characters/state";
import { referenceOptions } from "@/characters/stateResolver";
import type { CharacterState } from "@/domain/types";
import { getStyleGenerationContext, isMonochromeStyle, styleMetadata } from "@/styles/generation";
import type { AssetCategory, MangaLanguageCategory } from "@/domain/types";
import {
  BACKGROUND_REMOVAL_FAILED_MESSAGE,
  validateCharacterTransparency,
} from "@/assets/characterAssetContract";
import { useEditorStore } from "@/editor/store";
import { useUiStore, type GeneratorRequest } from "@/editor/uiStore";
import { assetPreviewUrl, assetRenderUrl } from "@/assets/renderSource";
import { uploadImageFile } from "@/components/library/uploadAsset";
import { CATEGORY_LABELS, LANGUAGE_CATEGORIES } from "@/language/library";

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
  "manga-effect": "Manga effect",
  tone: "Tone",
};

/** What kind of screentone is being asked for (§9). */
const TONE_TYPES: { id: "texture" | "atmosphere" | "decorative" | "pattern"; label: string; hint: string }[] = [
  { id: "texture", label: "Texture", hint: "Rain, grain, fabric, rough ink" },
  { id: "atmosphere", label: "Atmosphere", hint: "Gloom, dread, warmth, memory" },
  { id: "decorative", label: "Decorative", hint: "Flowers, sparkles, romance" },
  { id: "pattern", label: "Pattern", hint: "A motif that repeats without a seam" },
];

/**
 * Search tags for a generated effect, from what the creator actually typed.
 * The category is always included so a "shock" search finds it even when the
 * description used different words.
 */
function tagsFromDescription(description: string, category: MangaLanguageCategory): string[] {
  const stop = new Set(["a", "an", "the", "with", "and", "of", "for", "in", "on", "style", "manga"]);
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word.length > 2 && !stop.has(word));
  return [...new Set([category, ...words])].slice(0, 12);
}

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
  const [toneType, setToneType] = useState<"texture" | "atmosphere" | "decorative" | "pattern">("texture");
  // Most useful tones repeat; a one-off decorative overlay is the exception.
  const [tileable, setTileable] = useState(true);
  const [pose, setPose] = useState(request.prefill?.pose ?? "");
  const [expression, setExpression] = useState(request.prefill?.expression ?? "");
  const [phase, setPhase] = useState<"idle" | "generating" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<GenerationApiError | null>(null);
  const [result, setResult] = useState<GenerateApiResult | null>(null);
  /** Empty = Auto (resolver's pick). Otherwise an explicit reference asset id. */
  const [referenceChoice, setReferenceChoice] = useState<string>("");
  /**
   * Scene and Object generation accept a reference too — an uploaded photo or
   * an asset already in the library. Previously only characters could send one,
   * so "generate a lamp like this one" had nowhere to put the lamp.
   */
  const [sceneReferenceId, setSceneReferenceId] = useState<string>("");
  const [referenceUse, setReferenceUse] = useState<"layout" | "style" | "loose">("style");

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
  const isLanguageType = request.assetType === "manga-effect";
  const isToneType = request.assetType === "tone";
  const languageCategory: MangaLanguageCategory = request.languageCategory ?? "decorations";
  const canUseReference = Boolean(provider?.capabilities?.referenceImage && referenceAsset);

  const prompt = useMemo(
    () =>
      buildAssetPrompt({
        assetType: request.assetType,
        description: [description || undefined, referenceIntent(Boolean(sceneReferenceId), referenceUse)]
          .filter(Boolean)
          .join(" ") || undefined,
        characterName: character?.name,
        characterDescription: character ? characterIdentityDescription(character) : undefined,
        pose: pose || undefined,
        expression: expression || undefined,
        hasReference: canUseReference,
        style: style?.profile,
        supportsNativeTransparency: Boolean(provider?.capabilities?.supportsTransparentBackground),
        monochrome: isMonochromeStyle(style?.profile),
        languageCategory,
        toneType,
        tileable,
      }),
    [
      request.assetType,
      languageCategory,
      toneType,
      tileable,
      description,
      sceneReferenceId,
      referenceUse,
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
    category: isCharacterType ? "character" : isLanguageType || isToneType ? "prop" : (request.assetType as AssetCategory),
    processingStatus: result?.processingStatus,
    hasAlpha: result?.hasAlpha,
    processedImageUrl: result?.processedImageUrl,
  });

  /**
   * Reference options for the state being generated (§3). Built from the state
   * graph, so "Auto" names the exact render the resolver would anchor on.
   */
  const desiredState: CharacterState | undefined =
    character && isCharacterType
      ? {
          characterId: character.id,
          pose: pose || DEFAULT_CHARACTER_STATE.pose,
          expression: expression || DEFAULT_CHARACTER_STATE.expression,
          outfit: DEFAULT_CHARACTER_STATE.outfit,
          view: DEFAULT_CHARACTER_STATE.view,
        }
      : undefined;
  const references = doc && desiredState ? referenceOptions(doc, desiredState) : [];
  const activeReference = references.find((option) => (option.assetId ?? "") === referenceChoice) ?? references[0];

  const generate = async () => {
    setPhase("generating");
    setError(null);
    setErrorDetails(null);
    try {
      // Whatever the selector shows is what reaches the provider — the UI does
      // not display one reference while sending another.
      const chosenAsset =
        isCharacterType && activeReference?.assetId ? doc?.assets[activeReference.assetId] : undefined;
      const identityAsset = chosenAsset ?? (isCharacterType ? referenceAsset : undefined);
      const sceneReference = !isCharacterType && sceneReferenceId ? doc?.assets[sceneReferenceId] : undefined;
      const referenceAssets = provider?.capabilities?.referenceImage
        ? [identityAsset, sceneReference, style?.referenceAsset].filter(
            (asset, index, list) => Boolean(asset) && list.findIndex((candidate) => candidate?.id === asset?.id) === index,
          )
        : [];
      const output = await callGenerateApi({
        assetType: request.assetType,
        prompt,
        negativePrompt: style?.profile.negativePrompt,
        size: defaultAspect(request.assetType),
        expectMonochrome: isMonochromeStyle(style?.profile),
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

    /**
     * A generated manga-language visual lands on TWO shelves: the underlying
     * SourceAsset carries the image and its transparency, and a
     * MangaLanguageAsset makes it findable, taggable, and reusable by both the
     * creator and the Agent. Without the second, a generated sparkle would be
     * an anonymous "prop" nobody could search for.
     */
    if (isLanguageType) {
      const assetId = await storeGeneratedAsset({
        result,
        assetType: "manga-effect",
        category: "prop",
        name: description.slice(0, 40) || "Manga effect",
        prompt,
        metadata: style ? styleMetadata(style) : undefined,
      });
      useEditorStore.getState().dispatch({
        type: "add-language-asset",
        input: {
          category: languageCategory,
          name: description.slice(0, 40) || "Manga effect",
          source: "ai-generated",
          format: "visual",
          assetId,
          tags: tagsFromDescription(description, languageCategory),
          generationMetadata: {
            prompt,
            styleProfileId: style?.profile.id,
            createdAt: new Date().toISOString(),
          },
        },
      });
      onClose();
      return;
    }

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
        toneType: isToneType ? toneType : undefined,
        tileable: isToneType ? tileable : undefined,
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
        className="max-h-[90vh] w-[460px] overflow-y-auto rounded-lg bg-[var(--bg-elevated)] p-4 text-sm shadow-2xl shadow-black/50"
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
              className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-white hover:bg-[var(--accent-hover)]"
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
            Persistent asset storage is not connected. The Kumanga operator must connect storage before generated images can be saved.
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
            {isCharacterType && references.length > 0 && (
              <div className="mb-3">
                <label className="mb-1 block text-xs text-zinc-400">Reference</label>
                <select
                  aria-label="Reference"
                  className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 text-sm"
                  value={referenceChoice}
                  onChange={(event) => setReferenceChoice(event.target.value)}
                >
                  {references.map((option) => (
                    <option key={`${option.kind}-${option.assetId ?? "none"}`} value={option.assetId ?? ""}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[10px] leading-4 text-zinc-500">
                  {activeReference?.automatic
                    ? "The nearest existing render anchors this generation; identity stays anchored on the canonical image."
                    : "This reference will be sent to the provider instead of the automatic choice."}
                </p>
              </div>
            )}

            {!isCharacterType && <ReferencePicker
              value={sceneReferenceId}
              onChange={setSceneReferenceId}
              use={referenceUse}
              onUseChange={setReferenceUse}
              category={request.assetType === "background" ? "background" : request.assetType === "tone" ? "tone" : "prop"}
              supported={Boolean(provider?.capabilities?.referenceImage)}
            />}

            {isLanguageType && (
              <div className="mb-3">
                <label className="mb-1 block text-xs text-zinc-400" htmlFor="language-category">Category</label>
                <select
                  id="language-category"
                  className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 text-sm"
                  value={languageCategory}
                  onChange={(event) =>
                    useUiStore.getState().openGenerator({
                      ...request,
                      languageCategory: event.target.value as MangaLanguageCategory,
                    })
                  }
                >
                  {LANGUAGE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[10px] leading-4 text-zinc-500">
                  Generated effects inherit the project art style, so a monochrome project cannot receive a colour effect.
                </p>
              </div>
            )}

            {isToneType && (
              <div className="mb-3">
                <p className="mb-1 text-xs text-zinc-400">Type</p>
                <div className="grid grid-cols-2 gap-1">
                  {TONE_TYPES.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      title={option.hint}
                      className={`rounded-md border px-2 py-1.5 text-left text-[11px] ${
                        toneType === option.id
                          ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]"
                          : "border-[var(--border-subtle)] text-zinc-400 hover:border-zinc-600"
                      }`}
                      onClick={() => setToneType(option.id)}
                    >
                      <span className="block">{option.label}</span>
                      <span className="block text-[10px] text-zinc-500">{option.hint}</span>
                    </button>
                  ))}
                </div>
                <label className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400">
                  <input type="checkbox" checked={tileable} onChange={(event) => setTileable(event.target.checked)} />
                  Repeats without a seam
                </label>
                <p className="mt-1 text-[10px] leading-4 text-zinc-500">
                  {tileable
                    ? "Scale will change the pattern size and the tone will repeat across the panel."
                    : "The tone will be fitted to the area it covers rather than repeated."}
                </p>
              </div>
            )}

            <label className="mb-1 block text-xs text-zinc-400">
              {isCharacterType ? "Extra instruction (optional)" : "Description"}
            </label>
            <textarea
              className="mb-3 h-20 w-full resize-none rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] p-2 text-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                request.assetType === "background"
                  ? "Empty Japanese high school classroom, afternoon sunlight"
                  : request.assetType === "prop"
                    ? "Japanese school bag, isolated object"
                    : isLanguageType
                      ? "extreme shocked manga symbol, black-and-white, rough ink style"
                      : isToneType
                        ? "dark psychological manga hatching"
                        : "Running toward camera while carrying a school bag"
              }
            />

            {isCharacterType && (
              <p className="mb-3 rounded-md bg-[var(--bg-elevated)] p-2 text-[11px] leading-4 text-zinc-500">
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
                className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-xs text-white hover:bg-[var(--accent-hover)] disabled:opacity-40"
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
                  <button className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-white hover:bg-[var(--accent-hover)]" onClick={addToLibrary}>
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
                    className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-white hover:bg-[var(--accent-hover)]"
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
        className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

/**
 * One reference picker, shared by Scene, Object and Manga FX generation.
 *
 * Upload a new image or reuse one already in the library, and say what the
 * reference is FOR. The intent matters: "match this room's layout" and "match
 * this drawing's style" are different requests, and collapsing them makes the
 * provider guess.
 *
 * Characters keep their own reference selector, which is built from the state
 * graph and answers a different question — which existing render anchors this
 * identity.
 */
function ReferencePicker({
  value,
  onChange,
  use,
  onUseChange,
  category,
  supported,
}: {
  value: string;
  onChange: (assetId: string) => void;
  use: "layout" | "style" | "loose";
  onUseChange: (use: "layout" | "style" | "loose") => void;
  category: AssetCategory;
  supported: boolean;
}) {
  const doc = useEditorStore((s) => s.doc);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!doc) return null;
  // Any image already in the project is a candidate reference.
  const candidates = Object.values(doc.assets).filter((asset) => asset.status !== "archived");
  const selected = value ? doc.assets[value] : undefined;

  if (!supported) {
    return (
      <p className="mb-3 rounded-md bg-[var(--bg-elevated)] p-2 text-[11px] leading-4 text-zinc-500">
        The connected image model does not accept reference images, so this generation uses the description only.
      </p>
    );
  }

  return (
    <div className="mb-3">
      <label className="mb-1 block text-xs text-zinc-400">
        Reference image <span className="text-zinc-600">(optional)</span>
      </label>
      <div className="flex gap-2">
        <select
          aria-label="Reference image"
          className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 text-sm"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">None</option>
          {candidates.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="shrink-0 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setBusy(true);
            setError(null);
            try {
              // Uploaded as a plain upload: a reference is source material, not
              // a cut-out layer, so it must not go through foreground extraction.
              const assetId = await uploadImageFile(file, "upload");
              onChange(assetId);
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "Upload failed");
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>

      {selected && (
        <div className="mt-1.5 flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={assetPreviewUrl(selected)}
            alt={selected.name}
            className="h-12 w-12 rounded border border-zinc-700 object-cover"
          />
          <select
            aria-label="Use reference for"
            className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px]"
            value={use}
            onChange={(event) => onUseChange(event.target.value as "layout" | "style" | "loose")}
          >
            {category === "background" && <option value="layout">Match the layout and architecture</option>}
            <option value="style">Match the art style</option>
            <option value="loose">Loose inspiration</option>
          </select>
        </div>
      )}
      {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}

/** Say what the reference is for, so the provider does not have to guess. */
function referenceIntent(hasReference: boolean, use: "layout" | "style" | "loose"): string {
  if (!hasReference) return "";
  switch (use) {
    case "layout":
      return "Use the supplied reference image for the layout, architecture and spatial arrangement; keep its composition and structure.";
    case "style":
      return "Use the supplied reference image as an art-style reference: match its rendering, line quality and palette.";
    case "loose":
      return "Use the supplied reference image as loose inspiration only; do not copy it directly.";
  }
}
