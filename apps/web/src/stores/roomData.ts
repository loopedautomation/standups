import type {
  AgentActivityEvent,
  AgentStatsEvent,
  ChatMessage,
} from "@meet/shared"
import { atom } from "nanostores"

/** Chat + agent activity live here so nothing is missed while panels are closed. */
export const $chatMessages = atom<ChatMessage[]>([])
export const $agentActivity = atom<AgentActivityEvent[]>([])
/** Latest pipeline stats per agent ("stats for nerds"). */
export const $agentStats = atom<Record<string, AgentStatsEvent>>({})
/**
 * Agents currently composing a chat reply, keyed by participant identity.
 * `at` is the last heartbeat, used to prune a stuck indicator whose "stopped"
 * signal never arrived (crashed worker, dropped packet).
 */
export const $typingAgents = atom<Record<string, { name: string; at: number }>>(
  {},
)

export function addChatMessage(message: ChatMessage) {
  const current = $chatMessages.get()
  if (current.some((m) => m.id === message.id)) return
  $chatMessages.set([...current.slice(-199), message])
}

export function addAgentActivity(event: AgentActivityEvent) {
  if (event.type === "stats") {
    $agentStats.set({ ...$agentStats.get(), [event.agentId]: event })
    return
  }
  $agentActivity.set([...$agentActivity.get().slice(-199), event])
}

/** Turn a typing indicator on or off for one agent. */
export function setAgentTyping(
  identity: string,
  name: string,
  typing: boolean,
  at: number,
) {
  const current = $typingAgents.get()
  if (typing) {
    $typingAgents.set({ ...current, [identity]: { name, at } })
  } else {
    clearAgentTyping(identity)
  }
}

export function clearAgentTyping(identity: string) {
  const current = $typingAgents.get()
  if (!current[identity]) return
  const { [identity]: _removed, ...rest } = current
  $typingAgents.set(rest)
}

/** Drop indicators whose last heartbeat is older than `maxAgeMs`. */
export function pruneTypingAgents(maxAgeMs: number) {
  const current = $typingAgents.get()
  const cutoff = Date.now() - maxAgeMs
  const kept = Object.fromEntries(
    Object.entries(current).filter(([, v]) => v.at >= cutoff),
  )
  if (Object.keys(kept).length !== Object.keys(current).length) {
    $typingAgents.set(kept)
  }
}

export function resetRoomData() {
  $chatMessages.set([])
  $agentActivity.set([])
  $agentStats.set({})
  $typingAgents.set({})
}
