"use client";

/**
 * The one icon system.
 *
 * Every functional glyph in Kumanga comes from Lucide, at one size and one
 * stroke weight. Re-exporting them here rather than importing from
 * `lucide-react` all over the tree means the sizing contract lives in one file,
 * and a future swap is one edit.
 *
 * Emoji are not icons. They render as somebody else's artwork at somebody
 * else's colour and weight, they change between platforms, and they read as a
 * chat message rather than a tool. None appear in the product UI.
 *
 * The Kumanga bear is BRAND, not a UI icon — it lives in `components/brand` and
 * never stands in for an editor control.
 */

export {
  Undo2 as UndoIcon,
  Redo2 as RedoIcon,
  Eye as VisibleIcon,
  EyeOff as HiddenIcon,
  Lock as LockedIcon,
  Unlock as UnlockedIcon,
  Trash2 as DeleteIcon,
  Copy as DuplicateIcon,
  Pencil as RenameIcon,
  X as CloseIcon,
  Check as CheckIcon,
  Plus as PlusIcon,
  Settings as SettingsIcon,
  Sparkles as GenerateIcon,
  Download as ExportIcon,
  ChevronUp as UpIcon,
  ChevronDown as DownIcon,
  ChevronRight as ChevronRightIcon,
  ChevronsUp as ToFrontIcon,
  ChevronsDown as ToBackIcon,
  FlipHorizontal2 as FlipIcon,
  Palette as StyleIcon,
  Circle as PendingIcon,
  CircleDot as ActiveIcon,
  CircleCheck as DoneIcon,
  CircleAlert as AlertIcon,
  Loader as SpinnerIcon,
  Upload as UploadIcon,
  Search as SearchIcon,
  ArrowRight as ArrowRightIcon,
} from "lucide-react";

/** Toolbar and inline icon size. 16px reads cleanly on a 32px control. */
export const ICON_SIZE = 16;
/** Compact rows — layer lists, chips. */
export const ICON_SIZE_SM = 14;
/** Icon stroke weight, matched across the set. */
export const ICON_STROKE = 1.75;
