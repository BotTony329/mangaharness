/**
 * Project lifecycle as pure `doc → doc` transforms.
 *
 * Creation and deletion live in the persistence layer (a project that does not
 * exist has no document); rename and duplicate are document operations, so they
 * belong here beside every other domain module and go through the same command
 * layer, history and autosave.
 */

import { cloneDoc, touch } from "./docHelpers";
import { newId, now } from "./factory";
import type { ID, ProjectDocument } from "./types";

/**
 * Rename changes the display name and NOTHING else.
 *
 * The project id, pages, panels, assets, characters, character states,
 * puppets, camera data and manga-language library are all preserved by
 * construction: this function touches one string. That matters because the
 * project id is the persistence key and the agent's grounding scope — renaming
 * must never orphan a document or re-scope the agent.
 */
export function renameProject(doc: ProjectDocument, name: string): ProjectDocument {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A project needs a name");
  const next = cloneDoc(doc);
  next.project.name = trimmed;
  touch(next);
  return next;
}

/**
 * Duplicate a project into an independent document.
 *
 * `cloneDoc` is a deep clone, so the copy shares no mutable state with the
 * original — editing one cannot reach the other, which is the property that
 * actually matters. The new document gets a fresh project id and every
 * `projectId` back-reference is repointed at it.
 *
 * Internal ids (pages, panels, items, assets, characters, puppets) are
 * deliberately NOT regenerated. They are only ever resolved within their own
 * document, so a collision across two separate documents is not observable —
 * and remapping every cross-reference (asset ids, part ids, expression slots,
 * bubble targets, focal items, lineage parents) is exactly the kind of sweep
 * where one missed field silently corrupts a copy.
 *
 * Image binaries are immutable and content-addressed in object storage, so the
 * copy references the same blobs rather than duplicating megabytes — §5
 * explicitly allows this, and nothing can mutate a stored blob in place.
 */
export function duplicateProjectDocument(doc: ProjectDocument, name?: string): ProjectDocument {
  const next = cloneDoc(doc);
  const projectId: ID = newId();
  const timestamp = now();

  next.project = {
    ...next.project,
    id: projectId,
    name: (name ?? `${doc.project.name} copy`).trim() || `${doc.project.name} copy`,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  for (const asset of Object.values(next.assets)) asset.projectId = projectId;
  for (const character of Object.values(next.characters)) character.projectId = projectId;
  for (const page of Object.values(next.pages)) page.projectId = projectId;
  for (const languageAsset of Object.values(next.language ?? {})) languageAsset.projectId = projectId;

  return next;
}

/**
 * Every `projectId` a document claims. Used by the scoping test to prove a
 * duplicate does not keep pointing at the project it was copied from.
 */
export function referencedProjectIds(doc: ProjectDocument): Set<ID> {
  const ids = new Set<ID>([doc.project.id]);
  for (const asset of Object.values(doc.assets)) ids.add(asset.projectId);
  for (const character of Object.values(doc.characters)) ids.add(character.projectId);
  for (const page of Object.values(doc.pages)) ids.add(page.projectId);
  for (const languageAsset of Object.values(doc.language ?? {})) ids.add(languageAsset.projectId);
  return ids;
}

/**
 * Does every record in this document belong to this project?
 *
 * A false result means an asset library is leaking across projects, which is
 * the failure §8 is guarding against.
 */
export function isProjectScoped(doc: ProjectDocument): boolean {
  const ids = referencedProjectIds(doc);
  return ids.size === 1 && ids.has(doc.project.id);
}
