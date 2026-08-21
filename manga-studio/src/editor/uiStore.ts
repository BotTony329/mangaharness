"use client";

/**
 * Transient UI state that isn't part of the document (dialog visibility,
 * generator prefill). Kept out of the editor store so undo never replays UI.
 */

import { create } from "zustand";
import type { ID } from "@/domain/types";
import type { PoseCalibration, PoseRigState } from "@/characters/poseRig";

export interface GeneratorRequest {
  assetType: "character" | "character-pose" | "character-expression" | "background" | "prop";
  characterId?: ID;
  /** Prefilled slot descriptor, e.g. { pose: "running" }. */
  prefill?: Record<string, string>;
  /**
   * When set, the accepted result also replaces this instance's source asset
   * ("Expression: Crying → not available → Generate" flows end by swapping
   * the selected instance).
   */
  targetInstanceId?: ID;
  /** Regeneration replaces every reference to the old source after acceptance. */
  replaceAssetId?: ID;
}

interface UiState {
  generator: GeneratorRequest | null;
  /** Panel currently in shape-edit mode (double-click a panel to enter). */
  shapeEditPanelId: ID | null;
  /**
   * Character instance currently in pose-edit mode, plus the draft rig.
   * The draft is editor state on purpose: dragging joints must not create undo
   * entries or touch the document until Apply (§5/§13).
   */
  poseEditInstanceId: ID | null;
  poseDraft: PoseRigState | null;
  /** Calibration mode reuses the same overlay but drags baseline anchors (§3). */
  calibrating: boolean;
  calibrationDraft: PoseCalibration | null;
  /** AI Settings can be opened from anywhere ("Connect model" prompts). */
  settingsOpen: boolean;
  artStyleOpen: boolean;
  openGenerator(request: GeneratorRequest): void;
  closeGenerator(): void;
  setShapeEditPanel(panelId: ID | null): void;
  beginPoseEdit(instanceId: ID, rig: PoseRigState): void;
  setPoseDraft(rig: PoseRigState): void;
  endPoseEdit(): void;
  beginCalibration(instanceId: ID, calibration: PoseCalibration): void;
  setCalibrationDraft(calibration: PoseCalibration): void;
  endCalibration(): void;
  openSettings(): void;
  closeSettings(): void;
  openArtStyle(): void;
  closeArtStyle(): void;
}

export const useUiStore = create<UiState>((set) => ({
  generator: null,
  shapeEditPanelId: null,
  poseEditInstanceId: null,
  poseDraft: null,
  calibrating: false,
  calibrationDraft: null,
  settingsOpen: false,
  artStyleOpen: false,
  openGenerator: (request) => set({ generator: request }),
  closeGenerator: () => set({ generator: null }),
  setShapeEditPanel: (panelId) => set({ shapeEditPanelId: panelId }),
  beginPoseEdit: (instanceId, rig) => set({ poseEditInstanceId: instanceId, poseDraft: rig }),
  setPoseDraft: (rig) => set({ poseDraft: rig }),
  endPoseEdit: () => set({ poseEditInstanceId: null, poseDraft: null, calibrating: false, calibrationDraft: null }),
  beginCalibration: (instanceId, calibration) =>
    set({ poseEditInstanceId: instanceId, calibrating: true, calibrationDraft: calibration, poseDraft: null }),
  setCalibrationDraft: (calibration) => set({ calibrationDraft: calibration }),
  endCalibration: () => set({ calibrating: false, calibrationDraft: null, poseEditInstanceId: null }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openArtStyle: () => set({ artStyleOpen: true }),
  closeArtStyle: () => set({ artStyleOpen: false }),
}));
