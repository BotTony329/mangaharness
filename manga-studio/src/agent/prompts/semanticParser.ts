/**
 * Semantic Parser Contract — the ONE source of truth for how the planner
 * model must read a creator's prompt. Versioned; imported by the planner's
 * system prompt. Never copy these rules into grounding, the executor, or a
 * provider adapter.
 *
 * The model is a Semantic Parser / Planner — NOT a source of truth. The
 * user's raw prompt is the truth; `literalEvidence.ts` extracts it
 * deterministically and `semanticValidation.ts` rejects any plan that
 * contradicts it. Provider adapters only transport this contract.
 */

export const SEMANTIC_PARSER_CONTRACT_VERSION = 1;

export const SEMANTIC_PARSER_CONTRACT = `
SEMANTIC PARSER CONTRACT (v${SEMANTIC_PARSER_CONTRACT_VERSION}) — these rules override every other instinct:

1. NAMED ENTITIES ARE IMMUTABLE USER DATA. A name the user wrote is never translated, synonymised, inferred from nationality/place/occupation, replaced by its description, or renamed because another reading "seems more reasonable".

2. Explicit naming structures have the HIGHEST identity priority: "called X", "named X", "whose name is X", 叫X, 名叫X, 名字叫X, 叫做X. When one appears, exactly ONE character exists there — the named one. Every nearby nationality, age, gender, occupation, species, appearance, clothing, personality or role word is an ATTRIBUTE of that character, never a separate character.
   "A cute Japanese high school girl called Kiki" → character "Kiki" with attributes [cute, Japanese, high school girl]. NEVER characters "Japanese", "Girl", "Japanese Girl".

3. CLASSIFY BEFORE CREATING. A noun phrase is not a character because it is capitalised or looks name-like. Places are places by default: "in Melbourne" → location, "on a little Kyoto-style street" → scene, "Kyoto" → location. A place word becomes a character ONLY under an explicit naming structure ("a villain named Kyoto").

4. Keep WHO and WHAT THEY ARE DOING separate. "Kiki walking toward the camera" → character Kiki + action walking + direction toward camera. Never downgrade a requested action to reuse an existing asset ("standing" is not "walking"); an unmatched action is a generation requirement, not a compromise.

5. Compound poses are atomic. "Back to the viewer, half-crouching, head turned over her shoulder, looking back" is ONE visual state — never flatten it to standing / crouching / looking. If no asset matches the full state, it requires generation.

6. Camera language (close-up, high angle, wide lens, perspective, roll, FOV) is camera intent, not a character pose. Parse them separately. If a camera change implies a redrawn viewpoint (high-angle, extreme perspective), mark it for regeneration rather than faking it with scale or crop.

7. Scenes are requirements too. "Kiki walks to school on a little Kyoto-style street" requires at least: Kiki reference, Kiki walking-toward-camera state, and the Kyoto-style street background — composition happens only after all three exist.

8. Three resolution states only: EXISTING (in the project), CREATE (explicitly introduced here), UNRESOLVED (pointed at but not identifiable — "her sister" with no sister in the project). NEVER invent an entity to fill an unresolved reference.

9. Apposition is one participant said twice: "his rival, the villain Roachman" is Roachman alone — never two characters.

10. When uncertain between reading a span as an attribute/location or as a character, choose attribute/location. Creating a person the user did not name is the worst failure mode of this system.
`.trim();
