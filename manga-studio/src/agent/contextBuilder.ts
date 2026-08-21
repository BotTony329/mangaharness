/**
 * Structured project context for the planner. Concise by design: the model
 * gets an inventory it can plan reuse against (the anti-regeneration rule
 * depends on the model seeing what already exists), not a state dump.
 */

import { stateFromAsset, stateFromInstance } from "@/characters/state";
import { isAssetReadyForComposition } from "@/assets/renderSource";
import type { ID, ProjectDocument } from "@/domain/types";
import { getActiveStyleProfile } from "@/styles/profiles";
import { resolveAgentScope, scopeInstruction, type AgentRunScope } from "./scope";
import { groundingContext, type GroundingReport } from "./grounding";
import { CATEGORY_LABELS, LANGUAGE_CATEGORIES, languageLibrary } from "@/language/library";

/** Context budget. Identity is exempt; only panel detail is trimmed to fit. */
const MAX_CONTEXT_CHARS = 8000;

export interface AgentContextInput {
  doc: ProjectDocument;
  currentPageId: ID | null;
  selection: { itemId?: ID; panelId?: ID; workspaceItemId?: ID };
  scope?: AgentRunScope;
  /** Deterministic entity grounding, resolved before the planner is called. */
  grounding?: GroundingReport;
}

export function buildAgentContext({ doc, currentPageId, selection, scope, grounding }: AgentContextInput): string {
  const runScope = scope ?? resolveAgentScope({ doc, currentPageId, selection, prompt: "" });
  // §11: the agent is always told which project it is operating in, and every
  // list below is read from THIS document — so grounding can never resolve a
  // character that belongs to a project the creator is not in.
  const lines: string[] = [`PROJECT: ${doc.project.name}`, `PROJECT ID: ${doc.project.id}`];
  lines.push(scopeInstruction(runScope));
  const activeStyle = getActiveStyleProfile(doc);
  lines.push(
    `PROJECT ART STYLE: ${activeStyle.name} (${activeStyle.family})`,
    `STYLE DIRECTION: ${activeStyle.description}`,
    "All new visual generation inherits this style automatically; do not repeat style language in character identity.",
  );

  // ── Characters: a structured inventory, not a free-text summary (§12) ──
  // Every character carries its stable ID and its available states, because a
  // planner that cannot see an existing character is a planner that invents one.
  const characters = Object.values(doc.characters);
  lines.push("", `CHARACTERS (${characters.length}) — these are the ONLY characters that exist:`);
  if (characters.length === 0) lines.push("- none yet");
  for (const character of characters) {
    const assets = character.assetIds.map((id) => doc.assets[id]).filter(isAssetReadyForComposition);
    const slots = assets.map((asset) => {
      const state = stateFromAsset(asset!, character.id);
      return asset!.metadata?.characterAssetRole === "canonical" || !state
        ? "canonical-reference"
        : `${state.pose}/${state.expression}/${state.outfit}/${state.view}`;
    });
    lines.push(`- ${character.name}`);
    lines.push(`  ID: ${character.id}`);
    if (character.aliases?.length) lines.push(`  aliases: ${character.aliases.join(", ")}`);
    const identity = character.appearance ?? character.description;
    if (identity) lines.push(`  identity: ${identity.slice(0, 100)}`);
    if (character.personalityNotes) lines.push(`  notes: ${character.personalityNotes.slice(0, 80)}`);
    lines.push(
      `  available states: ${slots.length > 0 ? [...new Set(slots)].join(", ") : "NONE (needs a reference before poses/expressions)"}`,
    );
  }

  // Everything above this point is identity and is never truncated.
  const panelSectionStart = lines.length;

  // ── Backgrounds and props ──
  for (const category of ["background", "prop"] as const) {
    const assets = Object.values(doc.assets).filter((a) => a.category === category && isAssetReadyForComposition(a));
    lines.push("", `${category.toUpperCase()}S (${assets.length}):`);
    lines.push(...(assets.length > 0 ? assets.map((a) => `- ${a.name}`) : ["- none yet"]));
  }

  // ── Manga Language Library (§12) ──
  // Listed so the planner can reuse rather than generate. Built-ins are
  // included: they are as reusable as anything the creator made.
  const language = languageLibrary(doc);
  lines.push("", `MANGA LANGUAGE LIBRARY (${language.length}) — reuse these before generating any effect:`);
  for (const category of LANGUAGE_CATEGORIES) {
    const inCategory = language.filter((asset) => asset.category === category);
    if (inCategory.length === 0) continue;
    lines.push(`- ${CATEGORY_LABELS[category]}: ${inCategory.map((asset) => asset.name).join(", ")}`);
  }

  // ── Current page ──
  const page = currentPageId ? doc.pages[currentPageId] : null;
  if (page) {
    lines.push("", `CURRENT PAGE: ${page.name} (${page.panelIds.length} panels)`);
    page.panelIds.forEach((panelId, index) => {
      const panel = doc.panels[panelId];
      const scene = doc.scenes[panelId];
      const selectedMark = selection.panelId === panelId ? "  [SELECTED]" : "";
      lines.push(`Panel ${index + 1}:${selectedMark}`);
      if (scene) {
        const background = scene.backgroundAssetId ? doc.assets[scene.backgroundAssetId]?.name : undefined;
        if (background || scene.location) lines.push(`  scene: ${scene.location ?? "unspecified location"}; background:${background ?? "none"}`);
        for (const relation of scene.relationships) {
          const subject = doc.characters[relation.subjectCharacterId]?.name ?? relation.subjectCharacterId;
          const target = relation.targetCharacterId ? doc.characters[relation.targetCharacterId]?.name ?? relation.targetCharacterId : undefined;
          lines.push(`  relationship: ${subject} ${relation.action}${target ? ` ${target}` : ""}`);
        }
        if (scene.continuity?.backgroundSourcePanelId) {
          const sourceNumber = page.panelIds.indexOf(scene.continuity.backgroundSourcePanelId) + 1;
          lines.push(`  continuity: exact background reused from Panel ${sourceNumber}`);
        }
      }
      if (!panel || panel.itemIds.length === 0) {
        lines.push("  - empty");
        return;
      }
      for (const itemId of panel.itemIds) {
        const item = doc.items[itemId];
        if (!item) continue;
        const selected = selection.itemId === itemId ? " [SELECTED]" : "";
        if (item.kind === "asset") {
          const asset = doc.assets[item.sourceAssetId];
          lines.push(`  - ${asset?.category ?? "asset"}: ${asset?.name ?? "?"} (crop:${item.cropMode})${selected}`);
        } else if (item.kind === "bubble") {
          lines.push(`  - ${item.bubbleType} bubble: "${item.text.slice(0, 60)}"${selected}`);
        } else {
          lines.push(`  - effect: ${item.effectKind}${selected}`);
        }
      }
    });
  }

  // ── Loose workspace material (reference sheets, staged generations) ──
  const looseItems = doc.workspaceOrder.map((id) => doc.workspaceItems[id]).filter(Boolean);
  if (looseItems.length > 0) {
    lines.push("", `LOOSE WORKSPACE ASSETS (beside the page, not exported): ${looseItems.length}`);
    for (const item of looseItems.slice(0, 12)) {
      lines.push(`- ${doc.assets[item!.sourceAssetId]?.name ?? "?"}`);
    }
  }

  // ── Explicit selection summary — "make her angry" needs to know who ──
  lines.push("", `CURRENT SELECTION: ${describeSelection(doc, currentPageId, selection)}`);
  lines.push(`TARGET SCOPE: ${runScope.label}`);

  if (grounding) lines.push(...groundingContext(grounding));

  /**
   * Hard cap so a huge project cannot blow the model context.
   *
   * The character inventory is exempt. Truncating it was itself a cause of
   * invented characters: a planner that cannot see Yuri has no way to know
   * Yuri exists, and the most natural repair for a missing character is to
   * create one. Panel detail is trimmed instead; identity never is.
   */
  const head = lines.slice(0, panelSectionStart).join("\n");
  const tail = lines.slice(panelSectionStart).join("\n");
  const budget = Math.max(0, MAX_CONTEXT_CHARS - head.length);
  return tail.length > budget ? `${head}\n${tail.slice(0, budget)}\n…(panel detail truncated)` : `${head}\n${tail}`;
}

