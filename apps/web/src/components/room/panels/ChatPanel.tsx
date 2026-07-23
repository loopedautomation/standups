"use client"

import { useDataChannel, useLocalParticipant } from "@livekit/components-react"
import { type ChatMessage, DataTopic } from "@meet/shared"
import { useStore } from "@nanostores/react"
import { SendHorizontal } from "lucide-react"
import { nanoid } from "nanoid"
import { useEffect, useRef, useState } from "react"
import {
  completeMention,
  MentionPicker,
  matchMentions,
  mentionQuery,
  useMentionables,
} from "@/components/room/panels/MentionPicker"
import { $chatMessages, $typingAgents, addChatMessage } from "@/stores/roomData"

/**
 * Render message text with URLs as real links. `break-all` on the anchor so
 * long URLs wrap inside the bubble instead of overflowing it.
 */
function linkify(text: string): React.ReactNode[] {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="link break-all"
      >
        {part}
      </a>
    ) : (
      part
    ),
  )
}

/** "Ada is typing…", "Ada and Ben are typing…", "3 agents are typing…". */
function typingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`
  return `${names.length} agents are typing`
}

export function ChatPanel() {
  const { localParticipant } = useLocalParticipant()
  const messages = useStore($chatMessages)
  const typing = useStore($typingAgents)
  const typingNames = Object.values(typing).map((t) => t.name)
  const [draft, setDraft] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)
  const mentionables = useMentionables()
  const query = mentionQuery(draft)
  const matches = query !== null ? matchMentions(mentionables, query) : []
  // Keyboard navigation through the mention picker; reset as the query moves.
  const [active, setActive] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: query drives the reset
  useEffect(() => setActive(0), [query])

  const pickerKeys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (query === null || matches.length === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => (i + 1) % matches.length)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => (i - 1 + matches.length) % matches.length)
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      setDraft((d) => completeMention(d, matches[active].name))
    }
  }

  const { send } = useDataChannel(DataTopic.Chat)

  // Follow the conversation: jump on open, glide on each new message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages drives the scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    const message: ChatMessage = {
      id: nanoid(8),
      from: localParticipant.identity,
      fromName: localParticipant.name || localParticipant.identity,
      text,
      at: Date.now(),
    }
    setDraft("")
    addChatMessage(message)
    await send(new TextEncoder().encode(JSON.stringify(message)), {
      topic: DataTopic.Chat,
      reliable: true,
    })
  }

  return (
    <div className="flex h-full flex-col">
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <li className="text-base-content/50 text-sm">
            No messages yet. Mention an agent with @Name to ask it in text.
          </li>
        )}
        {messages.map((m, i) => {
          const own = m.from === localParticipant.identity
          // Consecutive messages from the same sender within the same
          // displayed minute share one header — order stays untouched, only
          // the repeated name/stamp is dropped.
          const prev = messages[i - 1]
          const minute = (at: number) => Math.floor(at / 60_000)
          const grouped =
            prev && prev.from === m.from && minute(prev.at) === minute(m.at)
          return (
            <li
              key={m.id}
              className={`chat ${own ? "chat-end" : "chat-start"} ${grouped ? "!pt-0" : ""}`}
            >
              {!grouped && (
                <div className="chat-header text-base-content/50 text-xs">
                  {!own && (
                    <span className="mr-1 font-medium text-base-content">
                      {m.fromName}
                    </span>
                  )}
                  <time>
                    {new Date(m.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
              )}
              <div
                className={`chat-bubble min-w-0 max-w-[85%] whitespace-pre-wrap break-words text-sm ${
                  own ? "chat-bubble-primary" : ""
                }`}
              >
                {linkify(m.text)}
              </div>
            </li>
          )
        })}
        <div ref={bottomRef} />
      </ul>
      {typingNames.length > 0 && (
        <div
          aria-live="polite"
          className="flex items-center gap-2 px-4 pb-1 text-base-content/50 text-xs"
        >
          <span className="flex items-center gap-0.5" aria-hidden="true">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </span>
          <span>{typingLabel(typingNames)}…</span>
        </div>
      )}
      <form onSubmit={handleSend} className="relative flex gap-2 p-3">
        {query !== null && (
          <MentionPicker
            matches={matches}
            active={active}
            onPick={(name) => setDraft((d) => completeMention(d, name))}
            onHover={setActive}
          />
        )}
        <input
          className="input input-sm flex-1"
          placeholder="Send a message — @ to mention"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={pickerKeys}
        />
        <button
          type="submit"
          className="btn btn-primary btn-sm btn-circle"
          disabled={!draft.trim()}
          aria-label="Send message"
        >
          <SendHorizontal className="size-4" />
        </button>
      </form>
    </div>
  )
}
