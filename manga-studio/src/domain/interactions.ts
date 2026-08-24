/**
 * Scene interactions: coordinated actions between characters.
 *
 * ## The rule this module exists to enforce
 *
 * `hug(Yuri, Mio)` must NEVER decay into `Yuri.pose = "hug"` plus
 * `Mio.pose = "hug"` generated independently. Two independent renders share no
 * geometry, so the arms miss, the torsos interpenetrate, the heads sit at
 * unrelated heights and the scales disagree. An interaction owns the geometry
 * that is *between* the participants; that is the whole reason it is a separate
 * object rather than a pose value on each character.
 *
 * ## Local versus generative
 *
 * Some interactions are just placement (`beside`), some are a shared contact
 * point two rigs can reach (`hold_hands`), and some require the participants to
 * genuinely overlap and occlude each other (`hug`). Forcing all three through
 * puppet deformation would produce broken artwork; forcing all three through
 * generation would burn money on a problem that is arithmetic. The capability
 * evaluator picks, and says why.
 */

import { newId, now } from "./factory";
import { cloneDoc, touch } from "./docHelpers";
import type {
  CharacterInteraction,
  ID,
  InteractionAnchor,
  InteractionParameters,
  InteractionParticipant,
  InteractionRender,
  InteractionRenderMode,
  InteractionType,
  Point,
  ProjectDocument,
} from "./types";
import { resolveCharacterIdentityReference } from "@/characters/identityReference";
import { canApplyJoint } from "@/puppet/capability";
import { partOfType, type MangaPuppet } from "@/puppet/model";

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export const INTERACTION_TYPES: InteractionType[] = [
  "beside",
  "face_to_face",
  "look_at",
  "hold_hands",
  "hug",
  "high_five",
  "hand_object",
  "lean_on",
  "walk_together",
  "sit_together",
];

export const INTERACTION_LABELS: Record<InteractionType, string> = {
  beside: "Beside",
  face_to_face: "Face to Face",
  look_at: "Look At",
  hold_hands: "Hold Hands",
  hug: "Hug",
  high_five: "High Five",
  hand_object: "Hand Over Object",
  lean_on: "Lean On",
  walk_together: "Walk Together",
  sit_together: "Sit Together",
};

/**
 * Phrases a creator or the Agent might use, mapped to a type.
 *
 * Longest match wins so "hold hands" beats "hand". Anything unlisted resolves
 * to null rather than being coerced into the nearest-looking interaction.
 */
const INTERACTION_TERMS: { terms: string[]; type: InteractionType }[] = [
  { terms: ["hold hands", "holding hands", "hold her hand", "hold his hand"], type: "hold_hands" },
  { terms: ["high five", "high-five"], type: "high_five" },
  { terms: ["hug", "hugs", "hugging", "embrace", "embraces"], type: "hug" },
  { terms: ["hand over", "hands over", "give", "gives", "pass", "passes"], type: "hand_object" },
  { terms: ["lean on", "leans on", "leaning on"], type: "lean_on" },
  { terms: ["walk together", "walking together", "walk with", "walks with"], type: "walk_together" },
  { terms: ["sit together", "sitting together", "sit with", "sits with"], type: "sit_together" },
  { terms: ["face to face", "facing each other", "face each other"], type: "face_to_face" },
  { terms: ["look at", "looks at", "looking at", "stare at", "stares at"], type: "look_at" },
  { terms: ["beside", "next to", "stand with", "stands with"], type: "beside" },
];

export function interactionTypeFromPhrase(phrase: string): InteractionType | null {
  const text = phrase.toLowerCase();
  const matches = INTERACTION_TERMS.flatMap((entry) =>
    entry.terms.filter((term) => text.includes(term)).map((term) => ({ term, type: entry.type })),
  ).sort((a, b) => b.term.length - a.term.length);
  return matches[0]?.type ?? null;
}

// ─── Capability ─────────────────────────────────────────────────────────────

