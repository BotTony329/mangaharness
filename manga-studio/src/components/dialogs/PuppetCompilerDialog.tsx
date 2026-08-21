"use client";

/**
 * Convert to Puppet — the semi-assisted compiler workflow (V3.2 §7).
 *
 * Six short steps: propose → confirm regions → check hidden regions → build →
 * preview → save. The wizard never claims the machine did the segmentation;
 * step 2 exists because the proposal is proportions, not detection, and step 3
 * is explicit about material that does not exist yet.
 *
 * Nothing here mutates the document until Save Puppet.
 */

import { useMemo, useState } from "react";
import { assetRenderUrl } from "@/assets/renderSource";
import { characterReferenceId } from "@/characters/state";
import type { ID, SourceAsset } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { AlertIcon, PendingIcon } from "../ui/icons";
import {
  COMPILER_PART_TYPES,
  compilePuppet,
  compilerIssues,
  isCompilable,
  proposePartRegions,
  type PartRegion,
} from "@/puppet/compiler";
import type { MangaPuppet, PuppetPartType } from "@/puppet/model";
import { resolvePartTransforms, resolveVisibleParts } from "@/puppet/transforms";

type Step = 1 | 2 | 3 | 4 | 5;

const STEP_LABELS: Record<Step, string> = {
  1: "Proposed parts",
  2: "Confirm regions",
  3: "Hidden regions",
  4: "Build",
  5: "Preview",
};

export function PuppetCompilerDialog() {
  const characterId = useUiStore((s) => s.compilerCharacterId);
  const close = useUiStore((s) => s.closeCompiler);
  if (!characterId) return null;
  return <CompilerInner key={characterId} characterId={characterId} onClose={close} />;
}

