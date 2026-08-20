import { cloneDoc, touch } from "./docHelpers";
import { newId } from "./factory";
import type { ID, ProjectDocument, StyleProfile } from "./types";
import { getStyleProfile } from "@/styles/profiles";

export function setProjectStyle(doc: ProjectDocument, styleId: ID): ProjectDocument {
  if (!getStyleProfile(doc, styleId)) throw new Error(`Unknown art style: ${styleId}`);
  if (doc.project.settings.artStyle.activeStyleId === styleId) return doc;
  const next = cloneDoc(doc);
  next.project.settings.artStyle.activeStyleId = styleId;
  touch(next);
  return next;
}

export function addCustomStyle(
  doc: ProjectDocument,
  input: Omit<StyleProfile, "id" | "family">,
): { doc: ProjectDocument; styleId: ID } {
  const next = cloneDoc(doc);
  const styleId = newId();
  next.project.settings.artStyle.customProfiles[styleId] = { ...input, id: styleId, family: "custom" };
  next.project.settings.artStyle.activeStyleId = styleId;
  touch(next);
  return { doc: next, styleId };
}