export type InteractionMode = "LOCAL_STAGE" | "LOCAL_PUPPET" | "HYBRID" | "JOINT_GENERATION";

export interface InteractionCapabilityResult {
  supportedLocally: boolean;
  mode: InteractionMode;
  reason?: string;
  /** Which participants lack the rig this interaction would need. */
  blockedBy?: ID[];
}

/** Interactions that are pure placement — no rig involvement at all. */
const STAGE_ONLY: InteractionType[] = ["beside", "face_to_face", "walk_together", "sit_together"];

/** Interactions realised by a shared contact point two rigs reach toward. */
const CONTACT: Partial<Record<InteractionType, { joint: "wristLeft" | "wristRight"; contact: "leftHand" | "rightHand" }>> = {
  hold_hands: { joint: "wristRight", contact: "rightHand" },
  high_five: { joint: "wristRight", contact: "rightHand" },
  hand_object: { joint: "wristRight", contact: "rightHand" },
};

/**
 * Interactions whose participants genuinely overlap and occlude one another.
 *
 * These are not a rig problem. A hug needs one arm *behind* the other person's
 * back, which flat parts cannot express at all — no joint rotation produces
 * occlusion that the source artwork does not contain.
 */
const REQUIRES_JOINT_RENDER: InteractionType[] = ["hug", "lean_on"];

export interface CapabilityInput {
  type: InteractionType;
  /** Puppet per participant, when they have one. */
  puppets: (MangaPuppet | undefined)[];
  participantIds: ID[];
}

export function evaluateInteractionCapability(input: CapabilityInput): InteractionCapabilityResult {
  const { type, puppets, participantIds } = input;

  if (participantIds.length < 2) {
    return { supportedLocally: false, mode: "JOINT_GENERATION", reason: "An interaction needs at least two participants." };
  }

  if (STAGE_ONLY.includes(type)) {
    // Pure placement: works for flat characters and puppets alike, because it
    // only moves whole actors on the existing stage.
    return { supportedLocally: true, mode: "LOCAL_STAGE" };
  }

  if (REQUIRES_JOINT_RENDER.includes(type)) {
    return {
      supportedLocally: false,
      mode: "JOINT_GENERATION",
      reason: `A ${INTERACTION_LABELS[type].toLowerCase()} needs the characters to overlap and occlude each other, which cannot be produced by moving existing artwork.`,
    };
  }

  if (type === "look_at") {
    // Turning a head is a single joint, so this is local when both have one.
    const blockedBy = participantIds.filter((_, index) => {
      const puppet = puppets[index];
      return !puppet || !canApplyJoint(puppet, "head", 20).supported;
    });
    if (blockedBy.length === 0) return { supportedLocally: true, mode: "LOCAL_PUPPET" };
    return {
      supportedLocally: false,
      mode: "JOINT_GENERATION",
      blockedBy,
      reason: "Looking at each other needs head rotation these characters cannot do locally.",
    };
  }

  const contact = CONTACT[type];
  if (contact) {
    const blockedBy = participantIds.filter((_, index) => {
      const puppet = puppets[index];
      if (!puppet) return true;
      // Both an articulated arm and a hand part are needed to meet an anchor.
      return !partOfType(puppet, "handRight") || !canApplyJoint(puppet, contact.joint, 20).supported;
    });
    if (blockedBy.length === 0) return { supportedLocally: true, mode: "LOCAL_PUPPET" };
    /**
     * One rigged participant and one flat one is genuinely a hybrid: the rigged
     * arm can reach the anchor while the flat character is only positioned.
     * Reporting that honestly beats pretending either extreme.
     */
    if (blockedBy.length < participantIds.length) {
      return {
        supportedLocally: false,
        mode: "HYBRID",
        blockedBy,
        reason: "Only some participants can reach a shared contact point; the rest can only be positioned.",
      };
    }
    return {
      supportedLocally: false,
      mode: "JOINT_GENERATION",
      blockedBy,
      reason: "Neither character has an arm rig that can reach a shared contact point.",
    };
  }

  return { supportedLocally: false, mode: "JOINT_GENERATION", reason: "This interaction has no local representation yet." };
}

