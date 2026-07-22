"use client"

import { useState } from "react"

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

type Props = {
  options: readonly SelectOption[]
  value?: string
  onChange?: (e: { target: { value: string } }) => void
  /** Shown (and selectable, as value "") when nothing matches `value`. */
  placeholder?: string
  size?: keyof typeof SIZES
  color?: keyof typeof COLORS
  className?: string
  "aria-label"?: string
  disabled?: boolean
}

/**
 * The app's one select — a custom dropdown, not a native <select>, because
 * the two halves need different overflow rules: the closed trigger truncates
 * with an ellipsis, while the option rows show their full label and wrap.
 * A native select shares one text between both and can do neither well.
 */
export function Select({
  options,
  value,
  onChange,
  placeholder,
  size = "sm",
  color = "default",
  className = "",
  "aria-label": ariaLabel,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  const shown = selected?.label ?? placeholder ?? ""

  const pick = (v: string) => {
    onChange?.({ target: { value: v } })
    setOpen(false)
  }

  return (
    <div
      className={`dropdown w-full min-w-0 ${open ? "dropdown-open" : ""} ${className}`}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false)
        }
      }}
    >
      <button
        type="button"
        // Styled as daisy's select (chevron included); the inner span is a
        // plain block, so `truncate` genuinely ellipsizes — unlike a native
        // select, whose flex rendering silently ignores text-overflow.
        className={`select w-full min-w-0 cursor-pointer items-center text-left ${SIZES[size]} ${COLORS[color]}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="w-full min-w-0 truncate">{shown}</span>
      </button>
      {open && (
        <ul
          role="listbox"
          className="menu dropdown-content z-30 mt-1 max-h-64 w-full min-w-full flex-nowrap overflow-y-auto rounded-box bg-base-100 p-2 shadow-lg ring-1 ring-base-300"
        >
          {placeholder !== undefined && (
            <li>
              <button
                type="button"
                role="option"
                aria-selected={!selected}
                className={!selected ? "menu-active" : ""}
                onClick={() => pick("")}
              >
                <span className="min-w-0 break-words">{placeholder}</span>
              </button>
            </li>
          )}
          {options.map((o) => (
            <li key={o.value} className={o.disabled ? "menu-disabled" : ""}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                disabled={o.disabled}
                className={o.value === value ? "menu-active" : ""}
                onClick={() => pick(o.value)}
              >
                {/* Options show everything and wrap — never truncate here. */}
                <span className="min-w-0 break-words">{o.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
