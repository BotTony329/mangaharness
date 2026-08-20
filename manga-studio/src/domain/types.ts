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

export interface Point {
  x: number;
  y: number;
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
  /** Canonical identity image that anchored this full-state render. */
  canonicalReferenceAssetId?: ID;
  /** Canonical images establish identity; state images are selectable renders. */
  characterAssetRole?: "canonical" | "state";
  /** Snapshot of the project style used for this immutable generation. */
  styleProfileId?: ID;
  styleName?: string;
  stylePositivePrompt?: string;
  styleNegativePrompt?: string;
  styleReferenceAssetId?: ID;
  generatedAt?: ISODate;
}

export interface SourceAsset {
  id: ID;
  projectId: ID;
  category: AssetCategory;
  name: string;
  /** Public URL in object storage (or same-origin dev path). Never a filesystem path. */
  storageUrl: string;
  /** Optional non-destructive derivative used for compositing and export. */
  processedImageUrl?: string;
  thumbnailUrl?: string;
  width: number;
  height: number;
  mimeType?: string;
  hasAlpha?: boolean;
  backgroundRemoved?: boolean;
  processingStatus?: "raw" | "processing" | "ready" | "failed";
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
  /** Identity facts only — rendering instructions belong to Project Art Style. */
  appearance?: string;
  personalityNotes?: string;
  /** Canonical identity reference sent with every generation for this character. */
  referenceAssetId?: ID;
  /** Stable v3 name. referenceAssetId remains as a legacy compatibility alias. */
  canonicalReferenceAssetId?: ID;
  assetIds: ID[];
  createdAt: ISODate;
}

/** The semantic state of one placed character. Every field is independent. */
export interface CharacterState {
  characterId: ID;
  pose: string;
  expression: string;
  outfit: string;
  view: string;
  assetId?: ID;
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
  /**
   * Top-left of the page in workspace pixels. The page is one object inside
   * the infinite workspace, not the root canvas — multiple pages can sit
   * side by side.
   */
  workspace: Point;
}

export interface PanelBorder {
  visible: boolean;
  strokeWidthPx: number;
  color: string;
}

/**
 * A panel is a clipping viewport (Figma-frame semantics): items may extend
 * beyond its bounds; only pixels inside render.
 *
 * Geometry is a polygon (`points`, normalized 0–1 page coordinates, ≥3
 * vertices) — rectangles are just 4-point polygons. Presets create the
 * initial shape; the creator owns it afterwards (double-click → drag
 * corners → diagonal manga panels). Clipping, borders, hit testing, and
 * export all follow the polygon, never a bounding box.
 */
export interface Panel {
  id: ID;
  pageId: ID;
  points: Point[];
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
  /** Present for character instances so state survives asset swaps and migration. */
  characterState?: CharacterState;
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

// ─── Loose workspace objects ────────────────────────────────────────────────

/**
 * An asset placed on the workspace outside any page: reference sheets,
 * staged generations, mood-board material. Position is the item's center in
 * workspace pixels. Loose items are working material — they are never
 * exported with a page, and dragging one into a panel converts it into a
 * PanelItem (and back out again) without touching the source asset.
 */
export interface WorkspaceItem {
  id: ID;
  sourceAssetId: ID;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  opacity: number;
}

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

export type StyleFamilyId =
  | "japanese-manga"
  | "chinese-manhua"
  | "western-comics"
  | "webtoon"
  | "sketch-experimental"
  | "custom";

export interface StyleVisualProperties {
  colorMode?: string;
  lineStyle?: string;
  detailLevel?: string;
  shading?: string;
  rendering?: string;
}

/** Provider-neutral visual language. Adapters may interpret it differently. */
export interface StyleProfile {
  id: ID;
  family: StyleFamilyId;
  name: string;
  description: string;
  positivePrompt: string;
  negativePrompt?: string;
  visualProperties?: StyleVisualProperties;
  previewImage?: string;
  /** Optional uploaded guide for a custom style. */
  referenceAssetId?: ID;
}

export interface ProjectArtStyleSettings {
  activeStyleId: ID;
  customProfiles: Record<ID, StyleProfile>;
}

export interface ProjectSettings {
  pageWidth: number;
  pageHeight: number;
  readingDirection: ReadingDirection;
  artStyle: ProjectArtStyleSettings;
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
  /** Loose objects on the workspace, ordered bottom → top by workspaceOrder. */
  workspaceItems: Record<ID, WorkspaceItem>;
  workspaceOrder: ID[];
  generationHistory: GenerationRecord[];
}

export const SCHEMA_VERSION = 5;
