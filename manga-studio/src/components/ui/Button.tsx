"use client";

/**
 * The button hierarchy.
 *
 * Before this, almost every action was a bordered rectangle, so nothing looked
 * more important than anything else and the interface read as a wall of boxes.
 * Five roles, and only two of them draw a filled shape:
 *
 *   primary   — the commit/generation action for the current task
 *   secondary — a normal action with a surface but no border
 *   ghost     — toolbar and lightweight actions; surface appears on hover
 *   icon      — frequent compact commands (requires a label)
 *   danger    — destructive; reads as danger on hover, not at rest
 *
 * Flat throughout: no gradients, no bevels, no shadow pretending to be depth.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors " +
  "disabled:cursor-not-allowed disabled:opacity-40";

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-xs",
};

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]",
  secondary: "bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-active)]",
  ghost: "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
  danger: "text-[var(--text-secondary)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Rendered before the label at the icon system's toolbar size. */
  icon?: ReactNode;
  block?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  block,
  className = "",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={`${BASE} ${SIZES[size]} ${VARIANTS[variant]} ${block ? "w-full" : ""} ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Required: an icon shape alone is not an accessible name, and for anything
   * destructive it is not an unambiguous one either.
   */
  label: string;
  icon: ReactNode;
  variant?: "ghost" | "danger";
  size?: ButtonSize;
  /** Toggle state — draws the accent rather than a border. */
  active?: boolean;
}

export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  active,
  className = "",
  ...props
}: IconButtonProps) {
  const box = size === "sm" ? "h-6 w-6" : "h-8 w-8";
  const tone = active
    ? "bg-[var(--accent-soft)] text-[var(--accent-text)]"
    : variant === "danger"
      ? VARIANTS.danger
      : VARIANTS.ghost;
  return (
    <button
      {...props}
      aria-label={label}
      title={props.title ?? label}
      aria-pressed={active}
      className={`inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${box} ${tone} ${className}`}
    >
      {icon}
    </button>
  );
}

/** A vertical rule between toolbar groups — the only separator the strip needs. */
export function ToolbarDivider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-[var(--border-subtle)]" />;
}
