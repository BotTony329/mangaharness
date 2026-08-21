/**
 * Domain model — the product's spine.
 *
 * Everything here is plain serializable data. Canvas objects (Konva nodes)
 * are projections of this state and are never serialized themselves; that
 * separation is what makes save/load, undo, export, and the agent possible
 * with a single source of truth.
 */

import type { EffectParams } from "./effects";
import type { PoseCalibration, PoseRigState } from "@/characters/poseRig";

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
export type AssetType = "character-visual" | "background" | "prop" | "reference" | "effect" | "upload";
export type AssetStatus = "ready" | "processing" | "failed" | "archived";

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
  /** State-graph lineage: the node this render was generated FROM. */
  parentStateId?: ID;
  /** What changed relative to that parent. */
  stateDelta?: CharacterStateDelta;
  /** Props the character holds in this render. */
  props?: string[];
  /** Authored pose edit baked into this render. */
  poseRig?: PoseRigState;
  /** Snapshot of the project style used for this immutable generation. */
  styleProfileId?: ID;
  styleName?: string;
  stylePositivePrompt?: string;
  styleNegativePrompt?: string;
  styleReferenceAssetId?: ID;
  generatedAt?: ISODate;
}

/** Provider-neutral origin information used for reuse, regeneration and audit. */
export interface AssetProvenance {
  provider?: string;
  model?: string;
  prompt?: string;
  negativePrompt?: string;
  generatedFromAssetIds?: ID[];
  characterId?: ID;
  characterState?: Partial<Omit<CharacterState, "characterId" | "assetId">>;
  canonicalReferenceAssetId?: ID;
  projectStyleId?: ID;
  generationType?: string;
  generatedAt?: ISODate;
}

export interface SourceAsset {
  id: ID;
  projectId: ID;
  category: AssetCategory;
  /** Canonical semantic type. `category` remains as a schema-v1 compatibility alias. */
  type: AssetType;
  name: string;
  sourceUrl: string;
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
  /** Background-specific status retained independently for provider retries/audit. */
  backgroundRemovalStatus?: "raw" | "processing" | "ready" | "failed";
  /** Safe user-facing post-processing result; never contains provider secrets. */
  processingReason?: string;
  backgroundRemovalMethod?: string;
  backgroundRemovalProvider?: string;
  status: AssetStatus;
  focusRegions?: FocusRegion[];
  metadata?: AssetGenerationMetadata;
  provenance?: AssetProvenance;
  createdAt: ISODate;
  updatedAt: ISODate;
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
  defaultOutfit?: string;
  /** Canonical identity reference sent with every generation for this character. */
  referenceAssetId?: ID;
  /** Stable v3 name. referenceAssetId remains as a legacy compatibility alias. */
  canonicalReferenceAssetId?: ID;
  assetIds: ID[];
  createdAt: ISODate;
  updatedAt?: ISODate;
}

/** The semantic dimensions a character state is composed from. */
export type CharacterStateDimension = "pose" | "expression" | "outfit" | "view";

/** The semantic state of one placed character. Every field is independent. */
export interface CharacterState {
  characterId: ID;
  pose: string;
  expression: string;
  outfit: string;
  view: string;
  /** Held/worn props, normalized lowercase and sorted. Absent means none. */
  props?: string[];
  /**
   * Authored pose edit. Absent means the pose is exactly the named preset.
   * Its DESCRIPTORS participate in state identity; its joints do not, so a
   * drag that means the same thing reuses the same render.
   */
  poseRig?: PoseRigState;
  assetId?: ID;
  /** The state-graph node this state corresponds to, once one exists. */
  stateId?: ID;
}

/** What a generation changed relative to the reference it was built from. */
export interface CharacterStateDelta {
  changed: CharacterStateDimension[];
  /** True when props differ from the parent as well. */
  propsChanged?: boolean;
  from?: Partial<Record<CharacterStateDimension, string>>;
  to?: Partial<Record<CharacterStateDimension, string>>;
}

/**
 * A node in the character state graph (D33).
 *
 * The asset is the immutable render; this record is the SEMANTIC node that
 * knows what the state means and where it came from. Separating them is what
 * makes lineage answerable: "why does this render look like this?" resolves to
 * a parent state and the reference image actually sent to the provider, rather
 * than to a filename.
 */
export interface CharacterStateRecord {
  id: ID;
  characterId: ID;
  /** Nearest rendered state this was generated FROM, when one was used. */
  parentStateId?: ID;
  /** The image actually sent to the provider as the identity anchor. */
  referenceAssetId?: ID;
  /** The character's canonical identity image at generation time. */
  canonicalReferenceAssetId?: ID;
  /** The render produced for this state; absent while only requested. */
  assetId?: ID;
  delta?: CharacterStateDelta;
  pose: string;
  expression: string;
  outfit: string;
  view: string;
  props: string[];
  /** Authored pose edit for this state, when one was applied. */
  poseRig?: PoseRigState;
  /**
   * Rig alignment fitted to THIS render. Stored per state because a walking
   * render and a crouching render need different alignment (§4).
   */
  poseCalibration?: PoseCalibration;
  styleProfileId: ID;
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
  /** Director controls for this panel. Absent on pre-v7 documents. */
  camera?: PanelCamera;
  /** Editor-only construction guides. Never rendered into the exported page. */
  perspective?: PanelPerspective;
  /**
   * The subject camera framing works around (§6). Without it a close-up would
   * zoom the geometric centre of the panel rather than a character's face.
   */
  focalItemId?: ID;
  /**
   * Auto depth ordering: nearer subjects draw over farther ones. Off means the
   * creator's manual layer order wins (§10).
   */
  autoDepthOrder?: boolean;
}

