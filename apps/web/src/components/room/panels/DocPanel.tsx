"use client"

import { useDataChannel, useLocalParticipant } from "@livekit/components-react"
import { DataTopic, type SharedDoc } from "@meet/shared"
import { useStore } from "@nanostores/react"
import { Check, Copy, Download } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { $doc, applyDocUpdate } from "@/stores/doc"

/** How long to sit on keystrokes before telling the room and the store. */
const PUBLISH_DEBOUNCE_MS = 400

/**
 * The meeting's shared markdown document — a plan the room writes together
 * with the agent while they talk about it.
 *
 * Deliberately a plain markdown source editor: the document is the thing
 * people take away and paste into an issue or a README, and a WYSIWYG layer
 * would put a renderer between them and what they're actually producing.
 */
export function DocPanel({ slug }: { slug: string }) {
  const doc = useStore($doc)
  const { localParticipant } = useLocalParticipant()
  const { send } = useDataChannel(DataTopic.Doc)

  // What the textarea shows. Kept separate from the store so a remote edit
  // arriving mid-sentence can be handled deliberately rather than yanking
  // the cursor on every keystroke someone else makes.
  const [draft, setDraft] = useState(doc.text)
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const editingRef = useRef(editing)
  editingRef.current = editing

  // Remote edits land in the textarea unless this person is mid-edit, in
  // which case their own text stays put — losing what someone is actively
  // typing is worse than briefly showing a stale paragraph.
  useEffect(() => {
    if (!editingRef.current) setDraft(doc.text)
  }, [doc.text])

  const publish = useCallback(
    (text: string) => {
      const current = $doc.get()
      if (text === current.text) return
      const update: SharedDoc = {
        text,
        rev: current.rev + 1,
        by: localParticipant.identity,
        byName: localParticipant.name || localParticipant.identity,
        at: Date.now(),
      }
      applyDocUpdate(update)
      void send(new TextEncoder().encode(JSON.stringify(update)), {
        topic: DataTopic.Doc,
        reliable: true,
      })
      // Persisted too: the data message only reaches people already here.
      void fetch(`/api/rooms/${slug}/doc`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      }).catch(() => undefined)
    },
    [localParticipant, send, slug],
  )

  // Debounced: publishing per keystroke would flood the data channel and
  // make everyone else's cursor jump on every character.
  useEffect(() => {
    if (!editing) return
    const timer = setTimeout(() => publish(draft), PUBLISH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, editing, publish])

  const lastEditor = doc.byName && doc.rev > 0 ? doc.byName : null

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
        <p className="min-w-0 truncate text-base-content/50 text-xs">
          {lastEditor ? `Last edited by ${lastEditor}` : "Shared with the room"}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-circle"
            aria-label="Copy markdown"
            title="Copy markdown"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(draft)
                .then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
                .catch(() => undefined)
            }}
          >
            {copied ? (
              <Check className="size-3.5 text-success" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
          <a
            className="btn btn-ghost btn-xs btn-circle"
            aria-label="Download markdown"
            title="Download markdown"
            download={`${slug}.md`}
            href={`data:text/markdown;charset=utf-8,${encodeURIComponent(draft)}`}
          >
            <Download className="size-3.5" />
          </a>
        </div>
      </div>

      <textarea
        className="min-h-0 flex-1 resize-none border-0 bg-transparent px-4 pb-4 font-mono text-sm leading-relaxed focus:outline-none"
        spellCheck={false}
        value={draft}
        placeholder={
          "# Plan\n\nWrite here, or ask an agent to draft it.\nEveryone in the meeting sees the same document."
        }
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false)
          // Don't wait out the debounce on the way out — leaving the field
          // is the clearest signal that an edit is finished.
          publish(draft)
        }}
      />
    </div>
  )
}
