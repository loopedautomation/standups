"use client"

import type { SelectHTMLAttributes } from "react"

export type SelectOption = {
  value: string
  label: string
  disabled?: boolean
}

// Literal class maps, not template strings — Tailwind only generates classes
// it can see in the source.
const SIZES = {
  xs: "select-xs text-[10px]",
  sm: "select-sm text-xs",
  md: "text-xs",
} as const

const COLORS = {
  default: "border-base-300",
  primary: "select-primary",
  secondary: "select-secondary",
  accent: "select-accent",
  neutral: "select-neutral",
  ghost: "select-ghost",
} as const

type Props = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "size" | "color" | "children"
> & {
  options: readonly SelectOption[]
  /** Rendered as a value="" option, so an unset ("") state displays honestly. */
  placeholder?: string
  size?: keyof typeof SIZES
  color?: keyof typeof COLORS
}

/** Hard cap on label length — the CSS ellipsis backstop, not a replacement. */
const MAX_LABEL_CHARS = 20

function clampLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS
    ? `${label.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`
    : label
}

/**
 * The app's one select. Width is the parent's business (it stretches, and
 * min-w-0 lets flex rows shrink it); overflowing labels truncate with an
 * ellipsis instead of clipping mid-character, with padding clearing the
 * chevron. Labels are additionally hard-capped: the trigger and the native
 * option list share their text, so a runaway label is cut at the data level
 * too.
 */
export function Select({
  options,
  placeholder,
  size = "sm",
  color = "default",
  className = "",
  ...rest
}: Props) {
  return (
    <select
      className={`select w-full min-w-0 truncate border pr-6 ${SIZES[size]} ${COLORS[color]} ${className}`}
      {...rest}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {clampLabel(o.label)}
        </option>
      ))}
    </select>
  )
}
