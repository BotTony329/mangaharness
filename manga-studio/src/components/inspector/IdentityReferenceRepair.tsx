"use client";

/**
 * The repair card for a missing identity reference.
 *
 * ## Why this exists
 *
 * Clicking Hug used to end at
 *
 *     "Every participant needs a usable identity reference before a joint render."
 *
 * which names nobody and offers nothing. A capability failure the creator
 * cannot act on is not a smaller feature — it is a dead end, and the creator's
 * only remaining move is to guess.
 *
 * So this card answers two questions the error did not: WHO is missing WHAT,
 * and what can I press. It appears only when the resolver genuinely found
 * nothing usable — a merely broken pointer is repaired silently, because that
 * is a data fault and not a decision anybody should be asked to make.
 *
 * Deliberately absent from the copy: characterId, assetId, metadata, canonical,
 * resolver, capability. A creator repairing their own character should never
 * have to learn our schema to do it.
 */

import { useRef, useState } from "react";
import { assetPreviewUrl } from "@/assets/renderSource";
import { characterAssets, isUsableIdentityAsset, type IdentityReference } from "@/characters/identityReference";
import { repairAssetTransparency } from "@/assets/clientProcessing";
import { uploadImageFile } from "../library/uploadAsset";
import type { ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { AlertIcon, CheckIcon, GenerateIcon, ICON_STROKE, SpinnerIcon, UploadIcon } from "../ui/icons";

export function IdentityReferenceRepair({
  references,
  action,
  onResolved,
}: {
  references: IdentityReference[];
  /** What the creator was trying to do, in their words: "Hug", "Hold Hands". */
  action: string;
  onResolved?: () => void;
}) {
  const missing = references.filter((reference) => reference.status !== "resolved");
  if (missing.length === 0) return null;

  return (
    <div className="rounded-lg p-2.5" style={{ background: "var(--bg-elevated)" }}>
      <p className="mb-0.5 text-[11px] font-medium" style={{ color: "var(--text-primary)" }}>
        {action} needs a reference image
      </p>
      <p className="mb-2 text-[10px] leading-4" style={{ color: "var(--text-muted)" }}>
        Drawing two characters together needs one clear picture of each, so neither of them changes.
      </p>
      <ul className="space-y-1.5">
        {references.map((reference) => (
          <li key={reference.characterId}>
            {reference.status === "resolved" ? (
              <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-secondary)" }}>
                <CheckIcon size={12} strokeWidth={2.25} style={{ color: "var(--success)" }} />
                {reference.characterName} — reference ready
              </span>
            ) : (
              <ParticipantRepair reference={reference} onResolved={onResolved} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ParticipantRepair({
  reference,
  onResolved,
}: {
  reference: IdentityReference;
  onResolved?: () => void;
}) {
  const doc = useEditorStore((state) => state.doc)!;
  const dispatch = useEditorStore((state) => state.dispatch);
  const openGenerator = useUiStore((state) => state.openGenerator);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  /**
   * Everything the character owns, usable or not. An image whose cut-out failed
   * is still worth offering: seeing it is how the creator recognises which
   * picture they meant, and choosing it is a clearer instruction than any
   * message we could write about processing state.
   */
  const existing = characterAssets(doc, reference.characterId);

  const choose = async (assetId: ID) => {
    dispatch({ type: "set-character-reference", characterId: reference.characterId, assetId });
    setChoosing(false);

    /**
     * A picture whose cut-out failed is still the right picture — it just is
     * not usable YET. Pointing at it and declaring the problem solved would be
     * a button that changes nothing, so the existing transparency pipeline is
     * re-run on it here. That is the same repair the character card offers; it
     * is reached from the place the creator actually hit the wall.
     */
    if (!isUsableIdentityAsset(useEditorStore.getState().doc?.assets[assetId])) {
      setBusy("repair");
      setError(null);
      try {
        const result = await repairAssetTransparency([assetId]);
        if (result.failed > 0) {
          setError("That image still has no usable cut-out. Try uploading or generating a reference instead.");
          return;
        }
      } catch {
        setError("That image could not be prepared. Try uploading or generating a reference instead.");
        return;
      } finally {
        setBusy(null);
      }
    }
    onResolved?.();
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy("upload");
    setError(null);
    try {
      /**
       * Attached to the EXISTING character, never a new one. Creating a second
       * "Mori" while repairing the first is how a library quietly forks.
       */
      const assetId = await uploadImageFile(file, "character", {
        name: `${reference.characterName} reference`,
        metadata: { characterId: reference.characterId, characterAssetRole: "canonical" },
      });
      dispatch({ type: "set-character-reference", characterId: reference.characterId, assetId });
      onResolved?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That image could not be uploaded");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-md p-2" style={{ background: "var(--bg-app)" }}>
      <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-primary)" }}>
        <AlertIcon size={12} strokeWidth={2.25} style={{ color: "var(--warning)" }} />
        {reference.characterName}
      </span>
      <p className="mt-0.5 text-[10px] leading-4" style={{ color: "var(--text-muted)" }}>
        {reference.reason}
      </p>

      <div className="mt-1.5 flex flex-wrap gap-1">
        <button
          className="rounded-md px-2 py-1 text-[10px] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
          style={{ background: "var(--bg-elevated)", color: "var(--text-primary)" }}
          disabled={existing.length === 0 || busy !== null}
          title={existing.length === 0 ? `${reference.characterName} has no images yet` : undefined}
          onClick={() => setChoosing((open) => !open)}
        >
          {choosing ? "Cancel" : "Choose Existing"}
        </button>
        <button
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
          style={{ background: "var(--bg-elevated)", color: "var(--text-primary)" }}
          disabled={busy !== null}
          onClick={() => fileInput.current?.click()}
        >
          {busy === "upload" || busy === "repair" ? (
            <SpinnerIcon size={11} strokeWidth={2} className="animate-spin" />
          ) : (
            <UploadIcon size={11} strokeWidth={ICON_STROKE} />
          )}
          Upload Reference
        </button>
        <button
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors hover:bg-[var(--accent)] hover:text-white"
          style={{ background: "var(--accent-soft)", color: "var(--accent-text)" }}
          disabled={busy !== null}
          onClick={() =>
            openGenerator({
              assetType: "character",
              characterId: reference.characterId,
              prefill: { pose: "standing", expression: "neutral", view: "front" },
            })
          }
        >
          <GenerateIcon size={11} strokeWidth={ICON_STROKE} />
          Generate Reference
        </button>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => void upload(event.target.files?.[0])}
      />

      {choosing && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {existing.map((asset) => (
            <button
              key={asset.id}
              className="relative h-16 w-16 overflow-hidden rounded border transition-colors hover:border-[var(--accent)]"
              style={{ borderColor: isUsableIdentityAsset(asset) ? "var(--border-subtle)" : "var(--warning)" }}
              title={isUsableIdentityAsset(asset) ? asset.name : `${asset.name} — needs its cut-out finishing, which this will do`}
              onClick={() => void choose(asset.id)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={assetPreviewUrl(asset)} alt={asset.name} className="h-full w-full object-contain" />
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-1 text-[10px]" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
