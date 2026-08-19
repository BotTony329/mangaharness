"use client";

/**
 * Transient UI state that isn't part of the document (dialog visibility,
 * generator prefill). Kept out of the editor store so undo never replays UI.
 */

import { create } from "zustand";
import type { ID } from "@/domain/types";

export interface GeneratorRequest {
  assetType: "character" | "character-pose" | "character-expression" | "background" | "prop";
  characterId?: ID;
  /** Prefilled slot descriptor, e.g. { pose: "running" }. */
  prefill?: Record<string, string>;
}

interface UiState {
  generator: GeneratorRequest | null;
  openGenerator(request: GeneratorRequest): void;
  closeGenerator(): void;
}

export const useUiStore = create<UiState>((set) => ({
  generator: null,
  openGenerator: (request) => set({ generator: request }),
  closeGenerator: () => set({ generator: null }),
}));