// ─── Document operations ────────────────────────────────────────────────────

/**
 * Minimal socket/zone vocabulary (v0.2). Semantic connection points, not a
 * physics rig: enough to SAY "right_hand → handle" or "body → driver-seat".
 * Creators may also type a custom socket/zone — these are suggestions.
 */
export const CHARACTER_SOCKETS = ["left_hand", "right_hand", "both_hands", "body", "back", "head"] as const;
export const OBJECT_SOCKETS = ["handle", "grip", "container", "surface"] as const;
export const SCENE_ZONES = ["driver-seat", "passenger-seat", "chair", "doorway", "desk", "bed"] as const;

/** Creator-facing label: known types get a name, custom verbs are prettified. */
export function interactionLabel(type: string): string {
  return INTERACTION_LABELS[type as InteractionType] ?? type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Full participant list, tolerating pre-v13 documents. */
export function interactionParticipants(interaction: CharacterInteraction): InteractionParticipant[] {
  return (
    interaction.participants ??
    interaction.participantIds.map((id, index) => ({
      id,
      kind: "character" as const,
      role: index === 0 ? "initiator" : "target",
    }))
  );
}

export interface CreateInteractionInput {
  panelId: ID;
  participantIds: ID[];
  /** Full participant list when objects/scenes take part (v0.2+). */
  participants?: InteractionParticipant[];
  type: InteractionType | (string & {});
  roles?: Record<string, ID>;
  parameters?: InteractionParameters;
  source?: CharacterInteraction["source"];
  renderMode?: InteractionRenderMode;
  anchors?: InteractionAnchor[];
  status?: CharacterInteraction["status"];
}

export function createInteraction(
  doc: ProjectDocument,
  input: CreateInteractionInput,
): { doc: ProjectDocument; interactionId: ID } {
  if (!doc.panels[input.panelId]) throw new Error(`Unknown panel: ${input.panelId}`);
  const participants = input.participants ?? input.participantIds.map((id, index) => ({
    id,
    kind: "character" as const,
    role: index === 0 ? "initiator" : "target",
  }));
  if (participants.length < 2) throw new Error("An interaction needs at least two participants");
  for (const participant of participants) {
    if (participant.kind === "character") {
      if (!doc.characters[participant.id]) throw new Error(`Unknown character: ${participant.id}`);
    } else {
      // Objects and scenes participate as library assets (prop / background).
      const asset = doc.assets[participant.id];
      if (!asset) throw new Error(`Unknown asset: ${participant.id}`);
      const expected = participant.kind === "object" ? "prop" : "background";
      if (asset.category !== expected) {
        throw new Error(`Asset "${asset.name}" is a ${asset.category}, not a ${expected}`);
      }
    }
  }
  const next = cloneDoc(doc);
  const interaction: CharacterInteraction = {
    id: newId(),
    panelId: input.panelId,
    participantIds: participants.filter((p) => p.kind === "character").map((p) => p.id),
    participants,
    type: input.type,
    roles: input.roles,
    parameters: input.parameters,
    source: input.source,
    anchors: input.anchors,
    renderMode: input.renderMode,
    status: input.status ?? "planned",
    createdAt: now(),
  };
  next.interactions[interaction.id] = interaction;
  touch(next);
  return { doc: next, interactionId: interaction.id };
}

/**
 * Edit an existing interaction's semantics. Editing parameters invalidates a
 * composite render's reuse claim implicitly through the cache key, which now
 * includes the parameters — no stale image survives an edit.
 */
export function updateInteraction(
  doc: ProjectDocument,
  interactionId: ID,
  patch: {
    type?: CharacterInteraction["type"];
    parameters?: InteractionParameters;
    participants?: InteractionParticipant[];
    roles?: Record<string, ID>;
  },
): ProjectDocument {
  const current = doc.interactions[interactionId];
  if (!current) throw new Error(`Unknown interaction: ${interactionId}`);
  const participants = patch.participants ?? current.participants;
  const next = cloneDoc(doc);
  const interaction = next.interactions[interactionId];
  if (patch.type !== undefined) interaction.type = patch.type;
  if (patch.parameters !== undefined) interaction.parameters = patch.parameters;
  if (patch.roles !== undefined) interaction.roles = patch.roles;
  if (participants !== undefined) {
    interaction.participants = participants;
    interaction.participantIds = participants.filter((p) => p.kind === "character").map((p) => p.id);
  }
  touch(next);
  return next;
}

export function removeInteraction(doc: ProjectDocument, interactionId: ID): ProjectDocument {
  if (!doc.interactions[interactionId]) return doc;
  const next = cloneDoc(doc);
  delete next.interactions[interactionId];
  touch(next);
  return next;
}

/** Attach a shared contact anchor, e.g. the point two joined hands meet at. */
export function setInteractionAnchor(
  doc: ProjectDocument,
  interactionId: ID,
  anchor: InteractionAnchor,
): ProjectDocument {
  const next = cloneDoc(doc);
  const interaction = next.interactions[interactionId];
  if (!interaction) throw new Error(`Unknown interaction: ${interactionId}`);
  const anchors = interaction.anchors ?? [];
  const index = anchors.findIndex((candidate) => candidate.id === anchor.id);
  if (index === -1) anchors.push(anchor);
  else anchors[index] = anchor;
  interaction.anchors = anchors;
  touch(next);
  return next;
}

/** Interactions in a panel, optionally filtered to those involving a character. */
export function interactionsInPanel(doc: ProjectDocument, panelId: ID, characterId?: ID): CharacterInteraction[] {
  return Object.values(doc.interactions ?? {}).filter(
    (interaction) =>
      interaction.panelId === panelId &&
      (!characterId || interaction.participantIds.includes(characterId)),
  );
}

// ─── Shared anchors ─────────────────────────────────────────────────────────

/**
 * The midpoint two participants should both reach.
 *
 * Deliberately arithmetic, not a solver: the anchor sits between the actors at
 * a plausible hand height, and each rig aims at it. Building a constraint
 * solver here would be the "physics engine" the brief rules out, and it would
 * not survive contact with flat artwork anyway.
 */
export function midpointAnchor(
  a: { cx: number; cy: number; width: number; height: number },
  b: { cx: number; cy: number; width: number; height: number },
  contacts: InteractionAnchor["contacts"],
  id = "shared-hand",
): InteractionAnchor {
  const at: Point = {
    x: (a.cx + b.cx) / 2,
    // Hands hang around two-thirds down the figure; use the shorter actor so
    // the taller one reaches down rather than the shorter one reaching up.
    y: Math.max(a.cy + a.height * 0.18, b.cy + b.height * 0.18),
  };
  return { id, at, contacts };
}

/** How far each participant's contact point currently sits from the anchor. */
export function anchorDeviation(
  anchor: InteractionAnchor,
  contactPoints: Record<ID, Point>,
): { participantId: ID; distance: number }[] {
  return Object.entries(anchor.contacts).map(([participantId]) => {
    const point = contactPoints[participantId];
    return {
      participantId,
      distance: point ? Math.hypot(point.x - anchor.at.x, point.y - anchor.at.y) : Infinity,
    };
  });
}

// ─── Joint generation contract ──────────────────────────────────────────────

export interface MultiCharacterGenerationRequest {
  participantCharacterIds: ID[];
  /** One identity reference per participant, in the same order. Never merged. */
  participantReferenceAssetIds: ID[];
  interactionType: string;
  roles?: Record<string, ID>;
  cameraContext?: string[];
  styleProfileId?: ID;
  identityConstraints: string[];
  outfitConstraints: string[];
  interactionConstraints: string[];
}

/**
 * Everything that makes a joint render reusable.
 *
 * Participants are sorted so Yuri+Mio and Mio+Yuri share a cache entry, but the
 * ROLES are included unsorted — "Yuri hugs Mio" and "Mio hugs Yuri" are
 * different images. Outfits, view, expressions and style are included because a
 * school uniform hug is not a casual-clothes hug, and a smiling one is not a
 * tearful one.
 */
export function interactionCacheKey(input: {
  participantCharacterIds: ID[];
  /**
   * All participants including objects/scenes, as "kind:id". "Yuri+ramen"
   * must not share a character-only cache entry.
   */
  participantKeys?: string[];
  type: string;
  roles?: Record<string, ID>;
  /** Editable semantics — a from-behind hug is not the same drawing as a front hug. */
  parameters?: InteractionParameters;
  outfits: string[];
  view: string;
  styleProfileId?: ID;
  shot?: string;
  angle?: string;
  /** Expression per participant, keyed by character id. */
  expressions?: Record<ID, string>;
}): string {
  const participants = [...(input.participantKeys ?? input.participantCharacterIds)].sort();
  const roles = Object.entries(input.roles ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, id]) => `${role}:${id}`)
    .join(",");
  const outfits = [...input.outfits].map((outfit) => outfit.trim().toLowerCase()).sort();
  const parameters = Object.entries(input.parameters ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("+") : value}`)
    .join(",");
  return [
    `p=${participants.join("+")}`,
    `t=${input.type}`,
    `r=${roles}`,
    `m=${parameters}`,
    `o=${outfits.join("+")}`,
    `v=${input.view.trim().toLowerCase()}`,
    `s=${input.styleProfileId ?? "default"}`,
    `c=${input.shot ?? "any"}/${input.angle ?? "any"}`,
    // A smiling hug and a crying hug are not the same drawing, so they must not
    // share a cache entry.
    `e=${Object.entries(input.expressions ?? {})
      .map(([id, expression]) => `${id}:${expression.trim().toLowerCase()}`)
      .sort()
      .join(",")}`,
  ].join("|");
}

/** An existing joint render for this exact configuration, or null. */
export function findInteractionRender(doc: ProjectDocument, cacheKey: string): InteractionRender | null {
  return (
    Object.values(doc.interactionRenders ?? {}).find((render) => {
      if (render.cacheKey !== cacheKey) return false;
      // A render whose asset was deleted is not reusable.
      const asset = doc.assets[render.generatedAssetId];
      return Boolean(asset) && asset.status !== "archived";
    }) ?? null
  );
}

export function recordInteractionRender(
  doc: ProjectDocument,
  input: Omit<InteractionRender, "id" | "createdAt">,
): { doc: ProjectDocument; renderId: ID } {
  const next = cloneDoc(doc);
  const render: InteractionRender = { ...input, id: newId(), createdAt: now() };
  next.interactionRenders[render.id] = render;
  const interaction = next.interactions[input.interactionId];
  if (interaction) {
    interaction.renderId = render.id;
    interaction.renderMode = "composite";
    interaction.status = "active";
  }
  touch(next);
  return { doc: next, renderId: render.id };
}

/**
 * Which characters a generated image actually contains.
 *
 * Grounding and deletion both need this: a composite render of Yuri and Mio is
 * not "a Yuri asset", and deleting Mio should be able to report that it would
 * orphan this image.
 */
export function charactersInAsset(doc: ProjectDocument, assetId: ID): ID[] {
  const render = Object.values(doc.interactionRenders ?? {}).find(
    (candidate) => candidate.generatedAssetId === assetId,
  );
  if (render) return [...render.participantCharacterIds];
  const single = doc.assets[assetId]?.metadata?.characterId;
  return single ? [single] : [];
}

/**
 * Build the joint-generation request.
 *
 * Every participant contributes their OWN reference image. Describing one
 * character in text while sending the other's picture is what makes a model
 * blend two people into one, so a participant without a usable reference is a
 * hard failure rather than a text fallback.
 */
export function buildMultiCharacterRequest(
  doc: ProjectDocument,
  interaction: CharacterInteraction,
  context: { cameraContext?: string[]; styleProfileId?: ID; outfits?: Record<ID, string> },
): MultiCharacterGenerationRequest {
  /**
   * Identity comes from the canonical reference, resolved through the one
   * resolver every surface shares. Reading the stored pointer directly is what
   * made this fail on documents that plainly contained a usable picture.
   */
  const references: ID[] = [];
  for (const characterId of interaction.participantIds) {
    const resolved = resolveCharacterIdentityReference(doc, characterId);
    if (resolved.status !== "resolved" || !resolved.assetId) {
      throw new Error(resolved.reason ?? `${resolved.characterName} has no usable reference image yet.`);
    }
    references.push(resolved.assetId);
  }

  const names = interaction.participantIds.map((id) => doc.characters[id]?.name ?? id);
  return {
    participantCharacterIds: [...interaction.participantIds],
    participantReferenceAssetIds: references,
    interactionType: interaction.type,
    roles: interaction.roles,
    cameraContext: context.cameraContext,
    styleProfileId: context.styleProfileId,
    identityConstraints: names.map(
      (name, index) =>
        `Preserve ${name}'s exact face, hairstyle and proportions from reference image ${index + 1}. Do not blend their features with the other character.`,
    ),
    outfitConstraints: interaction.participantIds.map((id, index) => {
      const outfit = context.outfits?.[id];
      return outfit
        ? `${names[index]} wears ${outfit}, unchanged.`
        : `Keep ${names[index]}'s outfit exactly as shown in reference image ${index + 1}.`;
    }),
    interactionConstraints: interactionConstraintsFor(interaction.type, names),
  };
}

