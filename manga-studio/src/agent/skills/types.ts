/**
 * Manga Skills: modular, inspectable instruction sets the agent loads by
 * task. Stored as markdown text in code modules (rather than loose .md files)
 * so serverless bundling can never silently drop them — the content remains
 * plain prose anyone can read and edit.
 */

export interface MangaSkill {
  id: string;
  name: string;
  /** Keywords that make the selector load this skill. */
  triggers: string[];
  /** Always-on skills are included in every plan. */
  alwaysOn?: boolean;
  instructions: string;
}
