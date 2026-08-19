/**
 * Domain model — the product's spine.
 *
 * Everything here is plain serializable data. Canvas objects (Konva nodes)
 * are projections of this state and are never serialized themselves; that
 * separation is what makes save/load, undo, export, and the agent possible
 * with a single source of truth.
 */

// ─── Shared primitives ──────────────────────────────────────────────────────

export type ID = string;
export type ISODate = string;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Open union so future categories don't require a schema rewrite. */
export type AssetCategory = "character" | "background" | "prop" | "upload";

// ─── Source assets (the library) ────────────────────────────────────────────

/**
 * Region annotations enable Face Focus / Upper Body framing without
 * destructive cropping. Rect is normalized 0–1 within the asset.
 * Absent metadata means the framing mode falls back to a heuristic
 * (upper-body) or is unavailable (face) — we never fake face detection.
 */
export interface FocusRegion {
  kind: "face" | "upper-body";
  rect: Rect;
}

export interface AssetGenerationMetadata {
  provider?: string;
  model?: string;
  prompt?: string;
  negativePrompt?: string;
  referenceAssetIds?: ID[];
  characterId?: ID;
  pose?: string;
  expression?: string;
  outfit?: string;
  view?: string;
  generatedAt?: ISODate;
}

export interface SourceAsset {
  id: ID;
  projectId: ID;
  category: AssetCategory;
  name: string;
  /** Public URL in object storage (or same-origin dev path). Never a filesystem path. */
  storageUrl: string;
  thumbnailUrl?: string;
  width: number;
  height: number;
  mimeType?: string;
  hasAlpha?: boolean;
  focusRegions?: FocusRegion[];
  metadata?: AssetGenerationMetadata;
  createdAt: ISODate;
}

// ─── Characters ─────────────────────────────────────────────────────────────

/**
 * A character is a structured library, not a loose image. Slot metadata
 * (pose/expression/view/outfit) lives on each asset's generation metadata;
 * the character lists its member assets in order of creation.
 */
export interface Character {
  id: ID;
  projectId: ID;
  name: string;
  description?: string;
  /** Canonical identity reference sent with every generation for this character. */
  referenceAssetId?: ID;
  assetIds: ID[];
  createdAt: ISODate;
}

// ─── Pages and panels ───────────────────────────────────────────────────────

export type LayoutPresetId =
  | "single"
  | "two-vertical"
  | "two-horizontal"
  | "three-vertical"
  | "four-grid"
  | "yonkoma";

export interface Page {
  id: ID;
  projectId: ID;
  name: string;
  index: number;
  panelIds: ID[];
}

export interface PanelBorder {
  visible: boolean;
  strokeWidthPx: number;
  color: string;
}

/**
 * A panel is a clipping viewport (Figma-frame semantics): items may extend
 * beyond its bounds; only pixels inside render. `rect` is normalized 0–1
 * in page coordinates so layouts survive page-size changes.
 */
export interface Panel {
  id: ID;
  pageId: ID;
  rect: Rect;
  border: PanelBorder;
  /** Ordered bottom → top. The layer list UI is a projection of this array. */
  itemIds: ID[];
}

// ─── Panel items (instances — never the source) ─────────────────────────────

export type CropMode = "fit" | "fill" | "upper-body" | "face" | "custom";

interface PanelItemBase {
  id: ID;
  panelId: ID;
  /** Center position in panel-local pixels. Rotation is about the center. */
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  locked?: boolean;
  visible?: boolean;
}

/**
 * THE core distinction: an AssetInstance references a SourceAsset and stores
 * only presentation state. Mutating an instance never mutates the source;
 * deleting an instance never deletes the source; the same source may be
 * instanced in many panels with independent transforms.
 */
export interface AssetInstance extends PanelItemBase {
  kind: "asset";
  sourceAssetId: ID;
  flipX: boolean;
  cropMode: CropMode;
}

export type BubbleType = "speech" | "thought" | "shout" | "narration";

export interface SpeechBubbleItem extends PanelItemBase {
  kind: "bubble";
  bubbleType: BubbleType;
  text: string;
  fontSize: number;
  /** Tail target in panel-local pixels; narration boxes have no tail. */
  tail?: { x: number; y: number };
}

export type EffectKind = "speed-lines" | "focus-lines" | "screentone" | "impact-burst";

export interface EffectItem extends PanelItemBase {
  kind: "effect";
  effectKind: EffectKind;
  params: Record<string, number | string | boolean>;
}

export type PanelItem = AssetInstance | SpeechBubbleItem | EffectItem;

// ─── Generation history ─────────────────────────────────────────────────────

export interface GenerationRecord {
  id: ID;
  status: "succeeded" | "failed";
  assetType: string;
  prompt: string;
  provider?: string;
  model?: string;
  resultAssetId?: ID;
  error?: string;
  createdAt: ISODate;
}

// ─── Project document ───────────────────────────────────────────────────────

export type ReadingDirection = "ltr" | "rtl";

export interface ProjectSettings {
  pageWidth: number;
  pageHeight: number;
  readingDirection: ReadingDirection;
}

export interface Project {
  id: ID;
  name: string;
  settings: ProjectSettings;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/**
 * The whole serializable state of a project, normalized by id. One document
 * per project; browser persistence stores this JSON, remote object storage
 * holds the image binaries it references by URL.
 */
export interface ProjectDocument {
  schemaVersion: number;
  project: Project;
  assets: Record<ID, SourceAsset>;
  characters: Record<ID, Character>;
  pages: Record<ID, Page>;
  panels: Record<ID, Panel>;
  items: Record<ID, PanelItem>;
  generationHistory: GenerationRecord[];
}

export const SCHEMA_VERSION = 1;
