"use client";

/**
 * Capability Router — translates the Creative Task Map into the existing
 * tool-step plan the deterministic harness (agent-v2 orchestrator) executes.
 *
 * It reimplements NO service logic: every creative intent maps onto the same
 * tools the editor and the old engine already use, so transactions, rollback,
 * preserved-asset honesty and placeholder protection all apply unchanged.
 *
 * Identity rule: steps address characters by NAME only. Real IDs are bound at
 * execution time by the runtime binding table — this module never emits one
 * for a character being created.
 */

import type { AgentPlan } from "@/agent/tools/schemas";
import type { CreativeTaskMap, CameraIntent } from "../contract/creativeTaskMap";
import type { Resolution } from "../resolution/entityResolver";

type Step = AgentPlan["steps"][number];

/** Camera words that must reach GENERATION when the viewpoint is redrawn. */
function cameraForGeneration(camera: CameraIntent | undefined): string | undefined {
  if (!camera?.requiresRedraw && camera?.angle !== "low" && camera?.angle !== "high") return undefined;
  return [camera.angle && `${camera.angle} angle`, camera.dramaticIntent].filter(Boolean).join(", ");
}

function stateInstruction(action: string | undefined, poseDetails: string[], camera?: string): string | undefined {
  const parts = [action, ...poseDetails, camera].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

export function compileTaskMap(map: CreativeTaskMap, resolution: Resolution): AgentPlan {
  const steps: Step[] = [];
  const defaultPanel = map.target.panel;
  const camera = cameraForGeneration(map.cameraIntent);

  // ── EnsureCharacter: create only what the director said is new ──
  for (const binding of resolution.participants.values()) {
    if (binding.status !== "create") continue;
    steps.push({
      tool: "create_character",
      args: { name: binding.name, appearance: binding.attributes.join(", ") || undefined },
      reason: "Introduced by the request",
    });
    steps.push({
      tool: "generate_character_asset",
      args: { characterName: binding.name, kind: "reference" },
      reason: "Canonical identity reference",
    });
  }

  // ── EnsureScene ──
  if (map.scene && !resolution.sceneAssetId) {
    steps.push({
      tool: "generate_background",
      args: { description: map.scene.description },
      reason: "Scene the request needs",
    });
  }

  // ── EnsureObject ──
  for (const object of map.objects) {
    steps.push({
      tool: "generate_prop",
      args: { description: object.description, name: object.name },
      reason: "Object the request needs",
    });
  }

  // ── Beats: EnsureCharacterState → PlaceParticipant / ComposeInteraction / AddDialogue ──
  for (const beat of map.beats) {
    const panel = beat.panel ?? defaultPanel ?? 1;
    const binding = resolution.participants.get(beat.actor);
    const actorId = binding?.status === "existing" ? binding.characterId : undefined;

    // Camera-sensitive states are generated WITH the viewpoint, upstream of
    // any composition — never a standing asset enlarged afterwards.
    if (beat.action || beat.poseDetails.length > 0) {
      steps.push({
        tool: "generate_character_asset",
        args: {
          characterName: beat.actor,
          ...(actorId ? { characterId: actorId } : {}),
          kind: "pose",
          instruction: stateInstruction(beat.action, beat.poseDetails, camera),
        },
        reason: "The state this beat actually needs",
      });
    }

    if (beat.target && beat.interaction) {
      steps.push({
        tool: "create_interaction",
        args: {
          panel,
          interaction: beat.interaction,
          subjectCharacterName: beat.actor,
          targetCharacterName: beat.target,
          expressions: beat.expression ? { [beat.actor]: beat.expression } : undefined,
        },
        reason: "Coordinated interaction",
      });
    } else {
      steps.push({
        tool: "place_character",
        args: {
          panel,
          characterName: beat.actor,
          ...(actorId ? { characterId: actorId } : {}),
          pose: beat.action,
          expression: beat.expression,
          generateIfMissing: true,
        },
        reason: "Put the actor in the panel",
      });
      if (beat.target) {
        steps.push({
          tool: "add_scene_relationship",
          args: { panel, subjectCharacterName: beat.actor, action: beat.action ?? "interacts with", targetCharacterName: beat.target },
          reason: "Scene action between participants",
        });
      }
    }

    if (beat.dialogue) {
      steps.push({
        tool: "attach_bubble",
        args: {
          panel,
          characterName: beat.actor,
          ...(actorId ? { characterId: actorId } : {}),
          bubbleType: beat.dialogueKind,
          text: beat.dialogue,
        },
        reason: "Exact dialogue from the prompt",
      });
    }
  }

  // ── Scene placement ──
  const scenePanel = map.target.panel ?? map.beats[0]?.panel ?? 1;
  if (map.scene) {
    steps.push(
      resolution.sceneAssetId
        ? { tool: "place_asset", args: { panel: scenePanel, assetName: map.scene.reuseExisting, category: "background" }, reason: "Reuse the scene" }
        : { tool: "place_asset", args: { panel: scenePanel, assetName: map.scene.description.slice(0, 60), category: "background" }, reason: "Place the generated scene" },
    );
  }
  for (const object of map.objects) {
    steps.push({
      tool: "place_asset",
      args: { panel: scenePanel, assetName: object.name ?? object.description.slice(0, 60), category: "prop" },
      reason: "Place the object",
    });
  }

  // ── SetCameraIntent (staging; redraw already happened upstream) ──
  if (map.cameraIntent && (map.cameraIntent.shot || map.cameraIntent.angle || map.cameraIntent.lens)) {
    steps.push({
      tool: "set_camera",
      args: {
        panel: map.target.panel ?? map.beats[0]?.panel ?? 1,
        shot: map.cameraIntent.shot,
        angle: map.cameraIntent.angle,
        lens: map.cameraIntent.lens,
      },
      reason: "Camera intent",
    });
  }

  // ── Effects / tone / local edits ──
  for (const effect of map.effects) {
    steps.push({ tool: "add_effect", args: { panel: effect.panel ?? defaultPanel ?? 1, effectKind: effect.kind }, reason: "Manga effect" });
  }
  if (map.tone) {
    steps.push({ tool: "apply_tone", args: { panel: map.tone.panel ?? defaultPanel ?? 1, mood: map.tone.mood }, reason: "Tone" });
  }
  for (const edit of map.localEdits) {
    steps.push({
      tool: "edit_asset_region",
      args: { panel: edit.panel, characterName: edit.target, instruction: edit.instruction },
      reason: "Local edit",
    });
  }

  return { summary: map.summary, targetScope: undefined, steps };
}

/** Names this run may create — the generation-boundary authorization. */
export function creationAuthorization(resolution: Resolution): string[] {
  return [...resolution.participants.values()]
    .filter((binding) => binding.status === "create")
    .map((binding) => binding.name.toLowerCase());
}
