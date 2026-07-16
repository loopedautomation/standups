"use client"

import { useParticipants } from "@livekit/components-react"
import { parseParticipantMeta } from "@meet/shared"
import { Bot, User } from "lucide-react"

export type Mentionable = {
  name: string
  isAgent: boolean
}

/** Everyone in the call who can be @-mentioned (excludes yourself). */
export function useMentionables(): Mentionable[] {
  const participants = useParticipants()
  return participants
    .filter((p) => !p.isLocal && (p.name || p.identity))
    .map((p) => ({
      name: p.name || p.identity,
      isAgent: parseParticipantMeta(p.metadata)?.kind === "agent",
    }))
}

/** The active "@query" at the end of the draft, or null. */
export function mentionQuery(draft: string): string | null {
  const match = draft.match(/(?:^|\s)@([\w-]*)$/)
  return match ? match[1] : null
}

export function completeMention(draft: string, name: string): string {
  return draft.replace(/@[\w-]*$/, `@${name} `)
}

export function MentionPicker({
  query,
  candidates,
  onPick,
}: {
  query: string
  candidates: Mentionable[]
  onPick: (name: string) => void
}) {
  const matches = candidates.filter((c) =>
    c.name.toLowerCase().startsWith(query.toLowerCase()),
  )
  if (matches.length === 0) return null

  return (
    <ul className="absolute bottom-full left-0 z-20 mb-1 w-56 rounded-box bg-base-100 p-1 shadow-lg ring-1 ring-base-300">
      {matches.slice(0, 6).map((c) => (
        <li key={c.name}>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-sm hover:bg-base-200"
            onClick={() => onPick(c.name)}
          >
            {c.isAgent ? (
              <Bot className="size-4 text-primary" />
            ) : (
              <User className="size-4 text-base-content/60" />
            )}
            {c.name}
          </button>
        </li>
      ))}
    </ul>
  )
}