function interactionConstraintsFor(type: string, names: string[]): string[] {
  const [first, second] = names;
  const shared = [
    "Both characters occupy the same scene, at the same scale, from one consistent viewpoint.",
    "Consistent lighting and one shared perspective across both figures.",
  ];
  switch (type) {
    case "hug":
      return [
        `${first} and ${second} share a natural mutual embrace, arms wrapped around each other with believable contact and overlap.`,
        "Show correct occlusion where one figure passes behind the other.",
        ...shared,
      ];
    case "lean_on":
      return [`${second} leans against ${first} with real contact and weight.`, ...shared];
    case "hold_hands":
      return [`${first} and ${second} hold hands, with their hands actually meeting.`, ...shared];
    case "high_five":
      return [`${first} and ${second} high-five, palms meeting at one point.`, ...shared];
    default:
      return [`${first} and ${second} ${interactionLabel(type).toLowerCase()}.`, ...shared];
  }
}

// ─── Mixed-participant render contract (v0.2) ───────────────────────────────

export interface InteractionRenderRequest {
  /** One reference image per participant, in participant order. Never merged. */
  participantReferenceAssetIds: ID[];
  /** Character ids among the participants (provenance for joint renders). */
  participantCharacterIds: ID[];
  interactionType: string;
  roles?: Record<string, ID>;
  identityConstraints: string[];
  outfitConstraints: string[];
  interactionConstraints: string[];
}

