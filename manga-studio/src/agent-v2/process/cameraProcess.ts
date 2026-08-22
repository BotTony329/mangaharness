"use client";

import type { AssetInstance, ID, ProjectDocument, CameraAngle, CameraLens, PerspectiveType, ShotType } from "@/domain/types";
import { requireCharacter } from "@/agent/resolver";
import { panelPxRect } from "@/domain/docHelpers";
import { isPuppetInstance } from "@/domain/puppetOps";
import type { PuppetJoint } from "@/puppet/model";
import { focalInstance } from "@/domain/stageOps";
import { framingMatchesShot, subjectCoverage } from "@/domain/staging";
import type { RunContext } from "../types";

// ─── Virtual manga stage (§18) ──────────────────────────────────────────────
// The model states intent; these handlers convert it into panel geometry. The
// LLM never computes coordinates.

export function doSetCamera(ctx: RunContext, args: {
  panel: number;
  shot?: ShotType;
  angle?: CameraAngle;
  lens?: CameraLens;
  mangaPerspective?: number;
}): void {
  const panelId = ctx.panelIdByNumber(args.panel);
  const result = ctx.dispatch({
    type: "set-panel-camera",
    panelId,
    patch: {
      shot: args.shot,
      angle: args.angle,
      lens: args.lens,
      mangaPerspectiveStrength: args.mangaPerspective,
    },
  });

  // Verify the geometry, not the metadata (§11). A camera step that stored a
  // value but left the panel unchanged must not report success.
  const camera = result.doc.panels[panelId].camera!;
  if (args.shot) {
    const focal = focalInstance(result.doc, panelId);
    if (focal) {
      const rect = panelPxRect(result.doc, panelId);
      if (!framingMatchesShot(subjectCoverage(focal, rect), args.shot)) {
        throw new Error(`Camera shot "${args.shot}" did not reframe the focal subject`);
      }
    }
  }
  if (args.angle === "dutch" && camera.roll === 0) {
    throw new Error("Dutch angle did not apply any roll");
  }
}

export function doSetPerspective(ctx: RunContext, args: { panel: number; type: PerspectiveType; horizonY?: number }): void {
  const panelId = ctx.panelIdByNumber(args.panel);
  ctx.dispatch({
    type: "set-panel-perspective",
    panelId,
    patch: { type: args.type, horizonY: args.horizonY, visible: args.type !== "none" },
  });
}

/** Characters currently present in a panel — the pronoun context of §13. */

export function doSetCharacterDepth(ctx: RunContext, args: {
  panel: number;
  characterName?: string;
  characterId?: ID;
  placement?: "foreground" | "midground" | "background";
  depth?: number;
  groundY?: number;
}): void {
  const panelId = ctx.panelIdByNumber(args.panel);
  const instance = characterInstanceInPanel(ctx, ctx.currentDoc(), panelId, args);
  const depth = args.placement ? PLACEMENT_DEPTH[args.placement] : args.depth;
  if (depth === undefined) throw new Error("set_character_depth needs a placement or a depth");
  ctx.dispatch({
    type: "set-instance-stage",
    instanceId: instance.id,
    // Releasing the scale lock is what lets depth actually resize a character
    // that was previously framed or hand-resized.
    patch: { depth, groundY: args.groundY, scaleLocked: false },
  });
  // Depth moves the speaker, so any bubble aimed at them follows.
  ctx.dispatch({ type: "refresh-bubble-tails", panelId });
}

export function doSetFocalCharacter(ctx: RunContext, args: { panel: number; characterName: string; characterId?: ID }): void {
  const panelId = ctx.panelIdByNumber(args.panel);
  const instance = characterInstanceInPanel(ctx, ctx.currentDoc(), panelId, args);
  ctx.dispatch({ type: "set-panel-focal-item", panelId, itemId: instance.id });
}

// ─── Manga Puppet: the Agent uses the SAME local operations as the GUI (§17) ──

/**
 * Change a puppet character's face.
 *
 * The Agent reaches for this instead of generate/compose whenever a puppet
 * exists, so "make Yuri shocked" swaps a face rather than redrawing a person.
 * The error names the fallback explicitly rather than silently generating.
 */

