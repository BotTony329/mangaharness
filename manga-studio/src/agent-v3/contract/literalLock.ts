/**
 * Literal Lock — hard evidence from the user's own prompt, nothing more.
 *
 * This is NOT a semantic parser. It preserves literals (explicit names, exact
 * quoted dialogue, exact spans) so the Creative Director cannot silently
 * replace or invent them, and so the verifier can check fidelity afterwards.
 * Interpretation — relationships, locations, poses, intent — belongs to the
 * Main Creative LLM, not to this module.
 */

import { extractLiteralEvidence, type LiteralEvidence } from "@/agent/literalEvidence";
import type { ID, ProjectDocument } from "@/domain/types";

export interface LiteralLock {
  /** Names the user explicitly wrote (called X / named X / 叫X…). Immutable user data. */
  explicitNames: string[];
  /** Exact quoted dialogue, in order of appearance. */
  quotedDialogue: string[];
  /** Project characters matched verbatim in the prompt (surface → real ID). */
  matchedProjectEntities: { surface: string; characterId: ID }[];
  /** Current selection context, as plain facts. */
  selection: { pageId?: ID; panelId?: ID; itemId?: ID };
}

function quotedDialogue(prompt: string): string[] {
  const out: string[] = [];
  for (const match of prompt.matchAll(/["“]([^"”]{1,300})["”]/g)) out.push(match[1]);
  return out;
}

export function literalLock(input: {
  prompt: string;
  doc: ProjectDocument;
  currentPageId?: ID | null;
  selection?: { panelId?: ID; itemId?: ID };
}): LiteralLock {
  const evidence: LiteralEvidence = extractLiteralEvidence(input.prompt);
  const matched: LiteralLock["matchedProjectEntities"] = [];
  for (const character of Object.values(input.doc.characters)) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${character.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu");
    if (pattern.test(input.prompt)) matched.push({ surface: character.name, characterId: character.id });
  }
  return {
    explicitNames: evidence.explicitNames.map((entry) => entry.name),
    quotedDialogue: quotedDialogue(input.prompt),
    matchedProjectEntities: matched,
    selection: {
      pageId: input.currentPageId ?? undefined,
      panelId: input.selection?.panelId,
      itemId: input.selection?.itemId,
    },
  };
}
