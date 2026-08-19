/**
 * Skill selection: deterministic keyword scoring (no extra LLM round-trip).
 * Always-on skills are always included; triggered skills join when the
 * request mentions their domain.
 */

import { BUILTIN_SKILLS } from "./builtin";
import type { MangaSkill } from "./types";

const MAX_SELECTED = 5;

export function selectSkills(prompt: string): MangaSkill[] {
  const text = prompt.toLowerCase();
  const alwaysOn = BUILTIN_SKILLS.filter((skill) => skill.alwaysOn);
  const scored = BUILTIN_SKILLS.filter((skill) => !skill.alwaysOn)
    .map((skill) => ({
      skill,
      score: skill.triggers.reduce((sum, trigger) => (text.includes(trigger) ? sum + 1 : sum), 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SELECTED - alwaysOn.length)
    .map(({ skill }) => skill);
  return [...alwaysOn, ...scored];
}