/** Characters currently present in a panel — the pronoun context of §13. */
export function panelCharacterIds(ctx: RunContext, doc: ProjectDocument, panelId: ID): ID[] {
  const panel = doc.panels[panelId];
  if (!panel) return [];
  return panel.itemIds
    .map((id) => doc.items[id])
    .filter((item): item is AssetInstance => item?.kind === "asset")
    .map((item) => item.characterState?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId)
    .filter((id): id is ID => Boolean(id));
}

/**
 * Find the character instance a semantic panel operation refers to.
 *
 * Identity comes from the ID grounding bound to the step. When only a name
 * survives, `requireCharacter` refuses ambiguity rather than picking the first
 * plausible character, which is what made "make Yuri shocked" reach Cute Girl.
 */

/**
 * Find the character instance a semantic panel operation refers to.
 *
 * Identity comes from the ID grounding bound to the step. When only a name
 * survives, `requireCharacter` refuses ambiguity rather than picking the first
 * plausible character, which is what made "make Yuri shocked" reach Cute Girl.
 */
export function characterInstanceInPanel(ctx: RunContext, 
  doc: ProjectDocument,
  panelId: ID,
  ref: { characterName?: string; characterId?: ID },
): AssetInstance {
  const named = Boolean(ref.characterId ?? ref.characterName);
  const wanted = named
    ? requireCharacter(doc, ref, {
        selectedCharacterId: ctx.guards.selectedCharacterId,
        sceneCharacterIds: panelCharacterIds(ctx, doc, panelId),
      })
    : null;
  const panel = doc.panels[panelId];
  if (!panel) throw new Error("Unknown panel");
  const matches = panel.itemIds
    .map((id) => doc.items[id])
    .filter((item): item is AssetInstance => item?.kind === "asset")
    .filter((item) => {
      const characterId = item.characterState?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId;
      if (!characterId) return false;
      return wanted ? characterId === wanted.id : true;
    });
  const target = matches[matches.length - 1];
  if (!target) {
    throw new Error(
      wanted ? `${wanted.name} is not placed in that panel` : "No character instance found in that panel",
    );
  }
  return target;
}

/** Semantic placement → depth. The Agent names a plane; the harness picks the number. */
const PLACEMENT_DEPTH: Record<string, number> = { foreground: 0.15, midground: 0.5, background: 0.85 };

// ─── Manga Puppet: the Agent uses the SAME local operations as the GUI (§17) ──

/**
 * Change a puppet character's face.
 *
 * The Agent reaches for this instead of generate/compose whenever a puppet
 * exists, so "make Yuri shocked" swaps a face rather than redrawing a person.
 * The error names the fallback explicitly rather than silently generating.
 */
export function doSetPuppetExpression(ctx: RunContext, args: { panel: number; characterName?: string; characterId?: ID; expression: string }): void {
  const panelId = ctx.panelIdByNumber(args.panel);
  const doc = ctx.currentDoc();
  const instance = characterInstanceInPanel(ctx, doc, panelId, args);
  if (!isPuppetInstance(doc, instance.id)) {
    throw new Error(
      `${args.characterName ?? "That character"} has no puppet, so the face cannot be changed locally. Use set_character_slot to generate the expression instead.`,
    );
  }
  const expressionId = args.expression.trim().toLowerCase();
  ctx.dispatch({ type: "set-puppet-expression", instanceId: instance.id, expressionId });
}

export function doSetPuppetJoint(ctx: RunContext, args: {
  panel: number;
  characterName?: string;
  characterId?: ID;
  joint: PuppetJoint;
  degrees: number;
}): void {
  const panelId = ctx.panelIdByNumber(args.panel);
  const doc = ctx.currentDoc();
  const instance = characterInstanceInPanel(ctx, doc, panelId, args);
  if (!isPuppetInstance(doc, instance.id)) {
    throw new Error(
      `${args.characterName ?? "That character"} has no puppet, so the pose cannot be adjusted locally. Use set_character_pose_rig to generate the pose instead.`,
    );
  }
  ctx.dispatch({ type: "set-puppet-joint", instanceId: instance.id, joint: args.joint, degrees: args.degrees });
}
