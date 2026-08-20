/**
 * Structured project context for the planner. Concise by design: the model
 * gets an inventory it can plan reuse against (the anti-regeneration rule
 * depends on the model seeing what already exists), not a state dump.
 */

import type { ID, ProjectDocument } from "@/domain/types";

export interface AgentContextInput {
  doc: ProjectDocument;
  currentPageId: ID | null;
  selection: { itemId?: ID; panelId?: ID; workspaceItemId?: ID };
}

export function buildAgentContext({ doc, currentPageId, selection }: AgentContextInput): string {
  const lines: string[] = [`PROJECT: ${doc.project.name}`];

  // ── Characters and their reusable slots ──
  const characters = Object.values(doc.characters);
  lines.push("", `CHARACTERS (${characters.length}):`);
  if (characters.length === 0) lines.push("- none yet");
  for (const character of characters) {
    const assets = character.assetIds.map((id) => doc.assets[id]).filter(Boolean);
    const slots = assets.map((asset) => {
      const meta = asset!.metadata;
      const slot = [meta?.pose && `pose:${meta.pose}`, meta?.expression && `expression:${meta.expression}`]
        .filter(Boolean)
        .join(" ");
      return slot || "reference";
    });
    lines.push(
      `- ${character.name}${character.description ? ` — ${character.description.slice(0, 100)}` : ""}`,
      `  assets: ${slots.length > 0 ? [...new Set(slots)].join(", ") : "NONE (needs a reference before poses/expressions)"}`,
    );
  }

  // ── Backgrounds and props ──
  for (const category of ["background", "prop"] as const) {
    const assets = Object.values(doc.assets).filter((a) => a.category === category);
    lines.push("", `${category.toUpperCase()}S (${assets.length}):`);
    lines.push(...(assets.length > 0 ? assets.map((a) => `- ${a.name}`) : ["- none yet"]));
  }

  // ── Current page ──
  const page = currentPageId ? doc.pages[currentPageId] : null;
  if (page) {
    lines.push("", `CURRENT PAGE: ${page.name} (${page.panelIds.length} panels)`);
    page.panelIds.forEach((panelId, index) => {
      const panel = doc.panels[panelId];
      const selectedMark = selection.panelId === panelId ? "  [SELECTED]" : "";
      lines.push(`Panel ${index + 1}:${selectedMark}`);
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

  // Hard cap so a huge project can't blow the model context.
  const text = lines.join("\n");
  return text.length > 6000 ? `${text.slice(0, 6000)}\n…(truncated)` : text;
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
      const slot = [asset?.metadata?.pose && `pose:${asset.metadata.pose}`, asset?.metadata?.expression && `expression:${asset.metadata.expression}`]
        .filter(Boolean)
        .join(" ");
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
