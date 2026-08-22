"use client";

/**
 * Dialogue-delivery Semantic Normalization — same layer as cameraSemantics
 * and interactionSemantics. The director describes delivery ("yells",
 * "thinking", "voiceover"); the editor executes the BubbleType enum.
 * Unknown delivery words fall back to speech with a warning — never fatal.
 */

type EditorBubbleType = "speech" | "thought" | "shout" | "whisper" | "narration";

const DELIVERY_MAP: Record<string, EditorBubbleType> = {
  speech: "speech",
  say: "speech",
  says: "speech",
  talk: "speech",
  tells: "speech",
  thought: "thought",
  think: "thought",
  thinking: "thought",
  "inner voice": "thought",
  shout: "shout",
  shouts: "shout",
  yell: "shout",
  yells: "shout",
  scream: "shout",
  screams: "shout",
  "cry out": "shout",
  "cries out": "shout",
  exclaim: "shout",
  exclaims: "shout",
  whisper: "whisper",
  whispers: "whisper",
  murmur: "whisper",
  murmurs: "whisper",
  mutter: "whisper",
  narration: "narration",
  narrator: "narration",
  narrates: "narration",
  voiceover: "narration",
  caption: "narration",
};

export interface ResolvedDelivery {
  bubbleType: EditorBubbleType;
  warning?: string;
}

export function resolveDialogueDelivery(raw: string | undefined): ResolvedDelivery {
  if (!raw) return { bubbleType: "speech" };
  const type = DELIVERY_MAP[raw.trim().toLowerCase()];
  if (type) return { bubbleType: type };
  return { bubbleType: "speech", warning: `Unsupported dialogue delivery "${raw}"; using speech.` };
}
