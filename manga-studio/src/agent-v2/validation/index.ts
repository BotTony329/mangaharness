"use client";

import { validateScopeIntegrity, type CompositionIssue } from "@/domain/compositionValidation";
import type { Character, ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { charactersInAsset } from "@/domain/interactions";
import { type AgentPlan, type ToolName } from "@/agent/tools/schemas";
import { resolveDepthPlacements } from "@/agent/cameraIntent";
import type { SequencePlan } from "@/agent/sequencePlan";
import type { RunContext } from "../types";

export function validatePlanResult(ctx: RunContext, plan: AgentPlan, before: ProjectDocument): CompositionIssue[] {
  const state = useEditorStore.getState();
  const page = state.currentPageId ? ctx.currentDoc().pages[state.currentPageId] : undefined;
  if (!page) return [];
  const panelNumbers = new Set<number>();
  for (const step of plan.steps) {
    const panel = step.tool === "reuse_scene_background" ? step.args.targetPanel : step.args.panel;
    if (typeof panel === "number") panelNumbers.add(panel);
  }
  const panelIds = panelNumbers.size > 0
    ? [...panelNumbers].map((number) => page.panelIds[number - 1]).filter((id): id is ID => Boolean(id))
    : plan.targetScope?.kind === "selected-object" || plan.targetScope?.kind === "selected-panel"
      ? [plan.targetScope.panelId].filter((id): id is ID => Boolean(id))
      : page.panelIds;
  const validated = ctx.dispatch({ type: "validate-composition", panelIds, before });
  const after = validated.doc;
  const scopeIssues = plan.targetScope ? validateScopeIntegrity(before, after, plan.targetScope) : [];
  return [...(validated.issues ?? []), ...scopeIssues, ...validateIdentityPostConditions(ctx, plan, before, after)];
}


/**
 * Validate the SEMANTIC plan, not merely that commands ran.
 *
 * A run can execute every step it was given and still have failed the request:
 * both beats in one panel, the dialogue attached to the wrong frame, a camera
 * instruction quietly dropped. These invariants are checked against the
 * document that actually exists, and any breach is fatal — a half-executed
 * sequence is worse than none, because the creator has to work out which half.
 */

/**
 * Validate the SEMANTIC plan, not merely that commands ran.
 *
 * A run can execute every step it was given and still have failed the request:
 * both beats in one panel, the dialogue attached to the wrong frame, a camera
 * instruction quietly dropped. These invariants are checked against the
 * document that actually exists, and any breach is fatal — a half-executed
 * sequence is worse than none, because the creator has to work out which half.
 */
export function validateSequencePostConditions(ctx: RunContext, 
  sequence: SequencePlan,
  before: ProjectDocument,
  after: ProjectDocument,
): CompositionIssue[] {
  const issues: CompositionIssue[] = [];
  const page = after.pages[sequence.pageId];
  if (!page) return issues;

  const panelId = (number: number): ID | undefined => page.panelIds[number - 1];
  const fatal = (code: CompositionIssue["code"], panel: ID | undefined, message: string) =>
    issues.push({ code, panelId: panel ?? page.panelIds[0] ?? "", message, corrected: false, severity: "fatal" });

  // 1. The panels the sequence needs must exist.
  const wanted = new Set(sequence.beats.map((beat) => beat.panelNumber));
  for (const number of wanted) {
    if (!panelId(number)) {
      fatal("required-character-missing", undefined, `Panel ${number} was needed for this sequence but does not exist`);
    }
  }
  if (wanted.size < sequence.requiredPanelCount) {
    fatal("required-character-missing", undefined, `The request needed ${sequence.requiredPanelCount} separate moments but only ${wanted.size} panels were used`);
  }

  for (const beat of sequence.beats) {
    const id = panelId(beat.panelNumber);
    if (!id) continue;
    const panel = after.panels[id];
    const items = (panel?.itemIds ?? []).map((itemId) => after.items[itemId]);

    // 2. Every subject is actually in its beat's panel.
    for (const characterId of beat.subjects) {
      const present = items.some((item) => {
        if (item?.kind !== "asset") return false;
        const owner = item.characterState?.characterId ?? after.assets[item.sourceAssetId]?.metadata?.characterId;
        return owner === characterId || charactersInAsset(after, item.sourceAssetId).includes(characterId);
      });
      if (!present) {
        fatal("required-character-missing", id, `${after.characters[characterId]?.name ?? characterId} is missing from panel ${beat.panelNumber}`);
      }
    }

    // 3. Dialogue exists, in the right panel, with the right words.
    if (beat.dialogue) {
      const bubble = items.find((item) => item?.kind === "bubble" && item.text.trim() === beat.dialogue!.text.trim());
      if (!bubble) {
        fatal("required-character-missing", id, `The line “${beat.dialogue.text}” is not in panel ${beat.panelNumber}`);
      }
    }

    // 4. Camera intent reached the document.
    if (beat.camera) {
      const camera = panel?.camera;
      if (beat.camera.shot && camera?.shot !== beat.camera.shot) {
        fatal("scope-integrity", id, `Panel ${beat.panelNumber} should be a ${beat.camera.shot.replace(/-/g, " ")} shot`);
      }
      if (beat.camera.angle && camera?.angle !== beat.camera.angle) {
        fatal("scope-integrity", id, `Panel ${beat.panelNumber} should be a ${beat.camera.angle.replace(/-/g, " ")} angle`);
      }
      if (beat.camera.lens && camera?.lens !== beat.camera.lens) {
        fatal("scope-integrity", id, `Panel ${beat.panelNumber} should use the ${beat.camera.lens} lens`);
      }
      if (beat.camera.perspective && panel?.perspective?.type !== beat.camera.perspective) {
        fatal("scope-integrity", id, `Panel ${beat.panelNumber} should use ${beat.camera.perspective.replace(/-/g, " ")} perspective`);
      }

      /**
       * Depth is checked as ORDER, not as a number: the request said who is in
       * front, and only the relative result is a promise we made.
       */
      const depthOf = (characterId: ID): number | undefined => {
        const item = items.find((entry) => {
          if (entry?.kind !== "asset") return false;
          const owner = entry.characterState?.characterId ?? after.assets[entry.sourceAssetId]?.metadata?.characterId;
          return owner === characterId;
        });
        return item?.kind === "asset" ? item.stage?.depth : undefined;
      };
      for (const relation of beat.camera.relations ?? []) {
        const near = depthOf(relation.nearerCharacterId);
        const far = depthOf(relation.fartherCharacterId);
        if (near !== undefined && far !== undefined && near > far) {
          fatal(
            "scope-integrity",
            id,
            `${after.characters[relation.nearerCharacterId]?.name ?? "one character"} should be nearer the camera than ${after.characters[relation.fartherCharacterId]?.name ?? "the other"}`,
          );
        }
      }
      for (const placement of resolveDepthPlacements(beat.camera)) {
        const item = items.find((entry) => {
          if (entry?.kind !== "asset") return false;
          const owner = entry.characterState?.characterId ?? after.assets[entry.sourceAssetId]?.metadata?.characterId;
          return owner === placement.characterId;
        });
        if (item?.kind === "asset" && item.stage && placement.placement === "foreground" && item.stage.depth > 0.5) {
          fatal("scope-integrity", id, `${after.characters[placement.characterId]?.name ?? "a character"} should be in the foreground of panel ${beat.panelNumber}`);
        }
      }
    }
  }

  /**
   * 5. Panels the sequence never mentioned keep their content. Growing a layout
   * is allowed to move items between panel records, so this compares the SET of
   * items on the page rather than per-panel membership.
   */
  const beforeItems = new Set(
    (before.pages[sequence.pageId]?.panelIds ?? []).flatMap((id) => before.panels[id]?.itemIds ?? []),
  );
  const afterItems = new Set(page.panelIds.flatMap((id) => after.panels[id]?.itemIds ?? []));
  const lost = [...beforeItems].filter((id) => !afterItems.has(id));
  if (lost.length > 0) {
    fatal("unexpected-deletion", undefined, `${lost.length} existing item${lost.length !== 1 ? "s" : ""} disappeared while laying out the sequence`);
  }

  return issues;
}

/**
 * Post-condition validation (§15): check the DOCUMENT, not the return value.
 *
 * "Place Yuri in Panel 2" is only satisfied when panel 2 actually contains an
 * instance whose characterId is Yuri's. A command that returned success while
 * placing someone else — the exact production failure — is reported here as a
 * run failure rather than passing silently.
 */

/**
 * Post-condition validation (§15): check the DOCUMENT, not the return value.
 *
 * "Place Yuri in Panel 2" is only satisfied when panel 2 actually contains an
 * instance whose characterId is Yuri's. A command that returned success while
 * placing someone else — the exact production failure — is reported here as a
 * run failure rather than passing silently.
 */
export function validateIdentityPostConditions(ctx: RunContext, 
  plan: AgentPlan,
  before: ProjectDocument,
  after: ProjectDocument,
): CompositionIssue[] {
  const issues: CompositionIssue[] = [];
  const page = after.pages[plan.targetScope?.pageId ?? ""] ?? null;

  const PLACEMENT_TOOLS = new Set<ToolName>(["place_character", "compose_character", "place_asset"]);
  for (const step of plan.steps) {
    if (!PLACEMENT_TOOLS.has(step.tool)) continue;
    const characterId = step.args.characterId;
    const panelNumber = step.args.panel;
    if (typeof characterId !== "string" || typeof panelNumber !== "number") continue;
    if (step.args.target === "workspace") continue;
    const panelId = page?.panelIds[panelNumber - 1];
    if (!panelId) continue;
    const present = (after.panels[panelId]?.itemIds ?? []).some((itemId) => {
      const item = after.items[itemId];
      if (item?.kind !== "asset") return false;
      const owner = item.characterState?.characterId ?? after.assets[item.sourceAssetId]?.metadata?.characterId;
      return owner === characterId;
    });
    if (!present) {
      issues.push({
        code: "identity-mismatch",
        panelId,
        message: `${after.characters[characterId]?.name ?? characterId} was requested in panel ${panelNumber} but is not there`,
        corrected: false,
        severity: "fatal",
      });
    }
  }

  /**
   * An interaction must be VISIBLE, not merely recorded.
   *
   * `create_interaction` succeeds if the document gained an Interaction record,
   * but a hug nobody can see in the panel is a failed hug. Both participants
   * must be represented — either as their own instances (local/synchronized) or
   * inside one joint render that provenance says contains them both.
   */
  for (const step of plan.steps) {
    if (step.tool !== "create_interaction") continue;
    const panelNumber = step.args.panel;
    const panelId = typeof panelNumber === "number" ? page?.panelIds[panelNumber - 1] : undefined;
    if (!panelId) continue;
    const present = new Set(
      (after.panels[panelId]?.itemIds ?? []).flatMap((itemId) => {
        const item = after.items[itemId];
        if (item?.kind !== "asset") return [];
        const owner = item.characterState?.characterId;
        return owner ? [owner] : charactersInAsset(after, item.sourceAssetId);
      }),
    );
    for (const key of ["subjectCharacterId", "targetCharacterId"] as const) {
      const characterId = step.args[key];
      if (typeof characterId !== "string" || present.has(characterId)) continue;
      issues.push({
        code: "interaction-participant-missing",
        panelId,
        message: `${after.characters[characterId]?.name ?? characterId} is missing from the ${String(step.args.interaction).replace(/_/g, " ")} in panel ${panelNumber}`,
        corrected: false,
        severity: "fatal",
      });
    }
  }

  /**
   * Nothing that already existed may vanish unless removal was the request.
   *
   * This is the failure that prompted the rule: a run asked to add an
   * interaction wiped a finished panel and still reported success. Additive
   * work must stay additive, inside the target panel as well as outside it.
   */
  const removalRequested = plan.steps.some(
    (step) => step.tool === "remove_items" || step.tool === "set_page_layout",
  );
  if (!removalRequested) {
    for (const panelId of page?.panelIds ?? []) {
      const survivors = new Set(after.panels[panelId]?.itemIds ?? []);
      const lost = (before.panels[panelId]?.itemIds ?? []).filter((id) => !survivors.has(id));
      /**
       * A composite interaction legitimately retires the individual sprites it
       * replaced; those characters are still on the page, inside the joint
       * render. Anything else that disappeared was destroyed.
       */
      const destroyed = lost.filter((itemId) => {
        const item = before.items[itemId];
        if (item?.kind !== "asset") return true;
        const owner = item.characterState?.characterId ?? before.assets[item.sourceAssetId]?.metadata?.characterId;
        if (!owner) return true;
        return !(after.panels[panelId]?.itemIds ?? []).some((survivorId) => {
          const survivor = after.items[survivorId];
          return survivor?.kind === "asset" && charactersInAsset(after, survivor.sourceAssetId).includes(owner);
        });
      });
      if (destroyed.length > 0) {
        issues.push({
          code: "unexpected-deletion",
          panelId,
          message: `${destroyed.length} existing item${destroyed.length !== 1 ? "s" : ""} disappeared from a panel this run was only meant to add to`,
          corrected: false,
          severity: "fatal",
        });
      }
    }
  }

  /**
   * No persistent Character may appear that this run was not authorized to
   * create. This catches creation through any path, not just create_character.
   */
  const authorized = new Set(ctx.createdCharacterIds);
  for (const id of Object.keys(after.characters)) {
    if (before.characters[id] || authorized.has(id)) continue;
    issues.push({
      code: "unauthorized-character-creation",
      panelId: plan.targetScope?.panelId ?? page?.panelIds[0] ?? "",
      message: `A new Character "${after.characters[id]?.name ?? id}" was created without authorization`,
      corrected: false,
      severity: "fatal",
    });
  }
  return issues;
}

// ─── Virtual manga stage (§18) ──────────────────────────────────────────────
// The model states intent; these handlers convert it into panel geometry. The
// LLM never computes coordinates.
