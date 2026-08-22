/**
 * Literal Evidence — what the user's prompt ACTUALLY says, extracted
 * deterministically before any model is consulted.
 *
 * The prime rule of the semantic layer: NAMED ENTITIES ARE IMMUTABLE USER
 * DATA, NOT SEMANTIC CONTENT. A name after "called / named / 叫 / 名叫" is
 * ground truth; a capitalised word after a location preposition is a place,
 * not a person; nationality/occupation/appearance words are attributes, never
 * identities. The planner may interpret — it may not contradict this evidence,
 * and `semanticValidation.ts` enforces that at runtime.
 *
 * Provider-independent: no model, no fetch, no provider branch. New providers
 * plug in without touching this file.
 */

export interface ExplicitName {
  /** The name exactly as the user wrote it — never translated or renamed. */
  name: string;
  index: number;
  /**
   * Descriptor segments bound to this entity by proximity ("a cute Japanese
   * high school girl called Kiki" → "cute Japanese high school girl").
   * These are ATTRIBUTES of the named entity, never characters themselves.
   */
  attributes: string[];
}

export interface LocationSpan {
  /** The place surface exactly as written ("Kyoto", "Melbourne"). */
  surface: string;
  index: number;
  /** Why this is a place: a location preposition, or a scene-noun frame. */
  via: "preposition" | "scene-frame";
}

export interface LiteralEvidence {
  explicitNames: ExplicitName[];
  locations: LocationSpan[];
  /** Normalised lowercase for O(1) membership checks by the validator. */
  explicitNameSet: Set<string>;
  locationSet: Set<string>;
}

export function normalizeEvidenceName(value: string): string {
  return value.trim().toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");
}

/** English explicit-naming structures — highest identity priority. */
const EN_NAMING = /\b(?:called|named|whose\s+name\s+is)\s+["“”']?([A-Za-z][\w'’-]*(?:\s+[A-Z][\w'’-]*)?)/g;

/** Chinese explicit-naming structures: 叫小满 / 名叫小满 / 名字叫小满 / 叫做小满. */
const ZH_NAMING = /(?:名字叫|名叫|叫做|叫)(["“”']?)([\p{Script=Han}A-Za-z][\p{Script=Han}\w'’-]{0,29})\1/gu;

/** A capitalised word directly after these words names a PLACE. */
const LOCATION_PREP = new Set(["in", "at", "on", "near", "inside", "outside", "behind", "beside", "under", "over", "to", "from", "into", "towards", "toward"]);

/** "Kyoto-style street", "Kyoto style street" — the proper noun modifies a scene noun. */
const SCENE_NOUN = /\b([A-Z][\w'’-]+)[\s-]+style\s+(?:street|road|alley|town|village|city|district|neighborhood|house|cafe|bar|shop|room|garden|shrine|temple|bridge|station)\b/gi;

const PROPER_NOUN_RUN = /\b[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)*\b/g;

const LEADING_ARTICLE = /^(?:a|an|the|some|this|that|her|his|their|my|our|your)\s+/i;

/** The descriptor run ends at the naming verb; it starts after the last clause break. */
function descriptorSpanBefore(prompt: string, namingVerbIndex: number): string[] {
  const clauseStart = Math.max(
    prompt.lastIndexOf(".", namingVerbIndex),
    prompt.lastIndexOf(",", namingVerbIndex),
    prompt.lastIndexOf(";", namingVerbIndex),
    prompt.lastIndexOf("。", namingVerbIndex),
    prompt.lastIndexOf("，", namingVerbIndex),
  ) + 1;
  const span = prompt.slice(clauseStart, namingVerbIndex).trim().replace(LEADING_ARTICLE, "").trim();
  return span.length > 0 ? [span] : [];
}

function collectNames(prompt: string): ExplicitName[] {
  const out: ExplicitName[] = [];
  for (const match of prompt.matchAll(EN_NAMING)) {
    const name = match[1]?.trim();
    if (!name) continue;
    out.push({ name, index: match.index, attributes: descriptorSpanBefore(prompt, match.index) });
  }
  for (const match of prompt.matchAll(ZH_NAMING)) {
    const name = match[2]?.trim();
    if (!name) continue;
    out.push({ name, index: match.index, attributes: descriptorSpanBefore(prompt, match.index) });
  }
  return out.sort((a, b) => a.index - b.index);
}

function collectLocations(prompt: string, named: Set<string>): LocationSpan[] {
  const out: LocationSpan[] = [];
  const seen = new Set<string>();
  const push = (surface: string, index: number, via: LocationSpan["via"]) => {
    const key = normalizeEvidenceName(surface);
    if (seen.has(key) || named.has(key)) return;
    seen.add(key);
    out.push({ surface, index, via });
  };
  for (const match of prompt.matchAll(SCENE_NOUN)) {
    push(match[1], match.index, "scene-frame");
  }
  for (const match of prompt.matchAll(PROPER_NOUN_RUN)) {
    const preceding = normalizeEvidenceName(prompt.slice(Math.max(0, match.index - 16), match.index)).split(" ").pop();
    if (preceding && LOCATION_PREP.has(preceding)) push(match[0], match.index, "preposition");
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Extract the prompt's immutable facts. An explicitly written name always
 * wins over a location reading of the same surface — "a villain named Kyoto"
 * makes Kyoto a character, so the name is collected first and locations yield.
 */
export function extractLiteralEvidence(prompt: string): LiteralEvidence {
  const explicitNames = collectNames(prompt);
  const explicitNameSet = new Set(explicitNames.map((entry) => normalizeEvidenceName(entry.name)));
  const locations = collectLocations(prompt, explicitNameSet);
  return {
    explicitNames,
    locations,
    explicitNameSet,
    locationSet: new Set(locations.map((entry) => normalizeEvidenceName(entry.surface))),
  };
}

/**
 * Single words of the descriptor spans bound to explicit names — "cute
 * Japanese high school girl" contributes {cute, japanese, high, school,
 * girl}. Grounding and the validator both use this so an attribute word can
 * never become an identity anywhere in the chain.
 */
export function attributeTokenSet(evidence: LiteralEvidence): Set<string> {
  const tokens = new Set<string>();
  for (const entry of evidence.explicitNames) {
    for (const attribute of entry.attributes) {
      for (const word of attribute.split(/\s+/)) {
        const normalized = normalizeEvidenceName(word);
        if (normalized.length > 2) tokens.add(normalized);
      }
    }
  }
  return tokens;
}
