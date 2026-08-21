"use client";

/**
 * Interactions, made reachable.
 *
 * The domain model has supported coordinated multi-character actions for a
 * while, and a creator had no way to find it: there was no button anywhere that
 * created a `CharacterInteraction`. This is that surface.
 *
 * Two entry points, deliberately:
 *
 *   - one character selected → pick an interaction, then pick a partner;
 *   - two characters selected → the actions appear directly, which is faster.
 *
 * Relationship metadata is NOT a prerequisite. Relationships improve Agent
 * grounding ("her best friend"); they have nothing to do with two actors the
 * creator has already selected on canvas.
 *
 * Creator-facing language only: an interaction is "Instant" or it "Generates".
 * `LOCAL_PUPPET` and `JOINT_GENERATION` are our words, not theirs.
 */

import { useState } from "react";
import { puppetForInstance } from "@/domain/puppetOps";
import { executeInteraction } from "@/services/interaction";
import { resolveIdentityReferences, type IdentityReference } from "@/characters/identityReference";
import { IdentityReferenceRepair } from "./IdentityReferenceRepair";
import { INTERACTION_LABELS, evaluateInteractionCapability } from "@/domain/interactions";
import { GenerateIcon, SpinnerIcon } from "../ui/icons";
import type { AssetInstance, ID, InteractionType, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { characterIdOfInstance } from "@/characters/identity";

/** The interactions offered as one-click actions, in order of usefulness. */
const QUICK: InteractionType[] = ["look_at", "hold_hands", "hug", "walk_together", "high_five"];
const MORE: InteractionType[] = ["beside", "face_to_face", "hand_object", "lean_on", "sit_together"];

export function InteractionControls({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((s) => s.doc)!;
  const selection = useEditorStore((s) => s.selection);
  const [showMore, setShowMore] = useState(false);
  const [pending, setPending] = useState<InteractionType | null>(null);
  const [busy, setBusy] = useState<InteractionType | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when a joint action stopped because somebody has no reference image. */
  const [repair, setRepair] = useState<{ action: string; references: IdentityReference[] } | null>(null);

  const subject = characterOf(doc, item);
  if (!subject) return null;

  /** Other character actors in the same panel — the possible partners. */
  const partners = (doc.panels[item.panelId]?.itemIds ?? [])
    .map((id) => doc.items[id])
    .filter((candidate): candidate is AssetInstance => candidate?.kind === "asset" && candidate.id !== item.id)
    .map((candidate) => ({ item: candidate, characterId: characterOf(doc, candidate) }))
    .filter((entry): entry is { item: AssetInstance; characterId: ID } => Boolean(entry.characterId));

  // Shift-selecting a second actor is the fast path: no partner picker needed.
  const alsoSelected = (selection.alsoItemIds ?? [])
    .map((id) => doc.items[id])
    .filter((candidate): candidate is AssetInstance => candidate?.kind === "asset");
  const preselected = alsoSelected.map((candidate) => characterOf(doc, candidate)).filter(Boolean) as ID[];

  const start = async (type: InteractionType, partnerCharacterId?: ID) => {
    const partnerId = partnerCharacterId ?? preselected[0];
    if (!partnerId) {
      setPending(type);
      return;
    }
    setPending(null);
    setBusy(type);
    setError(null);
    setRepair(null);
    try {
      /**
       * Check identity BEFORE spending anything.
       *
       * A joint render needs one clear picture of each participant. Finding
       * that out from a failed generation gives the creator an error; finding
       * it out here gives them a repair card with the missing name on it.
       */
      const capability = evaluateInteractionCapability({
        type,
        participantIds: [subject, partnerId],
        puppets: [puppetForInstance(doc, item), partnerItemFor(doc, partnerId, item.panelId)],
      });
      if (!capability.supportedLocally) {
        const references = resolveIdentityReferences(doc, [subject, partnerId]);
        if (references.some((reference) => reference.status !== "resolved")) {
          setRepair({ action: INTERACTION_LABELS[type], references });
          setBusy(null);
          return;
        }
      }

      /**
       * ONE execution path.
       *
       * This surface used to create the interaction itself — its own capability
       * check, its own dispatch, its own anchor — while the Agent went through
       * `interactionService`. Two implementations of "what a hug is" drift, and
       * the creator gets a different result depending on how they asked.
       * Everything now goes through the service.
       */
      const outcome = await executeInteraction({
        panelId: item.panelId,
        participantIds: [subject, partnerId],
        type,
      });
      if (outcome.placedItemId) {
        useEditorStore.getState().select({ itemId: outcome.placedItemId, panelId: item.panelId });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The interaction could not be created");
    } finally {
      setBusy(null);
    }
  };

  /**
   * Instant or Generate, decided by the SAME evaluator the service uses.
   *
   * A creator must be able to see the cost before clicking. "Instant" means the
   * harness rearranges artwork it already has; "Generate" means new pixels and
   * a real provider call.
   */
  const button = (type: InteractionType) => {
    const partnerId = preselected[0] ?? partners[0]?.characterId;
    const partnerItem =
      alsoSelected.find((candidate) => characterOf(doc, candidate) === partnerId) ??
      partners.find((entry) => entry.characterId === partnerId)?.item;
    const capability = partnerId
      ? evaluateInteractionCapability({
          type,
          participantIds: [subject, partnerId],
          puppets: [puppetForInstance(doc, item), partnerItem ? puppetForInstance(doc, partnerItem) : undefined],
        })
      : null;
    const instant = capability?.supportedLocally ?? false;
    const running = busy === type;
    return (
      <button
        key={type}
        disabled={busy !== null}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] transition-colors disabled:opacity-40"
        style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
        onClick={() => void start(type)}
        title={
          instant
            ? `${INTERACTION_LABELS[type]} — instant, no generation`
            : `${INTERACTION_LABELS[type]} — ${capability?.reason ?? "needs one AI generation"}`
        }
      >
        {INTERACTION_LABELS[type]}
        {running ? (
          <SpinnerIcon size={10} strokeWidth={2} className="animate-spin" style={{ color: "var(--accent-text)" }} />
        ) : instant ? (
          <span className="text-[8px]" style={{ color: "var(--success)" }}>
            Instant
          </span>
        ) : (
          <span className="flex items-center gap-0.5 text-[8px]" style={{ color: "var(--accent-text)" }}>
            <GenerateIcon size={8} strokeWidth={2.5} />
            Generate
          </span>
        )}
      </button>
    );
  };

  if (partners.length === 0 && preselected.length === 0) {
    return (
      <div className="rounded-lg p-2.5" style={{ background: "var(--bg-elevated)" }}>
        <p className="mb-1 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          Interactions
        </p>
        <p className="text-[10px] leading-4" style={{ color: "var(--text-muted)" }}>
          Place another character in this panel, then pick an action here — or shift-click both on canvas.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-[var(--bg-elevated)] p-2.5">
      <div className="mb-1.5 flex items-baseline justify-between">
        <p className="text-[10px] uppercase tracking-wider text-[var(--accent-text)]">Interactions</p>
        {preselected.length > 0 && (
          <span className="text-[9px] text-zinc-500">
            with {doc.characters[preselected[0]]?.name}
          </span>
        )}
      </div>

      {preselected.length > 0 && (
        <p className="mb-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
          Pick an action for {doc.characters[subject]?.name} and {doc.characters[preselected[0]]?.name}.
        </p>
      )}
      <div className="flex flex-wrap gap-1">{QUICK.map(button)}</div>
      {showMore && <div className="mt-1 flex flex-wrap gap-1">{MORE.map(button)}</div>}
      <button
        className="mt-1 text-[10px] text-zinc-500 hover:text-zinc-300"
        onClick={() => setShowMore((open) => !open)}
      >
        {showMore ? "Less" : "More…"}
      </button>

      {repair && (
        <div className="mt-2">
          <IdentityReferenceRepair
            references={repair.references}
            action={repair.action}
            onResolved={() => setRepair(null)}
          />
        </div>
      )}

      {error && (
        <p className="mt-1.5 rounded-md p-1.5 text-[10px]" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
          {error}
        </p>
      )}

      {/* Partner picker, only when the creator has not already selected one. */}
      {pending && (
        <div className="mt-2 rounded-md p-2" style={{ background: "var(--bg-app)" }}>
          <p className="mb-1 text-[10px]" style={{ color: "var(--text-secondary)" }}>
            {INTERACTION_LABELS[pending]} with…
          </p>
          <div className="flex flex-wrap gap-1">
            {partners.map((partner) => (
              <button
                key={partner.item.id}
                className="rounded-md px-2 py-1 text-[10px] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-text)]"
                style={{ background: "var(--bg-elevated)", color: "var(--text-primary)" }}
                onClick={() => void start(pending, partner.characterId)}
              >
                {doc.characters[partner.characterId]?.name}
              </button>
            ))}
            <button className="px-1 text-[10px] text-zinc-500 hover:text-zinc-300" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


/** The partner's placed instance in this panel, when they have one. */
function partnerItemFor(doc: ProjectDocument, characterId: ID, panelId: ID) {
  const item = (doc.panels[panelId]?.itemIds ?? [])
    .map((id) => doc.items[id])
    .find((candidate): candidate is AssetInstance => candidate?.kind === "asset" && characterOf(doc, candidate) === characterId);
  return item ? puppetForInstance(doc, item) : undefined;
}

function characterOf(doc: ProjectDocument, item: AssetInstance): ID | undefined {
  return characterIdOfInstance(doc, item);
}
