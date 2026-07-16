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
  mentionQuery,
  useMentionables,
} from "@/components/room/panels/MentionPicker"
import { $chatMessages, addChatMessage } from "@/stores/roomData"

export function ChatPanel() {
  const { localParticipant } = useLocalParticipant()
  const messages = useStore($chatMessages)
  const [draft, setDraft] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)
  const mentionables = useMentionables()
  const query = mentionQuery(draft)

  const { send } = useDataChannel(DataTopic.Chat)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [])

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
        {messages.map((m) => (
          <li key={m.id} className="text-sm">
            <span className="font-medium">{m.fromName}</span>{" "}
            <span className="text-base-content/50 text-xs">
              {new Date(m.at).toLocaleTimeString()}
            </span>
            <p className="text-base-content/90">{m.text}</p>
          </li>
        ))}
        <div ref={bottomRef} />
      </ul>
      <form onSubmit={handleSend} className="relative flex gap-2 p-3">
        {query !== null && (
          <MentionPicker
            query={query}
            candidates={mentionables}
            onPick={(name) => setDraft((d) => completeMention(d, name))}
          />
        )}
        <input
          className="input input-sm flex-1"
          placeholder="Send a message — @ to mention"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
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
