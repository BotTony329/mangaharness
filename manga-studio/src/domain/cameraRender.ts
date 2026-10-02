/**
 * Panel Camera Render — invalidation contract (v0.3 Phase 6).
 *
 * A Panel Camera Render is DERIVED output: it is drawn from the panel's
 * visual source graph (participants, their states, interactions, focus). When
 * that graph changes, the flat render no longer represents the panel and must
 * stop being "current" — the source composition returns to view until the
 * creator regenerates the Camera View. Deactivation is a metadata flip on the
 * panel, so it flows through the same command/undo boundary as everything
 * else; the render ASSET is never deleted (non-destructive retention).
 *
 * The classifier below is the ONE place that distinguishes:
 *
 *   VISUAL SOURCE MUTATION     — participant add/remove/replace, transform,
 *                                staging, pose/expression/state, puppet edits,
 *                                interaction change, focus change, identity
 *                                reference change  → render goes stale
 *   EDITORIAL OVERLAY MUTATION — bubbles, captions, effects, tones, bubble
 *                                anchors/tails       → render stays current
 *
 * Overlay items were never part of the render's source graph (Phase 4.5
 * exclusion), so editing them can never stale it.
 */

import type { DomainCommand } from "./commands";
import type { ID, ProjectDocument } from "./types";

/** Commands whose target panel is directly named. */
const PANEL_SCOPED_VISUAL = new Set<DomainCommand["type"]>([
  "add-instance",
  "set-panel-focal-item",
]);

/** Commands addressed by instance/item id; only ASSET items are visual sources. */
const INSTANCE_VISUAL = new Set<DomainCommand["type"]>([
  "delete-instance",
  "swap-instance-asset",
  "update-instance-transform",
  "set-framing",
  "compose-character",
  "set-instance-stage",
  "clear-instance-stage",
  "place-on-stage",
  "set-instance-character-state",
  "attach-puppet",
  "detach-puppet",
  "set-puppet-expression",
  "set-puppet-joint",
  "reset-puppet-pose",
  "set-puppet-part",
  "set-puppet-attachment",
]);

/** Interaction edits stale the render: interaction semantics ride into the joint prompt.
 *  (The check itself is inlined at the call site so the union narrows.) */

function assetItemPanel(doc: ProjectDocument, itemId: ID | undefined): ID | undefined {
  if (!itemId) return undefined;
  const item = doc.items[itemId];
  return item?.kind === "asset" ? item.panelId : undefined;
}

/**
 * Panels whose active Camera Render this command makes stale. The PRE-command
 * document decides (a deletion removes the very item that names the panel);
 * an empty result means the command is editorial and the render stays current.
 */
export function cameraRenderInvalidationPanels(doc: ProjectDocument, command: DomainCommand): ID[] {
  if (PANEL_SCOPED_VISUAL.has(command.type)) {
    return "panelId" in command ? [command.panelId] : [];
  }
  if (command.type === "create-interaction") {
    return [command.input.panelId];
  }
  if (command.type === "update-interaction" || command.type === "remove-interaction") {
    const panelId = doc.interactions?.[command.interactionId]?.panelId;
    return panelId ? [panelId] : [];
  }
  if (INSTANCE_VISUAL.has(command.type)) {
    const itemId =
      "instanceId" in command && typeof command.instanceId === "string"
        ? command.instanceId
        : "itemId" in command && typeof command.itemId === "string"
          ? command.itemId
          : undefined;
    const panelId = assetItemPanel(doc, itemId);
    return panelId ? [panelId] : [];
  }
  if (command.type === "set-character-reference") {
    // A new identity image re-draws every panel the character participates in.
    return Object.values(doc.panels)
      .filter((panel) => panel.activeCameraRenderAssetId)
      .filter((panel) =>
        panel.itemIds.some((itemId) => {
          const item = doc.items[itemId];
          if (item?.kind !== "asset") return false;
          return (item.characterState?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId) === command.characterId;
        }),
      )
      .map((panel) => panel.id);
  }
  return [];
}

/**
 * Deactivate the stale renders, clone-on-write: panels without an active
 * render are returned untouched, and a no-op returns the SAME document so
 * history never records a phantom change.
 */
export function invalidateCameraRenders(doc: ProjectDocument, panelIds: ID[]): ProjectDocument {
  let next = doc;
  for (const panelId of panelIds) {
    const panel = next.panels[panelId];
    if (!panel?.activeCameraRenderAssetId) continue;
    if (next === doc) next = { ...doc, panels: { ...doc.panels } };
    next.panels[panelId] = { ...next.panels[panelId], activeCameraRenderAssetId: undefined };
  }
  return next;
}
