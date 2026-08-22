"use client";

/**
 * Project inventory for the Creative Director — semantic information only:
 * names, roles, descriptions. No storage internals, no provider details, no
 * runtime placeholder machinery.
 */

import type { ID, ProjectDocument } from "@/domain/types";

export function projectInventory(doc: ProjectDocument, currentPageId: ID | null): string {
  const lines: string[] = [];

  const characters = Object.values(doc.characters);
  lines.push("CHARACTERS");
  lines.push(
    characters.length === 0
      ? "- (none yet)"
      : characters
          .map((c) => {
            const states = Object.values(doc.assets)
              .filter((a) => a.metadata?.characterId === c.id && a.metadata?.characterAssetRole === "state")
              .map((a) => [a.metadata?.pose, a.metadata?.expression].filter(Boolean).join("+"))
              .filter(Boolean);
            return `- ${c.name}${c.appearance ? ` (${c.appearance.slice(0, 80)})` : ""}${states.length > 0 ? ` — states: ${[...new Set(states)].join(", ")}` : ""}`;
          })
          .join("\n"),
  );

  const scenes = Object.values(doc.assets).filter((a) => a.category === "background");
  lines.push("", "SCENES");
  lines.push(scenes.length === 0 ? "- (none yet)" : scenes.map((a) => `- ${a.name}`).join("\n"));

  const objects = Object.values(doc.assets).filter((a) => a.category === "prop" || a.category === "upload");
  lines.push("", "OBJECTS");
  lines.push(objects.length === 0 ? "- (none yet)" : objects.map((a) => `- ${a.name}`).join("\n"));

  const page = currentPageId ? doc.pages[currentPageId] : Object.values(doc.pages)[0];
  if (page) {
    lines.push("", "CURRENT PAGE");
    page.panelIds.forEach((panelId, index) => {
      const panel = doc.panels[panelId];
      const contents = panel.itemIds
        .map((itemId) => doc.items[itemId])
        .map((item) => {
          if (item?.kind === "asset") return doc.assets[item.sourceAssetId]?.name;
          if (item?.kind === "bubble") return `bubble "${item.text.slice(0, 30)}"`;
          return item?.kind;
        })
        .filter(Boolean)
        .join(", ");
      lines.push(`- Panel ${index + 1}${contents ? `: ${contents}` : ": empty"}`);
    });
  }
  return lines.join("\n");
}
