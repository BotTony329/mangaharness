/**
 * Deterministic verifier — the Creative Director is never trusted.
 *
 * After a run, every claim the Task Map made is checked against the document:
 * participants exist, beat actors are actually in their panels, quoted
 * dialogue is byte-identical in a real bubble, the requested scene exists,
 * and nothing outside the target scope moved. No LLM judgment is involved.
 */

import type { ID, ProjectDocument, SpeechBubbleItem } from "@/domain/types";
import type { CreativeTaskMap } from "../contract/creativeTaskMap";
import type { Resolution } from "../resolution/entityResolver";

export interface VerificationIssue {
  kind:
    | "participant_missing"
    | "actor_not_in_panel"
    | "dialogue_missing"
    | "scene_missing"
    | "scope_violation"
    | "fake_identity";
  message: string;
}

export interface VerificationResult {
  issues: VerificationIssue[];
  /** Fatal means the run result cannot be presented as success. */
  fatal: boolean;
}

/** Cheap structural fingerprint of one panel and everything on it. */
function panelFingerprint(doc: ProjectDocument, panelId: ID): string {
  const panel = doc.panels[panelId];
  if (!panel) return "<absent>";
  const items = panel.itemIds.map((id) => doc.items[id]);
  return JSON.stringify({ panel, items });
}

export function panelScopeFingerprints(doc: ProjectDocument): Map<ID, string> {
  const map = new Map<ID, string>();
  for (const panelId of Object.keys(doc.panels)) map.set(panelId, panelFingerprint(doc, panelId));
  return map;
}

export function verifyTaskMap(
  map: CreativeTaskMap,
  resolution: Resolution,
  before: ProjectDocument,
  after: ProjectDocument,
  beforeFingerprints: Map<ID, string>,
  currentPageId: ID | null,
): VerificationResult {
  const issues: VerificationIssue[] = [];

  // Every declared participant must resolve to a real character record.
  // A "create" binding has no ID at resolution time — re-resolve by name
  // against the AFTER document; the harness never invents identity.
  const resolvedCharacterId = (name: string, bindingCharacterId?: ID): ID | undefined => {
    if (bindingCharacterId && after.characters[bindingCharacterId]) return bindingCharacterId;
    const wanted = name.trim().toLowerCase();
    return Object.values(after.characters).find((c) => c.name.trim().toLowerCase() === wanted)?.id;
  };
  for (const [name, binding] of resolution.participants) {
    if (!resolvedCharacterId(name, binding.characterId)) {
      issues.push({ kind: "participant_missing", message: `${name} has no real character after the run` });
    }
  }

  // Beat actors must be present in their beat's panel.
  const pagePanelIds = currentPageId ? (after.pages[currentPageId]?.panelIds ?? []) : [];
  const targetPanelIds =
    map.target.scope === "selected_panel" && typeof map.target.panel === "number"
      ? panelIdsByIndex(after, [map.target.panel], pagePanelIds)
      : map.target.scope === "whole_project"
        ? map.beats.flatMap((b) => (typeof b.panel === "number" ? panelIdsByIndex(after, [b.panel], pagePanelIds) : []))
        : pagePanelIds;

  for (const beat of map.beats) {
    const actorId = resolvedCharacterId(beat.actor, resolution.participants.get(beat.actor)?.characterId);
    if (!actorId) continue;
    const beatPanelIds = typeof beat.panel === "number" ? panelIdsByIndex(after, [beat.panel], pagePanelIds) : targetPanelIds;
    const placed = beatPanelIds.some((panelId) => panelHasCharacter(after, panelId, actorId));
    if (!placed) {
      issues.push({ kind: "actor_not_in_panel", message: `${beat.actor} is not present in their beat panel` });
    }

    // Quoted dialogue must appear byte-for-byte in a real bubble.
    if (beat.dialogue) {
      const found = Object.values(after.items).some(
        (item) => item.kind === "bubble" && (item as SpeechBubbleItem).text === beat.dialogue,
      );
      if (!found) {
        issues.push({ kind: "dialogue_missing", message: `Dialogue "${beat.dialogue}" is not in any bubble` });
      }
    }
  }

  // A requested new scene must exist in the library after the run (created
  // scenes are bound at execution time, so verify against the AFTER document).
  if (map.scene && !resolution.sceneAssetId) {
    const wanted = map.scene.description.trim().toLowerCase();
    const exists = Object.values(after.assets).some(
      (a) =>
        a.category === "background" &&
        (a.name.trim().toLowerCase() === wanted || (a.metadata?.prompt ?? "").toLowerCase().includes(wanted.slice(0, 40))),
    );
    if (!exists) {
      issues.push({ kind: "scene_missing", message: `Scene "${map.scene.description}" was not created` });
    }
  }

  // Panels outside the target scope must be untouched.
  const scopeSet = new Set(targetPanelIds);
  for (const [panelId, fingerprint] of beforeFingerprints) {
    if (scopeSet.has(panelId)) continue;
    if (panelFingerprint(after, panelId) !== fingerprint) {
      issues.push({ kind: "scope_violation", message: `Panel ${panelId} changed outside the target scope` });
    }
  }

  // No asset may claim a character identity that does not exist.
  for (const asset of Object.values(after.assets)) {
    const characterId = asset.metadata?.characterId;
    if (characterId && !after.characters[characterId]) {
      issues.push({ kind: "fake_identity", message: `Asset ${asset.id} claims unknown character ${characterId}` });
    }
  }

  return { issues, fatal: issues.length > 0 };
}

function panelIdsByIndex(doc: ProjectDocument, indexes: number[], pagePanelIds: ID[]): ID[] {
  return indexes.map((i) => pagePanelIds[i - 1]).filter((id): id is ID => Boolean(id));
}

function panelHasCharacter(doc: ProjectDocument, panelId: ID, characterId: ID): boolean {
  const panel = doc.panels[panelId];
  if (!panel) return false;
  return panel.itemIds.some((id) => {
    const item = doc.items[id];
    if (item?.kind !== "asset") return false;
    return (
      item.characterState?.characterId === characterId ||
      doc.assets[item.sourceAssetId]?.metadata?.characterId === characterId
    );
  });
}
