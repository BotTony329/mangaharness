"use client";

import { Circle, Ellipse, Group, Line, Rect, Text } from "react-konva";
import type Konva from "konva";
import type { SpeechBubbleItem } from "@/domain/types";

interface BubbleNodeProps {
  item: SpeechBubbleItem;
  interactive: boolean;
  onSelect?: () => void;
  onDragEnd?: (cx: number, cy: number) => void;
  onDoubleClick?: () => void;
  onTailDragEnd?: (x: number, y: number) => void;
  selected?: boolean;
}

const STROKE = "#111111";
const FILL = "#ffffff";

/**
 * Manga dialogue. The tail target is a draggable handle (panel coordinates)
 * so speech points at a character; narration boxes have no tail.
 */
export function BubbleNode({ item, interactive, onSelect, onDragEnd, onDoubleClick, onTailDragEnd, selected }: BubbleNodeProps) {
  const halfW = item.width / 2;
  const halfH = item.height / 2;

  return (
    <>
      {item.tail && item.bubbleType !== "narration" && (
        <TailShape item={item} />
      )}
      <Group
        id={`item-${item.id}`}
        x={item.cx}
        y={item.cy}
        offsetX={halfW}
        offsetY={halfH}
        width={item.width}
        height={item.height}
        rotation={item.rotation}
        opacity={item.opacity}
        visible={item.visible !== false}
        draggable={interactive && !item.locked}
        listening={interactive}
        onMouseDown={onSelect}
        onTap={onSelect}
        onDblClick={onDoubleClick}
        onDblTap={onDoubleClick}
        onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => onDragEnd?.(e.target.x(), e.target.y())}
      >
        <BubbleShape item={item} />
        <Text
          x={item.width * 0.1}
          y={item.height * 0.14}
          width={item.width * 0.8}
          height={item.height * 0.72}
          text={item.text}
          fontSize={item.fontSize}
          fontFamily="'Comic Sans MS', 'Segoe UI', sans-serif"
          fill="#111111"
          align="center"
          verticalAlign="middle"
          wrap="word"
          listening={false}
        />
      </Group>
      {selected && interactive && item.tail && (
        <Circle
          x={item.tail.x}
          y={item.tail.y}
          radius={7}
          fill="#6366f1"
          stroke="#ffffff"
          strokeWidth={2}
          draggable
          onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => onTailDragEnd?.(e.target.x(), e.target.y())}
        />
      )}
    </>
  );
}

function BubbleShape({ item }: { item: SpeechBubbleItem }) {
  const halfW = item.width / 2;
  const halfH = item.height / 2;
  switch (item.bubbleType) {
    case "narration":
      return <Rect width={item.width} height={item.height} fill={FILL} stroke={STROKE} strokeWidth={3} />;
    case "shout":
      return (
        <Line
          points={starburstPoints(halfW, halfH)}
          closed
          fill={FILL}
          stroke={STROKE}
          strokeWidth={3}
          x={halfW}
          y={halfH}
        />
      );
    case "thought":
    case "speech":
      return (
        <Ellipse
          x={halfW}
          y={halfH}
          radiusX={halfW}
          radiusY={halfH}
          fill={FILL}
          stroke={STROKE}
          strokeWidth={3}
          dash={item.bubbleType === "thought" ? [10, 6] : undefined}
        />
      );
  }
}

/** Speech: triangle toward target. Thought: shrinking dots toward target. */
function TailShape({ item }: { item: SpeechBubbleItem }) {
  const tail = item.tail!;
  const dx = tail.x - item.cx;
  const dy = tail.y - item.cy;
  const distance = Math.hypot(dx, dy) || 1;

  if (item.bubbleType === "thought") {
    const dots = [0.55, 0.75, 0.9].map((f, i) => (
      <Circle
        key={i}
        x={item.cx + dx * f}
        y={item.cy + dy * f}
        radius={8 - i * 2}
        fill={FILL}
        stroke={STROKE}
        strokeWidth={2}
        listening={false}
      />
    ));
    return <>{dots}</>;
  }

  // Base of the triangle sits on the bubble edge, perpendicular to the target direction.
  const nx = -dy / distance;
  const ny = dx / distance;
  const baseWidth = Math.min(24, item.width * 0.15);
  const edgeX = item.cx + (dx / distance) * (item.width / 2) * 0.75;
  const edgeY = item.cy + (dy / distance) * (item.height / 2) * 0.75;
  return (
    <Line
      points={[
        edgeX + nx * baseWidth,
        edgeY + ny * baseWidth,
        edgeX - nx * baseWidth,
        edgeY - ny * baseWidth,
        tail.x,
        tail.y,
      ]}
      closed
      fill={FILL}
      stroke={STROKE}
      strokeWidth={3}
      listening={false}
    />
  );
}

function starburstPoints(radiusX: number, radiusY: number): number[] {
  const points: number[] = [];
  const spikes = 14;
  for (let i = 0; i < spikes * 2; i++) {
    const angle = (Math.PI * i) / spikes;
    const factor = i % 2 === 0 ? 1 : 0.75;
    points.push(Math.cos(angle) * radiusX * factor, Math.sin(angle) * radiusY * factor);
  }
  return points;
}
