/** The built-in Manga Skill library shipped with the MVP. */

import type { MangaSkill } from "./types";

const mangaComposition: MangaSkill = {
  id: "manga-composition",
  name: "Manga Panel Composition",
  triggers: [],
  alwaysOn: true,
  instructions: `
# Manga Panel Composition Skill

1. REUSE FIRST. Before generating anything, check the asset inventory in the
   project context. Follow this priority strictly:
   1. Reuse an existing asset as-is.
   2. Reuse an existing asset with a different crop mode (upper-body, fill).
   3. Reuse a compatible pose/expression of the same character.
   4. Generate ONE missing variation of an existing character.
   5. Generate a completely new asset only when nothing usable exists.
2. Never regenerate a character just to get a close-up — place the existing
   asset and use set_crop_mode "upper-body" or "face" instead.
3. Panels are viewports: a full-body asset becomes a medium shot or close-up
   through crop modes with zero new generations.
4. Composition order inside a panel: background first (fill), then characters,
   then props, then effects, then speech bubbles.
5. Vary framing across a page: alternate wide/medium/close shots for rhythm.
   The final or emotional panel usually deserves the tightest framing.
6. Keep speech bubbles near the top of panels and away from faces — use the
   position argument (top-left/top-right) rather than center when a character
   is centered.
7. Preserve existing user work: never remove_items unless the user explicitly
   asked to replace or clear content.
`.trim(),
};

const characterCreation: MangaSkill = {
  id: "character-creation",
  name: "Character Asset Creation",
  triggers: ["character", "create", "new", "girl", "boy", "protagonist", "hero", "heroine"],
  instructions: `
# Character Asset Creation Skill

1. A character needs a reference asset before pose/expression variations:
   create_character, then generate_character_asset kind:"reference".
2. Character identity should describe age range, hair, eyes, outfit, build,
   and personality hints. Never mix rendering style into identity: the active
   project Art Style is injected automatically into every visual generation.
3. When the user asks for several expressions or poses, generate each as its
   own asset (one generate_character_asset step per slot) so each becomes an
   independently reusable library asset.
4. Use short, canonical slot names: pose "running", "sitting", "standing";
   expression "smile", "crying", "angry", "shocked". These names are how
   assets are found later.
5. Do not generate more than the user asked for.
`.trim(),
};

const pageLayout: MangaSkill = {
  id: "page-layout",
  name: "Manga Page Layout",
  triggers: ["layout", "page", "panel", "panels", "grid", "scene", "compose"],
  instructions: `
# Manga Page Layout Skill

1. Choose the layout from the story beat count: 1 beat = "single",
   2 beats = "two-vertical", 3 = "three-vertical", 4 = "four-grid"
   (or "yonkoma" for gag strips / explicit 4-koma requests).
2. set_page_layout replaces the panel arrangement of the CURRENT page and
   re-homes existing content; only call it when the panel count must change.
3. Panel numbering is reading order: 1 is top-left (or top for stacked
   layouts), increasing left-to-right then top-to-bottom.
4. Establish location in panel 1 with a background; later panels can skip the
   background for close-ups to focus on emotion.
`.trim(),
};

const dialogueLayout: MangaSkill = {
  id: "dialogue-layout",
  name: "Dialogue Placement",
  triggers: ["dialogue", "speech", "say", "says", "talk", "bubble", "text", "confess", "shout"],
  instructions: `
# Dialogue Placement Skill

1. Keep bubbles short — under 15 words each. Split long speeches across
   panels rather than one giant bubble.
2. bubbleType: "speech" for spoken lines, "thought" for inner monologue,
   "shout" for yelling/impact lines, "narration" for scene-setting captions.
3. Place narration boxes at top-left of establishing panels.
4. Position bubbles away from character faces: if the character stands
   center/right, put the bubble top-left, and vice versa.
5. Reading order within a panel goes top to bottom — the first speaker's
   bubble should sit higher than the reply.
`.trim(),
};

const yonkoma: MangaSkill = {
  id: "yonkoma",
  name: "Yonkoma (4-koma)",
  triggers: ["yonkoma", "4-koma", "four-panel", "4 panel", "gag", "comedy", "funny", "joke"],
  instructions: `
# Yonkoma Skill

1. Use set_page_layout "yonkoma" (four stacked panels, read top to bottom).
2. Structure: ki-shō-ten-ketsu —
   Panel 1 (ki): setup, establish place and characters.
   Panel 2 (shō): development, continue naturally.
   Panel 3 (ten): the twist — the unexpected turn. Strongest framing here.
   Panel 4 (ketsu): punchline/reaction. Close-up reaction faces work well.
3. Comedy timing: keep panels 1-2 calm (fit/upper-body framing), spike the
   energy at panel 3 (speed-lines or shout bubble), land the reaction in
   panel 4 (face or upper-body crop, sweat/shock effect).
4. Reuse the same character assets across all four panels with different
   crops — consistency IS the joke's stage.
`.trim(),
};

const actionScene: MangaSkill = {
  id: "action-scene",
  name: "Action Scene",
  triggers: ["action", "fight", "run", "running", "chase", "dramatic", "battle", "impact", "speed"],
  instructions: `
# Action Scene Skill

1. Action reads through motion cues: add_effect "speed-lines" behind moving
   characters, "impact-burst" at moments of collision, "focus-lines" to pull
   the eye to the subject.
2. Use dynamic framing: "fill" or "upper-body" crops with the character
   slightly rotated (place, then the user can fine-tune) reads faster than
   static full-body shots.
3. A running pose asset reused across panels with different crops conveys a
   chase without new generations.
4. For drama requests on an existing panel ("make it more dramatic"):
   add one effect layer and optionally tighten the crop mode — do NOT remove
   or replace what the creator already placed.
5. Shout bubbles ("shout") amplify action beats; keep the text explosive and
   short.
`.trim(),
};

export const BUILTIN_SKILLS: MangaSkill[] = [
  mangaComposition,
  characterCreation,
  pageLayout,
  dialogueLayout,
  yonkoma,
  actionScene,
];
