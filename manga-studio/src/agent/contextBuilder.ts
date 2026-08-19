/**
 * Structured project context for the planner. Concise by design: the model
 * gets an inventory it can plan reuse against (the anti-regeneration rule
 * depends on the model seeing what already exists), not a state dump.
 */

import type { ID, ProjectDocument } from "@/domain/types";

export interface AgentContextInput {
  doc: ProjectDocument;
  currentPageId: ID | null;
  selection: { itemId?: ID; panelId?: ID };
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

  // Hard cap so a huge project can't blow the model context.
  const text = lines.join("\n");
  return text.length > 6000 ? `${text.slice(0, 6000)}\n…(truncated)` : text;
}
