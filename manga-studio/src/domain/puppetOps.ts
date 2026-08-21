/**
 * Puppet mutations — local edits that never call a provider (D36).
 *
 * Every operation here is pure `doc → doc` and flows through the one command
 * layer, so puppet edits inherit undo, transactions and persistence with no
 * second history system. Crucially they are also *local*: an expression change
 * touches one field on one instance and cannot reach a body texture, a
 * transform, a panel or another instance.
 */

import { cloneDoc, touch } from "./docHelpers";
import { canApplyExpression, canApplyJoint, type PuppetCapabilityResult } from "@/puppet/capability";
import {
  clampJoint,
  createPuppetInstanceState,
  type MangaPuppet,
  type PoseParameters,
  type PuppetJoint,
  type PuppetPartType,
} from "@/puppet/model";
import type { AssetInstance, ID, ProjectDocument } from "./types";

function requirePuppetInstance(doc: ProjectDocument, instanceId: ID): AssetInstance {
  const item = doc.items[instanceId];
  if (!item) throw new Error(`Unknown item: ${instanceId}`);
  if (item.kind !== "asset") throw new Error("Only asset instances can carry a puppet");
  if (!item.puppet) throw new Error("This character is not a puppet");
  return item;
}

export function puppetForInstance(doc: ProjectDocument, instance: AssetInstance): MangaPuppet | undefined {
  return instance.puppet ? doc.puppets[instance.puppet.puppetId] : undefined;
}

/** Whether a placed instance is an articulated actor or a legacy flat render. */
export function isPuppetInstance(doc: ProjectDocument, instanceId: ID): boolean {
  const item = doc.items[instanceId];
  return item?.kind === "asset" && Boolean(item.puppet && doc.puppets[item.puppet.puppetId]);
}

/** Register a compiled puppet and attach it to its character. */
export function registerPuppet(doc: ProjectDocument, puppet: MangaPuppet): ProjectDocument {
  const next = cloneDoc(doc);
  const character = next.characters[puppet.characterId];
  if (!character) throw new Error(`Unknown character: ${puppet.characterId}`);
  next.puppets[puppet.id] = puppet;
  character.puppetId = puppet.id;
  touch(next);
  return next;
}

/**
 * Turn a placed instance into a puppet actor.
 *
 * The instance keeps its transform, stage, panel and z-order — only how it
 * rasterizes changes, which is what lets an existing composition gain
 * articulation without being rebuilt.
 */
export function attachPuppetToInstance(doc: ProjectDocument, instanceId: ID, puppetId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  const item = next.items[instanceId];
  if (item?.kind !== "asset") throw new Error("Only asset instances can carry a puppet");
  const puppet = next.puppets[puppetId];
  if (!puppet) throw new Error(`Unknown puppet: ${puppetId}`);
  item.puppet = createPuppetInstanceState(puppet);
  touch(next);
  return next;
}

export function detachPuppetFromInstance(doc: ProjectDocument, instanceId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  const item = next.items[instanceId];
  if (item?.kind !== "asset") return next;
  delete item.puppet;
  touch(next);
  return next;
}

/**
 * Swap the face (§5).
 *
 * The single most important operation in this phase: it writes ONE string and
 * nothing else. Body parts, transforms, pose, outfit, stage and panel are not
 * even reachable from here, so "changing the expression replaced the whole
 * character" is structurally impossible rather than merely tested against.
 */
export function setPuppetExpression(doc: ProjectDocument, instanceId: ID, expressionId: string): ProjectDocument {
  const next = cloneDoc(doc);
  const instance = requirePuppetInstance(next, instanceId);
  const puppet = puppetForInstance(next, instance);
  if (!puppet) throw new Error("Puppet model is missing");

  const capability = canApplyExpression(puppet, expressionId);
  if (!capability.supported) throw new PuppetCapabilityError(capability);

  instance.puppet = { ...instance.puppet!, expressionId };
  touch(next);
  return next;
}

/** Rotate one joint. Children follow through the transform hierarchy, not here. */
export function setPuppetJoint(
  doc: ProjectDocument,
  instanceId: ID,
  joint: PuppetJoint,
  degrees: number,
): ProjectDocument {
  const next = cloneDoc(doc);
  const instance = requirePuppetInstance(next, instanceId);
  const puppet = puppetForInstance(next, instance);
  if (!puppet) throw new Error("Puppet model is missing");

  const capability = canApplyJoint(puppet, joint, degrees);
  if (!capability.supported) throw new PuppetCapabilityError(capability);

  const pose: PoseParameters = { ...instance.puppet!.pose, [joint]: clampJoint(joint, degrees) };
  instance.puppet = { ...instance.puppet!, pose };
  touch(next);
  return next;
}

export function resetPuppetPose(doc: ProjectDocument, instanceId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  const instance = requirePuppetInstance(next, instanceId);
  instance.puppet = { ...instance.puppet!, pose: {} };
  touch(next);
  return next;
}

/** Swap a single part on one instance — hand variants, alternate hair. */
export function setPuppetPartOverride(
  doc: ProjectDocument,
  instanceId: ID,
  partType: PuppetPartType,
  partId: ID | undefined,
): ProjectDocument {
  const next = cloneDoc(doc);
  const instance = requirePuppetInstance(next, instanceId);
  const puppet = puppetForInstance(next, instance);
  if (partId && !puppet?.parts[partId]) throw new Error(`Unknown puppet part: ${partId}`);

  const overrides = { ...(instance.puppet!.partOverrides ?? {}) };
  if (partId) overrides[partType] = partId;
  else delete overrides[partType];
  instance.puppet = {
    ...instance.puppet!,
    partOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
  };
  touch(next);
  return next;
}

/** Attach or remove a prop on this instance only. */
export function setPuppetAttachment(
  doc: ProjectDocument,
  instanceId: ID,
  attachmentId: ID,
  attached: boolean,
): ProjectDocument {
  const next = cloneDoc(doc);
  const instance = requirePuppetInstance(next, instanceId);
  const puppet = puppetForInstance(next, instance);
  if (attached && !puppet?.attachments[attachmentId]) throw new Error(`Unknown attachment: ${attachmentId}`);

  const current = new Set(instance.puppet!.attachments ?? []);
  if (attached) current.add(attachmentId);
  else current.delete(attachmentId);
  instance.puppet = { ...instance.puppet!, attachments: current.size > 0 ? [...current] : undefined };
  touch(next);
  return next;
}

/** Thrown when a local edit exceeds what the puppet can represent (§8). */
export class PuppetCapabilityError extends Error {
  readonly capability: PuppetCapabilityResult;
  constructor(capability: PuppetCapabilityResult) {
    super(capability.reason ?? "The puppet cannot represent this change");
    this.name = "PuppetCapabilityError";
    this.capability = capability;
  }
}
