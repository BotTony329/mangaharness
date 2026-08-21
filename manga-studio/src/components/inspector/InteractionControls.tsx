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
import {
  INTERACTION_LABELS,
  evaluateInteractionCapability,
  midpointAnchor,
} from "@/domain/interactions";
import { stateFromInstance } from "@/characters/state";
import type { AssetInstance, ID, InteractionType, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";

/** The interactions offered as one-click actions, in order of usefulness. */
const QUICK: InteractionType[] = ["look_at", "hold_hands", "hug", "walk_together", "high_five"];
const MORE: InteractionType[] = ["beside", "face_to_face", "hand_object", "lean_on", "sit_together"];

export function InteractionControls({ item }: { item: AssetInstance }) {
  const doc = useEditorStore((s) => s.doc)!;
  const selection = useEditorStore((s) => s.selection);
  const dispatch = useEditorStore((s) => s.dispatch);
  const openInteraction = useUiStore((s) => s.openInteraction);
  const [showMore, setShowMore] = useState(false);
  const [pending, setPending] = useState<InteractionType | null>(null);

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

  const start = (type: InteractionType, partnerCharacterId?: ID) => {
    const partnerId = partnerCharacterId ?? preselected[0];
    if (!partnerId) {
      setPending(type);
      return;
    }
    setPending(null);
    const partnerItem =
      alsoSelected.find((candidate) => characterOf(doc, candidate) === partnerId) ??
      partners.find((entry) => entry.characterId === partnerId)?.item;

    const capability = evaluateInteractionCapability({
      type,
      participantIds: [subject, partnerId],
      puppets: [puppetForInstance(doc, item), partnerItem ? puppetForInstance(doc, partnerItem) : undefined],
    });

    const created = dispatch({
      type: "create-interaction",
      input: {
        panelId: item.panelId,
        participantIds: [subject, partnerId],
        type,
        roles: { subject, target: partnerId },
        renderMode: capability.supportedLocally ? "synchronized" : "composite",
        status: capability.supportedLocally ? "active" : "planned",
      },
    });

    /**
     * A locally supported contact interaction gets its shared anchor straight
     * away — that shared point IS the interaction, and creating it later would
     * leave a window where the record exists but means nothing.
     */
    if (capability.mode === "LOCAL_PUPPET" && partnerItem && created.createdId && needsAnchor(type)) {
      dispatch({
        type: "set-interaction-anchor",
        interactionId: created.createdId,
        anchor: midpointAnchor(item, partnerItem, { [subject]: "rightHand", [partnerId]: "leftHand" }),
      });
    }

    // Anything generative goes to the review dialog rather than silently
    // replacing the actors that are already on the page.
    if (!capability.supportedLocally && created.createdId) {
      openInteraction({ interactionId: created.createdId });
    }
  };

  const button = (type: InteractionType) => {
    const partnerId = preselected[0] ?? partners[0]?.characterId;
    const capability = partnerId
      ? evaluateInteractionCapability({
          type,
          participantIds: [subject, partnerId],
          puppets: [puppetForInstance(doc, item), undefined],
        })
      : null;
    const instant = capability?.supportedLocally ?? false;
    return (
      <button
        key={type}
        className="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-indigo-500 hover:text-indigo-200"
        onClick={() => start(type)}
        title={instant ? "Instant — no generation" : "Needs AI generation"}
      >
        {INTERACTION_LABELS[type]}
        <span className={instant ? "text-[8px] text-emerald-400" : "text-[8px] text-amber-400"}>
          {instant ? "Instant" : "Generate"}
        </span>
      </button>
    );
  };

  if (partners.length === 0 && preselected.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5">
        <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Interactions</p>
        <p className="text-[10px] leading-4 text-zinc-600">
          Place another character in this panel, then pick an action here — or shift-click both on canvas.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-indigo-950/20 p-2.5">
      <div className="mb-1.5 flex items-baseline justify-between">
        <p className="text-[10px] uppercase tracking-wider text-indigo-300">Interactions</p>
        {preselected.length > 0 && (
          <span className="text-[9px] text-zinc-500">
            with {doc.characters[preselected[0]]?.name}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1">{QUICK.map(button)}</div>
      {showMore && <div className="mt-1 flex flex-wrap gap-1">{MORE.map(button)}</div>}
      <button
        className="mt-1 text-[10px] text-zinc-500 hover:text-zinc-300"
        onClick={() => setShowMore((open) => !open)}
      >
        {showMore ? "Less" : "More…"}
      </button>

      {/* Partner picker, only when the creator has not already selected one. */}
      {pending && (
        <div className="mt-2 rounded border border-zinc-700 bg-zinc-900 p-2">
          <p className="mb-1 text-[10px] text-zinc-400">{INTERACTION_LABELS[pending]} with…</p>
          <div className="flex flex-wrap gap-1">
            {partners.map((partner) => (
              <button
                key={partner.item.id}
                className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-indigo-500"
                onClick={() => start(pending, partner.characterId)}
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

/** Contact interactions are realised by a shared anchor; the rest are placement. */
function needsAnchor(type: InteractionType): boolean {
  return type === "hold_hands" || type === "high_five" || type === "hand_object";
}

function characterOf(doc: ProjectDocument, item: AssetInstance): ID | undefined {
  return stateFromInstance(doc, item)?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId;
}
