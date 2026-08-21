/**
 * The Manga Language Library: one read surface over built-ins, uploads, and
 * AI-generated assets.
 *
 * There is deliberately ONE search function. The Agent's "find a shock effect"
 * and the creator's search box run the same code, so the agent can never
 * "reuse" something the human cannot find, or fail to find something visible
 * in the panel beside it.
 */

import type {
  ID,
  MangaLanguageAsset,
  MangaLanguageCategory,
  ProjectDocument,
  SourceAsset,
} from "@/domain/types";
import { isAssetReadyForComposition } from "@/assets/renderSource";
import { builtinLibrary } from "./builtins";

/** DataTransfer type for dragging a language asset from the shelf to the canvas. */
export const LANGUAGE_DRAG_TYPE = "application/x-manga-language";

export const LANGUAGE_CATEGORIES: MangaLanguageCategory[] = [
  "bubbles",
  "effects",
  "tones",
  "emotion",
  "sfx",
  "decorations",
];

export const CATEGORY_LABELS: Record<MangaLanguageCategory, string> = {
  bubbles: "Bubbles",
  effects: "Lines",
  tones: "Tones",
  emotion: "Emotion",
  sfx: "SFX",
  decorations: "Decorations",
};

/**
 * Everything available to place, built-ins first so the catalogue reads in a
 * stable order and a creator's own assets group after it.
 */
export function languageLibrary(doc: ProjectDocument): MangaLanguageAsset[] {
  const owned = Object.values(doc.language ?? {});
  return [...builtinLibrary(doc.project.id), ...owned];
}

export function languageAssetsByCategory(
  doc: ProjectDocument,
  category: MangaLanguageCategory,
): MangaLanguageAsset[] {
  return languageLibrary(doc).filter((asset) => asset.category === category);
}

/** Resolve one language asset by id, including built-ins. */
export function findLanguageAsset(doc: ProjectDocument, id: ID): MangaLanguageAsset | undefined {
  return languageLibrary(doc).find((asset) => asset.id === id);
}

/** The image behind a visual language asset, if it is ready to composite. */
export function languageSourceAsset(doc: ProjectDocument, asset: MangaLanguageAsset): SourceAsset | undefined {
  if (asset.format !== "visual" || !asset.assetId) return undefined;
  const source = doc.assets[asset.assetId];
  return isAssetReadyForComposition(source) ? source : undefined;
}

export interface LanguageSearchQuery {
  category?: MangaLanguageCategory;
  /** Free text: matched against name and tags, never against a filename. */
  text?: string;
  /** All of these tags must be present. */
  tags?: string[];
  /** Restrict to structured (editable) or visual (image) assets. */
  format?: MangaLanguageAsset["format"];
}

export interface LanguageSearchHit {
  asset: MangaLanguageAsset;
  score: number;
  /** Why it matched, for the agent log and the UI. */
  matchedOn: string[];
}

/** Fraction of the query's meaningful words a candidate must actually match. */
const MIN_TERM_COVERAGE = 0.5;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "with", "to", "in", "on", "at",
  "add", "put", "place", "make", "manga", "effect", "effects", "style", "around",
  "some", "new", "please", "panel", "bubble",
]);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function terms(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((term) => term.length > 1 && !STOPWORDS.has(term));
}

/**
 * Deterministic ranked search. SEARCH is the first step of the agent's
 * SEARCH → REUSE → GENERATE order (§12), so it has to be honest: an empty
 * result means the library genuinely lacks the asset, and only then may a
 * generation be planned.
 */
export function searchLanguageAssets(doc: ProjectDocument, query: LanguageSearchQuery): LanguageSearchHit[] {
  let candidates = languageLibrary(doc);
  if (query.category) candidates = candidates.filter((asset) => asset.category === query.category);
  if (query.format) candidates = candidates.filter((asset) => asset.format === query.format);
  if (query.tags?.length) {
    const wanted = query.tags.map(normalize);
    candidates = candidates.filter((asset) => wanted.every((tag) => asset.tags.map(normalize).includes(tag)));
  }
  // A visual asset whose image failed processing is not placeable, so it must
  // not be reported as a reusable hit.
  candidates = candidates.filter((asset) => asset.format !== "visual" || Boolean(languageSourceAsset(doc, asset)));

  const searchTerms = query.text ? terms(query.text) : [];
  if (searchTerms.length === 0) {
    return candidates.map((asset) => ({ asset, score: 0, matchedOn: [] }));
  }

  const hits: LanguageSearchHit[] = [];
  for (const asset of candidates) {
    let matchedTerms = 0;
    const name = normalize(asset.name);
    const nameTerms = new Set(terms(asset.name));
    const tags = new Set(asset.tags.map(normalize));
    let score = 0;
    const matchedOn: string[] = [];

    if (name === normalize(query.text!)) {
      score += 100;
      matchedOn.push("name");
    }
    for (const term of searchTerms) {
      if (tags.has(term)) {
        score += 10;
        matchedTerms += 1;
        matchedOn.push(`tag:${term}`);
      } else if (nameTerms.has(term)) {
        score += 6;
        matchedTerms += 1;
        matchedOn.push(`name:${term}`);
      }
    }
    /**
     * A single incidental word is not a match.
     *
     * "black ink smoke swirl" shares the word "black" with the built-in Black
     * Focus Rays; treating that as a reuse hit would silently drop focus lines
     * into the panel instead of the smoke the creator asked for — and would
     * suppress the generation that request genuinely needs. Requiring most of
     * the query to land keeps an empty result honest.
     */
    const coverage = matchedTerms / searchTerms.length;
    if (score > 0 && coverage >= MIN_TERM_COVERAGE) hits.push({ asset, score, matchedOn });
  }

  return hits.sort(
    (a, b) =>
      b.score - a.score ||
      // A creator's own asset outranks a built-in at equal relevance: they made
      // it for this project on purpose.
      Number(b.asset.source !== "builtin") - Number(a.asset.source !== "builtin") ||
      a.asset.name.localeCompare(b.asset.name),
  );
}

/** The single best reuse candidate, or null when the library genuinely lacks one. */
export function bestLanguageAsset(doc: ProjectDocument, query: LanguageSearchQuery): MangaLanguageAsset | null {
  return searchLanguageAssets(doc, query)[0]?.asset ?? null;
}
