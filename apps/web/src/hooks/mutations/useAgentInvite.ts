"use client"

import { useMutation } from "@tanstack/react-query"
import { readHostKey } from "@/lib/hostKey"

export type AgentMode = "realtime" | "gemini" | "pipeline"

export function useAgentInvite(slug: string) {
  return useMutation({
    mutationFn: async ({
      agentId,
      action,
      mode,
      voice,
    }: {
      agentId: string
      action: "invite" | "remove"
      /** Optional interaction-mode override; omit for the agent's default. */
      mode?: AgentMode
      /** Optional voice override; must belong to the resolved mode's provider. */
      voice?: string
    }) => {
      // Presented so the host still gets through when they've reserved
      // agent invites for themselves; ignored when they haven't.
      const hostKey = readHostKey(slug)
      const overrides =
        action === "invite" && (mode || voice)
          ? { ...(mode ? { mode } : {}), ...(voice ? { voice } : {}) }
          : null
      const res = await fetch(`/api/rooms/${slug}/agents/${agentId}`, {
        method: action === "invite" ? "POST" : "DELETE",
        headers: {
          ...(hostKey ? { "x-host-key": hostKey } : {}),
          ...(overrides ? { "content-type": "application/json" } : {}),
        },
        ...(overrides ? { body: JSON.stringify(overrides) } : {}),
      })
      if (!res.ok) throw new Error(`agent ${action} failed`)
    },
  })
}