/**
 * Sentence form of the editable parameters — "from behind, high intensity,
 * right hand on the grip". Included in the prompt AND the cache key, so an
 * edited interaction is regenerated, never served stale from cache.
 */
export function describeInteractionParameters(parameters?: InteractionParameters): string[] {
  if (!parameters) return [];
  const parts: string[] = [];
  if (parameters.direction) parts.push(`direction: ${parameters.direction}`);
  if (parameters.facing) parts.push(`facing: ${parameters.facing}`);
  if (parameters.pose) parts.push(`pose: ${parameters.pose}`);
  if (parameters.hand && parameters.hand !== "auto") parts.push(`using ${parameters.hand} hand${parameters.hand === "both" ? "s" : ""}`);
  if (parameters.contact?.length) parts.push(`contact: ${parameters.contact.join(", ")}`);
  if (parameters.intensity !== undefined) parts.push(`intensity ${Math.round(parameters.intensity * 100)}%`);
  if (parameters.distance !== undefined) parts.push(`distance ${Math.round(parameters.distance * 100)}%`);
  if (parameters.customInstruction) parts.push(parameters.customInstruction);
  return parts;
}

/**
 * Build the joint-generation request for ANY participant mix.
 *
 * Characters contribute their canonical identity reference; objects and scenes
 * contribute their library image. Every participant's picture travels — nobody
 * is demoted to a text description the model would re-invent.
 */