function CompilerInner({ characterId, onClose }: { characterId: ID; onClose: () => void }) {
  const doc = useEditorStore((s) => s.doc);
  const dispatch = useEditorStore((s) => s.dispatch);
  const [step, setStep] = useState<Step>(1);
  const [regions, setRegions] = useState<PartRegion[]>(() => proposePartRegions());
  const [built, setBuilt] = useState<MangaPuppet | null>(null);
  const [previewExpression, setPreviewExpression] = useState("neutral");
  const [previewArm, setPreviewArm] = useState(0);
  const [busyPart, setBusyPart] = useState<PuppetPartType | null>(null);
  const [error, setError] = useState<string | null>(null);

  const character = doc?.characters[characterId];
  const canonical: SourceAsset | undefined = useMemo(() => {
    if (!doc || !character) return undefined;
    const id = characterReferenceId(character);
    return id ? doc.assets[id] : undefined;
  }, [doc, character]);

  if (!doc || !character) return null;

  const issues = compilerIssues(regions);
  const blocking = issues.filter((issue) => issue.severity === "blocking");
  const sourceAspect = canonical ? canonical.width / canonical.height : 0.5;

  const setRegion = (type: PuppetPartType, patch: Partial<PartRegion>) =>
    setRegions((current) => current.map((region) => (region.type === type ? { ...region, ...patch } : region)));

  /**
   * §9: ask the image-edit provider to reconstruct only the area an arm covers.
   * A failure is reported and the part simply stays incomplete — the capability
   * system already tells the truth about that, so there is nothing to fake.
   */
  const reconstruct = async (type: PuppetPartType) => {
    if (!canonical) return;
    setBusyPart(type);
    setError(null);
    try {
      const response = await fetch("/api/puppet/reconstruct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: assetRenderUrl(canonical), partType: type }),
      });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? "Reconstruction failed");
      const created = dispatch({
        type: "create-asset",
        input: {
          category: "character",
          name: `${character.name} — behind ${type}`,
          storageUrl: body.url,
          processedImageUrl: body.url,
          width: canonical.width,
          height: canonical.height,
          hasAlpha: true,
          backgroundRemoved: true,
          processingStatus: "ready",
          metadata: { characterId, characterAssetRole: "state" },
        },
      });
      if (created.createdId) setRegion(type, { hiddenRegionAssetId: created.createdId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reconstruction failed");
    } finally {
      setBusyPart(null);
    }
  };

  const build = () => {
    setError(null);
    try {
      setBuilt(
        compilePuppet({
          characterId,
          canonicalAssetId: canonical!.id,
          regions,
          sourceAspect,
        }),
      );
      setStep(5);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Compilation failed");
    }
  };

  const save = () => {
    if (!built) return;
    dispatch({ type: "register-puppet", puppet: built });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60" onMouseDown={onClose}>
      <div
        className="max-h-[90vh] w-[560px] overflow-y-auto rounded-lg bg-[var(--bg-elevated)] p-4 text-sm shadow-2xl shadow-black/50"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 font-semibold text-zinc-100">Convert {character.name} to a Puppet</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Step {step} of 5 · {STEP_LABELS[step]}
        </p>

        {!canonical ? (
          <p className="rounded border border-amber-900/70 bg-amber-950/30 p-3 text-xs text-amber-300">
            {character.name} has no canonical transparent render yet. Generate one first — the compiler cuts parts out
            of it.
          </p>
        ) : (
          <>
            {step === 1 && (
              <div className="space-y-2 text-xs leading-5 text-zinc-400">
                <p>
                  The compiler proposes {COMPILER_PART_TYPES.length} part regions from standard manga proportions.
                </p>
                <p className="rounded-md bg-[var(--bg-elevated)] p-2 text-[11px] text-zinc-500">
                  These are a starting guess, <strong className="text-zinc-300">not automatic segmentation</strong>.
                  They will not line up with {character.name} until you adjust them in the next step.
                </p>
                <PreviewImage asset={canonical} regions={regions} />
              </div>
            )}

            {step === 2 && (
              <RegionEditor asset={canonical} regions={regions} onChange={setRegion} />
            )}

            {step === 3 && (
              <div className="space-y-2">
                <p className="text-xs leading-5 text-zinc-400">
                  Arms cover the body behind them. Cutting them out of a flat drawing leaves nothing underneath, so a
                  large swing would expose a gap.
                </p>
                {regions
                  .filter((region) => region.type.startsWith("upperArm") || region.type.startsWith("lowerArm"))
                  .map((region) => (
                    <div
                      key={region.type}
                      className="flex items-center justify-between rounded-md bg-[var(--bg-elevated)] p-2 text-xs"
                    >
                      <span className="text-zinc-300">{region.type}</span>
                      {region.hiddenRegionAssetId ? (
                        <span className="text-emerald-400">Reconstructed</span>
                      ) : (
                        <button
                          className="rounded-md bg-[var(--accent-soft)] px-2 py-1 text-[11px] text-[var(--accent-text)] transition-colors hover:bg-[var(--accent)] hover:text-white disabled:opacity-40"
                          disabled={busyPart !== null}
                          onClick={() => void reconstruct(region.type)}
                        >
                          {busyPart === region.type ? "Reconstructing…" : "Reconstruct with AI"}
                        </button>
                      )}
                    </div>
                  ))}
                <p className="text-[11px] leading-4 text-zinc-500">
                  Skipping this is fine. The puppet still works — it will report large arm movements as approximate
                  rather than pretending they are clean.
                </p>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-2">
                <ul className="space-y-1 text-[11px]">
                  {issues.length === 0 && <li className="text-emerald-400">Everything checks out.</li>}
                  {issues.map((issue, index) => (
                    <li
                      key={index}
                      className={issue.severity === "blocking" ? "text-red-300" : "text-amber-300/90"}
                    >
                      <span className="flex items-start gap-1.5">
                        {issue.severity === "blocking" ? (
                          <AlertIcon size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
                        ) : (
                          <PendingIcon size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
                        )}
                        {issue.message}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {step === 5 && built && (
              <PuppetPreview
                puppet={built}
                asset={canonical}
                expressionId={previewExpression}
                armDegrees={previewArm}
                onExpression={setPreviewExpression}
                onArm={setPreviewArm}
              />
            )}

            {error && <p className="mt-2 rounded border border-red-900/60 bg-red-950/30 p-2 text-[11px] text-red-300">{error}</p>}

            <div className="mt-4 flex justify-between gap-2">
              <button className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800" onClick={onClose}>
                Cancel
              </button>
              <div className="flex gap-2">
                {step > 1 && (
                  <button
                    className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                    onClick={() => setStep((current) => (current - 1) as Step)}
                  >
                    Back
                  </button>
                )}
                {step < 4 && (
                  <button
                    className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:bg-[var(--accent-hover)]"
                    onClick={() => setStep((current) => (current + 1) as Step)}
                  >
                    Next
                  </button>
                )}
                {step === 4 && (
                  <button
                    className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:bg-[var(--accent-hover)] disabled:opacity-40"
                    disabled={blocking.length > 0 || !isCompilable(regions)}
                    onClick={build}
                  >
                    Build puppet
                  </button>
                )}
                {step === 5 && (
                  <button className="rounded bg-fuchsia-600 px-3 py-1.5 text-xs text-white hover:bg-fuchsia-500" onClick={save}>
                    Save Puppet
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The canonical render with the proposed rectangles drawn over it. */
function PreviewImage({ asset, regions }: { asset: SourceAsset; regions: PartRegion[] }) {
  const url = assetRenderUrl(asset);
  return (
    <div className="relative mx-auto w-[220px] overflow-hidden rounded border border-zinc-800 bg-zinc-950">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url ?? ""} alt={asset.name} className="w-full" />
      {regions.map((region) => (
        <div
          key={region.type}
          className={`absolute border ${region.confirmed ? "border-emerald-500/80" : "border-fuchsia-500/60"}`}
          style={{
            left: `${region.rect.x * 100}%`,
            top: `${region.rect.y * 100}%`,
            width: `${region.rect.width * 100}%`,
            height: `${region.rect.height * 100}%`,
          }}
          title={region.type}
        />
      ))}
    </div>
  );
}

/** Step 2: numeric region adjustment plus an explicit per-part confirmation. */
function RegionEditor({
  asset,
  regions,
  onChange,
}: {
  asset: SourceAsset;
  regions: PartRegion[];
  onChange: (type: PuppetPartType, patch: Partial<PartRegion>) => void;
}) {
  const [selected, setSelected] = useState<PuppetPartType>(regions[0].type);
  const region = regions.find((candidate) => candidate.type === selected)!;
  const field = (key: "x" | "y" | "width" | "height") => (
    <label key={key} className="block">
      <span className="text-[10px] text-zinc-500">{key}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.005}
        value={region.rect[key]}
        className="w-full accent-fuchsia-500"
        onChange={(event) =>
          onChange(selected, { rect: { ...region.rect, [key]: Number(event.target.value) }, confirmed: true })
        }
      />
    </label>
  );

  return (
    <div className="grid grid-cols-[220px_1fr] gap-3">
      <PreviewImage asset={asset} regions={regions} />
      <div>
        <select
          aria-label="Part"
          className="mb-2 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 text-xs"
          value={selected}
          onChange={(event) => setSelected(event.target.value as PuppetPartType)}
        >
          {regions.map((candidate) => (
            <option key={candidate.type} value={candidate.type}>
              {candidate.confirmed ? "Confirmed" : "Unconfirmed"} · {candidate.type}
            </option>
          ))}
        </select>
        {(["x", "y", "width", "height"] as const).map(field)}
        <button
          className={`mt-2 w-full rounded border px-2 py-1 text-[11px] ${
            region.confirmed
              ? "border-emerald-700 text-emerald-300"
              : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          }`}
          onClick={() => onChange(selected, { confirmed: !region.confirmed })}
        >
          {region.confirmed ? "Confirmed" : "Confirm this region"}
        </button>
      </div>
    </div>
  );
}

/**
 * Step 5: the same three checks the acceptance test runs — neutral, shock, and
 * a raised arm — rendered from the compiled parts so the creator sees whether
 * the puppet actually holds together before saving it.
 */
function PuppetPreview({
  puppet,
  asset,
  expressionId,
  armDegrees,
  onExpression,
  onArm,
}: {
  puppet: MangaPuppet;
  asset: SourceAsset;
  expressionId: string;
  armDegrees: number;
  onExpression: (id: string) => void;
  onArm: (degrees: number) => void;
}) {
  const url = assetRenderUrl(asset) ?? "";
  const visible = new Set(resolveVisibleParts(puppet, expressionId));
  const transforms = resolvePartTransforms(puppet, { shoulderRight: armDegrees });
  const box = 240;

  return (
    <div>
      <div className="relative mx-auto overflow-hidden rounded border border-zinc-800 bg-zinc-950" style={{ width: box, height: box }}>
        {puppet.partOrder
          .filter((id) => visible.has(id))
          .map((id) => {
            const part = puppet.parts[id];
            const transform = transforms.get(id);
            if (!part?.sourceRect || !transform) return null;
            const width = transform.size.x * box;
            const height = transform.size.y * box;
            return (
              <div
                key={id}
                className="absolute origin-center overflow-hidden"
                style={{
                  left: (transform.x - transform.pivot.x * transform.size.x) * box,
                  top: (transform.y - transform.pivot.y * transform.size.y) * box,
                  width,
                  height,
                  transform: `rotate(${transform.rotation}deg)`,
                  transformOrigin: `${transform.pivot.x * 100}% ${transform.pivot.y * 100}%`,
                  backgroundImage: `url(${url})`,
                  backgroundSize: `${width / part.sourceRect.width}px ${height / part.sourceRect.height}px`,
                  backgroundPosition: `-${(part.sourceRect.x / part.sourceRect.width) * width}px -${(part.sourceRect.y / part.sourceRect.height) * height}px`,
                }}
              />
            );
          })}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {Object.values(puppet.expressions).map((expression) => (
          <button
            key={expression.id}
            className={`rounded-full border px-2 py-0.5 text-[10px] ${
              expressionId === expression.id
                ? "border-fuchsia-500 bg-fuchsia-600/30 text-fuchsia-200"
                : "border-zinc-700 text-zinc-300"
            }`}
            onClick={() => onExpression(expression.id)}
          >
            {expression.name}
          </button>
        ))}
      </div>
      <label className="mt-2 block text-[10px] text-zinc-500">
        Raise right arm {Math.round(armDegrees)}°
        <input
          type="range"
          min={0}
          max={120}
          value={armDegrees}
          className="w-full accent-fuchsia-500"
          onChange={(event) => onArm(Number(event.target.value))}
        />
      </label>
      <p className="mt-1 text-[10px] leading-4 text-zinc-500">{puppet.compilerMetadata.notes}</p>
    </div>
  );
}
