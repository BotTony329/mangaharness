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
import { INTERACTION_LABELS, evaluateInteractionCapability, interactionLabel, interactionTypeFromPhrase } from "@/domain/interactions";
import { GenerateIcon, SpinnerIcon } from "../ui/icons";
import type { AssetInstance, ID, InteractionType, ProjectDocument, SourceAsset } from "@/domain/types";
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when a joint action stopped because somebody has no reference image. */
  const [repair, setRepair] = useState<{ action: string; references: IdentityReference[] } | null>(null);
  const [description, setDescription] = useState("");
  const [partnerKey, setPartnerKey] = useState<string | null>(null);
  const [keepOriginals, setKeepOriginals] = useState(false);
  const [showCreateAdvanced, setShowCreateAdvanced] = useState(false);

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

  /**
   * A PROP or BACKGROUND in the panel is also a partner — the v0.2 contract.
   * What the creator can DO with it comes from its declared affordances/zones,
   * never from a name guess ("ramen" → eat would be exactly that). A
   * shift-selected asset wins; otherwise every prop/background in the panel is
   * offered directly, so a lone character in a scene is never a dead end.
   */
  const assetPartners = (() => {
    const seen = new Set<ID>();
    const items = [...alsoSelected, ...(doc.panels[item.panelId]?.itemIds ?? []).map((id) => doc.items[id])];
    const partners: { assetId: ID; name: string; kind: "object" | "scene"; verbs: string[] }[] = [];
    for (const candidate of items) {
      if (candidate?.kind !== "asset" || candidate.id === item.id || characterOf(doc, candidate)) continue;
      const asset = doc.assets[candidate.sourceAssetId];
      if (!asset || seen.has(asset.id)) continue;
      const kind = asset.category === "prop" ? ("object" as const) : asset.category === "background" ? ("scene" as const) : null;
      if (!kind) continue;
      seen.add(asset.id);
      partners.push({ assetId: asset.id, name: asset.name, kind, verbs: verbsFor(asset, kind) });
    }
    return partners;
  })();

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

  const startAsset = async (verb: string, partner: { assetId: ID; kind: "object" | "scene" }) => {
    setBusy(`${partner.assetId}:${verb}`);
    setError(null);
    setRepair(null);
    try {
      /**
       * Same ONE execution path as character pairs — the service resolves the
       * strategy (objects and scenes always mean GENERATE) and carries the
       * asset's own image as a reference, so the bowl of ramen in the render
       * is THIS bowl, not a re-invented one.
       */
      const outcome = await executeInteraction({
        panelId: item.panelId,
        participantIds: [subject],
        participants: [
          { id: subject, kind: "character", role: "initiator" },
          { id: partner.assetId, kind: partner.kind, role: "target" },
        ],
        type: verb,
        source: "manual",
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
   * Free-text first (v0.2 UX convergence): the creator describes the action in
   * their own words; the structured type is DERIVED from the sentence, never
   * asked for. The sentence itself leads the generation prompt.
   */
  type FreePartner =
    | { key: string; label: string; characterId: ID }
    | { key: string; label: string; assetId: ID; kind: "object" | "scene" };
  /** A shift-selected partner is the only candidate; otherwise every actor,
      prop and background in the panel is on offer. */
  const freeCandidates: FreePartner[] = (() => {
    const characterIds = alsoSelected.length > 0 ? preselected.slice(0, 1) : partners.map((p) => p.characterId);
    const characters: FreePartner[] = characterIds.map((id) => ({
      key: `c:${id}`,
      label: doc.characters[id]?.name ?? id,
      characterId: id,
    }));
    const assets: FreePartner[] = assetPartners
      .filter((partner) => alsoSelected.length === 0 || alsoSelected.some((c) => c.sourceAssetId === partner.assetId))
      .map((partner) => ({ key: `a:${partner.assetId}`, label: partner.name, assetId: partner.assetId, kind: partner.kind }));
    return [...characters, ...assets];
  })();
  const chosen = freeCandidates.find((candidate) => candidate.key === partnerKey) ?? freeCandidates[0];

  const describe = async () => {
    const text = description.trim();
    if (!text || !chosen) return;
    setBusy("custom");
    setError(null);
    setRepair(null);
    try {
      const participants =
        "characterId" in chosen
          ? [
              { id: subject, kind: "character" as const, role: "initiator" },
              { id: chosen.characterId, kind: "character" as const, role: "target" },
            ]
          : [
              { id: subject, kind: "character" as const, role: "initiator" },
              { id: chosen.assetId, kind: chosen.kind, role: "target" },
            ];
      const outcome = await executeInteraction({
        panelId: item.panelId,
        participantIds: participants.map((p) => p.id).filter((id) => doc.characters[id]),
        participants,
        type: interactionTypeFromPhrase(text) ?? text.split(/\s+/).slice(0, 3).join(" ").toLowerCase(),
        parameters: { customInstruction: text },
        source: "manual",
        keepOriginals,
      });
      setDescription("");
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

  if (partners.length === 0 && preselected.length === 0 && assetPartners.length === 0) {
    return (
      <div className="rounded-lg p-2.5" style={{ background: "var(--bg-elevated)" }}>
        <p className="mb-1 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          Interactions
        </p>
        <p className="text-[10px] leading-4" style={{ color: "var(--text-muted)" }}>
          Place another character in this panel, then pick an action here — or shift-click both on canvas. A prop or
          background works too: shift-click it together with the character.
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

      {/* Free-text first: describe the action, pick who it's with, generate.
          Structured types below are quick actions, not the entry fee. */}
      {freeCandidates.length > 0 && (
        <div className="mb-2">
          <p className="mb-1 text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            With
          </p>
          <div className="mb-1.5 flex flex-wrap gap-1">
            {freeCandidates.map((candidate) => (
              <button
                key={candidate.key}
                className="rounded-md px-2 py-0.5 text-[10px] transition-colors"
                style={
                  chosen?.key === candidate.key
                    ? { background: "var(--accent-soft)", color: "var(--accent-text)" }
                    : { background: "var(--bg-app)", color: "var(--text-secondary)" }
                }
                onClick={() => setPartnerKey(candidate.key)}
              >
                {candidate.label}
              </button>
            ))}
          </div>
          <textarea
            className="w-full rounded-md px-2 py-1.5 text-[11px] leading-4"
            style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
            rows={2}
            placeholder={`Describe the interaction… e.g. "${doc.characters[subject]?.name ?? "She"} is entering the scene from the left"`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <button
            className="mt-1 text-[10px] text-zinc-500 hover:text-zinc-300"
            onClick={() => setShowCreateAdvanced((value) => !value)}
          >
            {showCreateAdvanced ? "Advanced ▾" : "Advanced ▸"}
          </button>
          {showCreateAdvanced && (
            <label className="mt-1 flex items-center gap-1.5 text-[10px]" style={{ color: "var(--text-secondary)" }}>
              <input
                type="checkbox"
                checked={keepOriginals}
                onChange={(event) => setKeepOriginals(event.target.checked)}
              />
              Keep originals visible (default: originals are hidden, never deleted)
            </label>
          )}
          <button
            disabled={!description.trim() || busy !== null}
            className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-colors disabled:opacity-40"
            style={{ background: "var(--accent-soft)", color: "var(--accent-text)" }}
            onClick={() => void describe()}
          >
            {busy === "custom" ? (
              <SpinnerIcon size={11} strokeWidth={2} className="animate-spin" />
            ) : (
              <GenerateIcon size={11} strokeWidth={2.5} />
            )}
            Generate Interaction
          </button>
        </div>
      )}

      {/* Quick actions — presets, secondary to describing it yourself. */}
      {assetPartners.map((partner) => (
        <div className="mb-1.5" key={partner.assetId}>
          <p className="mb-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
            {doc.characters[subject]?.name} + {partner.name}
          </p>
          <div className="flex flex-wrap gap-1">
            {partner.verbs.map((verb) => (
              <button
                key={verb}
                disabled={busy !== null}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] transition-colors disabled:opacity-40"
                style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
                onClick={() => void startAsset(verb, partner)}
                title={`${interactionLabel(verb)} — needs one AI generation`}
              >
                {interactionLabel(verb)}
                {busy === `${partner.assetId}:${verb}` ? (
                  <SpinnerIcon size={10} strokeWidth={2} className="animate-spin" style={{ color: "var(--accent-text)" }} />
                ) : (
                  <span className="flex items-center gap-0.5 text-[8px]" style={{ color: "var(--accent-text)" }}>
                    <GenerateIcon size={8} strokeWidth={2.5} />
                    Generate
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}

      {preselected.length > 0 && (
        <p className="mb-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
          Pick an action for {doc.characters[subject]?.name} and {doc.characters[preselected[0]]?.name}.
        </p>
      )}
      {(partners.length > 0 || preselected.length > 0) && (
        <>
          <p className="mb-1 mt-1 text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            Quick actions
          </p>
          <div className="flex flex-wrap gap-1">{QUICK.map(button)}</div>
          {showMore && <div className="mt-1 flex flex-wrap gap-1">{MORE.map(button)}</div>}
          <button
            className="mt-1 text-[10px] text-zinc-500 hover:text-zinc-300"
            onClick={() => setShowMore((open) => !open)}
          >
            {showMore ? "Less" : "More…"}
          </button>
        </>
      )}

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
function verbsFor(asset: SourceAsset, kind: "object" | "scene"): string[] {
  if (kind === "object") return asset.metadata?.affordances?.length ? asset.metadata.affordances : ["hold"];
  const zones = asset.metadata?.zones ?? [];
  const zoneVerbs: Record<string, string> = {
    "driver-seat": "drive",
    "passenger-seat": "ride in",
    chair: "sit on",
    doorway: "stand in",
    desk: "sit at",
    bed: "lie on",
  };
  const verbs = zones.map((zone) => zoneVerbs[zone]).filter(Boolean) as string[];
  return verbs.length > 0 ? verbs : ["enter"];
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