export function buildInteractionRenderRequest(
  doc: ProjectDocument,
  interaction: CharacterInteraction,
  context: { styleProfileId?: ID; outfits?: Record<ID, string> },
): InteractionRenderRequest {
  const participants = interactionParticipants(interaction);
  const referenceAssetIds: ID[] = [];
  const characterIds: ID[] = [];
  const identityConstraints: string[] = [];
  const outfitConstraints: string[] = [];
  const names: string[] = [];

  participants.forEach((participant, index) => {
    if (participant.kind === "character") {
      const resolved = resolveCharacterIdentityReference(doc, participant.id);
      if (resolved.status !== "resolved" || !resolved.assetId) {
        throw new Error(resolved.reason ?? `${resolved.characterName} has no usable reference image yet.`);
      }
      referenceAssetIds.push(resolved.assetId);
      characterIds.push(participant.id);
      const name = doc.characters[participant.id]?.name ?? participant.id;
      names.push(name);
      identityConstraints.push(
        `Preserve ${name}'s exact face, hairstyle and proportions from reference image ${index + 1}. Do not blend their features with anything else.`,
      );
      const outfit = context.outfits?.[participant.id];
      outfitConstraints.push(
        outfit
          ? `${name} wears ${outfit}, unchanged.`
          : `Keep ${name}'s outfit exactly as shown in reference image ${index + 1}.`,
      );
      return;
    }
    const asset = doc.assets[participant.id];
    if (!asset) throw new Error("An interaction participant is missing from the library.");
    referenceAssetIds.push(participant.id);
    names.push(asset.name);
    identityConstraints.push(
      participant.kind === "object"
        ? `Reference image ${index + 1} is the object "${asset.name}": keep its exact appearance in the interaction.`
        : `Reference image ${index + 1} is the scene "${asset.name}": match its perspective, lighting and layout.`,
    );
  });

  const zone = participants.find((p) => p.zone)?.zone;
  /**
   * A zone is a promise about the picture, not a label: the driver-seat means
   * hands on the steering wheel. Without this the model draws a person
   * floating in a car-shaped space.
   */
  const ZONE_ACTION: Record<string, string> = {
    "driver-seat": "hands on the steering wheel",
    "passenger-seat": "seated beside the driver",
    chair: "seated on the chair",
    desk: "seated at the desk",
    bed: "lying on the bed",
    doorway: "standing in the doorway",
  };
  /**
   * The creator's own words lead the prompt when present: "Yuri is entering
   * the street from the left" carries more staging truth than any enum label.
   * The structured label and parameters stay as supporting details, never as a
   * replacement for the described action.
   */
  const custom = interaction.parameters?.customInstruction?.trim();
  const supportingParameters = custom
    ? { ...interaction.parameters, customInstruction: undefined }
    : interaction.parameters;
  const interactionConstraints = [
    custom ?? `${interactionLabel(interaction.type)}: ${names.join(" and ")}.`,
    ...(zone
      ? [
          `The character occupies the ${zone} zone of the scene${ZONE_ACTION[zone] ? `, ${ZONE_ACTION[zone]},` : ""} body and perspective matching it.`,
        ]
      : []),
    ...describeInteractionParameters(supportingParameters).map((part) => `Interaction detail — ${part}.`),
    "All participants occupy the same scene, at a consistent scale, from one viewpoint, with consistent lighting.",
  ];

  return {
    participantReferenceAssetIds: referenceAssetIds,
    participantCharacterIds: characterIds,
    interactionType: interaction.type,
    roles: interaction.roles,
    identityConstraints,
    outfitConstraints,
    interactionConstraints,
  };
}
