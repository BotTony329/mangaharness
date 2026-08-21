/**
 * The puppet capability boundary (§8).
 *
 * A puppet must never silently distort itself to fake a pose it cannot hold.
 * When a request exceeds what parts and joints can represent, the answer is an
 * explicit refusal with a reason and a fallback recommendation — which is what
 * hands the request to the AI path deliberately instead of by accident.
 *
 * This is also where `PartReadiness` earns its place: a puppet whose hidden
 * regions were never reconstructed cannot claim a big swing is safe, because
 * swinging the arm away would expose material that does not exist.
 */

import {
  JOINT_LIMITS,
  JOINT_PART,
  jointWithinLimits,
  partOfType,
  type MangaPuppet,
  type PoseParameters,
  type PuppetJoint,
} from "./model";

export type CapabilityQuality = "safe" | "approximate";

export interface PuppetCapabilityResult {
  supported: boolean;
  quality?: CapabilityQuality;
  reason?: string;
  fallbackRecommendation?: string;
}

const SUPPORTED_SAFE: PuppetCapabilityResult = { supported: true, quality: "safe" };

/** Rotation beyond which uncovered material is likely to show. */
const HIDDEN_REGION_SAFE_SWING = 35;

/** Can this puppet show this expression? */
export function canApplyExpression(puppet: MangaPuppet, expressionId: string): PuppetCapabilityResult {
  const expression = puppet.expressions[expressionId];
  if (!expression) {
    return {
      supported: false,
      reason: `This puppet has no "${expressionId}" face.`,
      fallbackRecommendation: "Generate the missing expression artwork, then recompile it into the puppet.",
    };
  }
  const missing = Object.values(expression.parts).filter((partId) => !puppet.parts[partId]);
  if (missing.length > 0) {
    return {
      supported: false,
      reason: "The expression references parts this puppet does not have.",
      fallbackRecommendation: "Recompile the puppet.",
    };
  }
  return SUPPORTED_SAFE;
}

/** Can this puppet hold this joint rotation? */
export function canApplyJoint(puppet: MangaPuppet, joint: PuppetJoint, degrees: number): PuppetCapabilityResult {
  const part = partOfType(puppet, JOINT_PART[joint]);
  if (!part) {
    return {
      supported: false,
      reason: `This puppet has no articulated ${JOINT_PART[joint]}.`,
      fallbackRecommendation: "Redraw the pose with AI, or compile a puppet that includes this limb.",
    };
  }
  if (!jointWithinLimits(joint, degrees)) {
    const limit = JOINT_LIMITS[joint];
    return {
      supported: false,
      reason: `${joint} can rotate between ${limit.min}° and ${limit.max}°; ${Math.round(degrees)}° is outside that.`,
      fallbackRecommendation: "Ask AI to redraw the character in this pose.",
    };
  }

  // A big swing reveals whatever the part used to cover. If that material was
  // never reconstructed, the pose is representable but not clean — say so
  // rather than rendering a hole.
  if (Math.abs(degrees) > HIDDEN_REGION_SAFE_SWING && !part.readiness.hiddenRegionComplete) {
    return {
      supported: true,
      quality: "approximate",
      reason: "Material hidden behind this part was never reconstructed, so a large movement may expose gaps.",
      fallbackRecommendation: "Recompile the puppet with hidden-region reconstruction, or redraw with AI.",
    };
  }
  return SUPPORTED_SAFE;
}

/** Can this puppet hold a whole pose? Worst individual joint decides. */
export function canApplyPose(puppet: MangaPuppet, pose: PoseParameters): PuppetCapabilityResult {
  let worst: PuppetCapabilityResult = SUPPORTED_SAFE;
  for (const [joint, degrees] of Object.entries(pose)) {
    const result = canApplyJoint(puppet, joint as PuppetJoint, degrees ?? 0);
    if (!result.supported) return result;
    if (result.quality === "approximate") worst = result;
  }
  return worst;
}

/**
 * Whether a semantic request can be met locally at all (§8/§17).
 *
 * Views and whole-body silhouette changes are explicitly out of reach: a
 * front-facing set of parts cannot become a back view by rotating anything, and
 * a puppet with no legs cannot crouch. Naming these keeps the Agent from
 * discovering them by producing something broken.
 */
export function canRepresentView(puppet: MangaPuppet, view: string): PuppetCapabilityResult {
  const wanted = view.trim().toLowerCase();
  if (wanted === "front" || wanted === "") return SUPPORTED_SAFE;
  return {
    supported: false,
    reason: `This puppet only holds a front view; "${view}" needs different artwork.`,
    fallbackRecommendation: "Generate the character in that view, then compile a puppet for it.",
  };
}

export function canRepresentPoseChange(puppet: MangaPuppet, descriptors: string[]): PuppetCapabilityResult {
  const unsupported = descriptors.find((descriptor) => {
    const text = descriptor.toLowerCase();
    return text.includes("knee") || text.includes("leg") || text.includes("torso lean") || text.includes("stride");
  });
  if (unsupported && !partOfType(puppet, "upperLegLeft")) {
    return {
      supported: false,
      reason: `"${unsupported}" needs leg articulation this puppet does not have.`,
      fallbackRecommendation: "Ask AI to redraw the character in this pose.",
    };
  }
  return SUPPORTED_SAFE;
}

/** One-line summary for the UI cost/latency hint (§18). */
export function describeCost(result: PuppetCapabilityResult): "instant" | "instant-approximate" | "generation" {
  if (!result.supported) return "generation";
  return result.quality === "approximate" ? "instant-approximate" : "instant";
}