function describeSelection(
  doc: ProjectDocument,
  currentPageId: ID | null,
  selection: AgentContextInput["selection"],
): string {
  const page = currentPageId ? doc.pages[currentPageId] : null;
  const panelNumber = (panelId: ID | undefined) =>
    page && panelId ? page.panelIds.indexOf(panelId) + 1 : undefined;

  if (selection.itemId) {
    const item = doc.items[selection.itemId];
    const panel = panelNumber(item?.panelId);
    if (item?.kind === "asset") {
      const asset = doc.assets[item.sourceAssetId];
      const characterId = asset?.metadata?.characterId;
      const character = characterId ? doc.characters[characterId] : null;
      const state = stateFromInstance(doc, item);
      const slot = state
        ? `pose:${state.pose} expression:${state.expression} outfit:${state.outfit} view:${state.view}`
        : "";
      return character
        ? `character instance — ${character.name}${slot ? ` (${slot})` : ""} in Panel ${panel}`
        : `${asset?.category ?? "asset"} instance "${asset?.name}" in Panel ${panel}`;
    }
    if (item?.kind === "bubble") return `${item.bubbleType} bubble in Panel ${panel}: "${item.text.slice(0, 40)}"`;
    if (item?.kind === "effect") return `${item.effectKind} effect in Panel ${panel}`;
  }
  if (selection.workspaceItemId) {
    const loose = doc.workspaceItems[selection.workspaceItemId];
    return `loose workspace asset "${doc.assets[loose?.sourceAssetId ?? ""]?.name ?? "?"}" (outside the page)`;
  }
  if (selection.panelId) return `Panel ${panelNumber(selection.panelId)} (empty selection inside it)`;
  return "nothing (page-level context)";
}