// ─── Panel camera & perspective ─────────────────────────────────────────────

export type ShotType = "extreme-wide" | "wide" | "full" | "medium" | "close-up" | "extreme-close-up";
export type CameraAngle = "eye-level" | "high" | "low" | "overhead" | "dutch";
export type CameraLens = "wide" | "normal" | "telephoto";

/**
 * Shot/angle/lens are the primary vocabulary; the numeric fields are derived
 * from them. `derivedFrom` records which preset produced each derived value so
 * a preset change never overwrites a number the creator set by hand.
 */
export interface PanelCamera {
  shot: ShotType;
  angle: CameraAngle;
  lens: CameraLens;
  /** 0 normal … 3 extreme. Manga foreshortening intent, not optical scale. */
  mangaPerspectiveStrength: number;
  pitch: number;
  yaw: number;
  roll: number;
  /** Eye level as a fraction of panel height (0 top … 1 bottom). */
  horizonY: number;
  /** Horizontal field of view in degrees. */
  fov: number;
  derivedFrom: { angle?: CameraAngle; lens?: CameraLens };
}

export type PerspectiveType = "none" | "one-point" | "two-point" | "three-point";

/** Vanishing points are normalized to the panel box and may sit outside it. */
export interface PanelPerspective {
  type: PerspectiveType;
  horizonY: number;
  vanishingPoints: Point[];
  visible: boolean;
  snapEnabled: boolean;
}

// ─── Semantic panel scenes ─────────────────────────────────────────────────

export type SceneDepth = "foreground" | "midground" | "background";
export type SceneFacing = "left" | "right" | "camera";
export type ScenePosition = "left" | "center" | "right";

export interface SceneCharacter {
  characterInstanceId: ID;
  characterId: ID;
  role?: string;
  depth?: SceneDepth;
  facing?: SceneFacing;
  semanticPosition?: ScenePosition;
}

export interface SceneRelationship {
  id: ID;
  subjectCharacterId: ID;
  action: string;
  targetCharacterId?: ID;
}

export interface SceneContinuity {
  sceneKey?: string;
  backgroundSourcePanelId?: ID;
  previousPanelId?: ID;
}

export interface PanelScene {
  panelId: ID;
  location?: string;
  backgroundAssetId?: ID;
  characters: SceneCharacter[];
  relationships: SceneRelationship[];
  dialogue: string[];
  continuity?: SceneContinuity;
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
  /**
   * Optional semantic depth layer. Absent means pure free transform, exactly
   * as before — depth never becomes mandatory for an existing instance.
   */
  stage?: InstanceStage;
}

export type GroundAnchor = "feet" | "center" | "custom";

export interface InstanceStage {
  /** 0 = at the camera, 1 = far plane. */
  depth: number;
  /** Explicit ground line; absent means follow the panel camera's eye level. */
  groundY?: number;
  anchor: GroundAnchor;
  /** The creator resized by hand; depth stops driving size. */
  scaleLocked: boolean;
}

/** Semantic drop targets on a placed character (§6). Derived, never stored. */
export type CharacterSocket = "face" | "body" | "outfit" | "hand";

export type BubbleType = "speech" | "thought" | "shout" | "whisper" | "narration";

export interface SpeechBubbleItem extends PanelItemBase {
  kind: "bubble";
  bubbleType: BubbleType;
  text: string;
  fontSize: number;
  /** Tail target in panel-local pixels; narration boxes have no tail. */
  tail?: { x: number; y: number };
  /**
   * Who is speaking. The relationship is semantic, so moving the character
   * lets the tail follow instead of pointing at empty space (§17).
   */
  targetCharacterId?: ID;
  /** Instance the tail tracks; resolved from targetCharacterId when absent. */
  targetInstanceId?: ID;
}

export type EffectKind = "speed-lines" | "focus-lines" | "screentone" | "impact-burst" | "emotion";

export interface EffectItem extends PanelItemBase {
  kind: "effect";
  effectKind: EffectKind;
  /** Typed per kind; see domain/effects.ts. Stays editable for the document's life. */
  params: EffectParams;
  /** Optional semantic attachment: the subject this effect describes (§16). */
  targetItemId?: ID;
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
  scenes: Record<ID, PanelScene>;
  /** The character state graph: semantic nodes with reference lineage. */
  characterStates: Record<ID, CharacterStateRecord>;
  items: Record<ID, PanelItem>;
  /** Loose objects on the workspace, ordered bottom → top by workspaceOrder. */
  workspaceItems: Record<ID, WorkspaceItem>;
  workspaceOrder: ID[];
  generationHistory: GenerationRecord[];
}

export const SCHEMA_VERSION = 9;
