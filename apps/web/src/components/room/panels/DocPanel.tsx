"use client"

import {
  useDataChannel,
  useLocalParticipant,
  useParticipants,
} from "@livekit/components-react"
import {
  DataTopic,
  type DocPresence,
  docCursorColor,
  type SharedDoc,
} from "@meet/shared"
import { useStore } from "@nanostores/react"
import { Check, Copy, Download } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { $doc, applyDocUpdate } from "@/stores/doc"
import {
  $docPresence,
  pruneDocPresence,
  type SeenDocPresence,
} from "@/stores/docPresence"

/** How long to sit on keystrokes before telling the room. Short, so people
 * watch each other type nearly live rather than in paragraph-sized bursts. */
const PUBLISH_DEBOUNCE_MS = 150

/** The durable REST copy can lag behind — it only serves late joiners. */
const PERSIST_DEBOUNCE_MS = 1000

/** Cursor moves are throttled; a heartbeat keeps an idle cursor alive. */
const PRESENCE_THROTTLE_MS = 100
const PRESENCE_HEARTBEAT_MS = 3000
const PRESENCE_STALE_MS = 8000

/** Font/spacing classes shared by the textarea and its cursor mirror — the
 * overlay only lines up if both render text with identical metrics. */
const TEXT_CLASSES = "px-4 pb-4 font-mono text-sm leading-relaxed"

/**
 * Carries a caret offset across a remote whole-document replace. Diffs by
 * common prefix/suffix: text before the change keeps its offset, text after
 * it shifts by the length delta, and a caret inside the changed span snaps
 * to the end of the new span.
 */
function remapOffset(oldText: string, newText: string, offset: number): number {
  let prefix = 0
  const max = Math.min(oldText.length, newText.length)
  while (prefix < max && oldText[prefix] === newText[prefix]) prefix++
  if (offset <= prefix) return offset
  let suffix = 0
  while (
    suffix < max - prefix &&
    oldText[oldText.length - 1 - suffix] ===
      newText[newText.length - 1 - suffix]
  ) {
    suffix++
  }
  if (offset >= oldText.length - suffix) {
    return offset + (newText.length - oldText.length)
  }
  return Math.min(newText.length - suffix, newText.length)
}

/** The caret bar plus the floating name pill to its right. */
function CursorCaret({ presence }: { presence: SeenDocPresence }) {
  return (
    <span className="relative inline-block h-[1.1em] w-0 align-baseline">
      <span
        className="absolute -left-px top-0 h-full w-[2px] rounded-full"
        style={{ backgroundColor: presence.color }}
      />
      <span
        className="absolute top-[-2px] left-[4px] max-w-40 truncate whitespace-nowrap rounded px-1 py-px font-sans text-[10px] text-white leading-tight"
        style={{ backgroundColor: presence.color }}
      >
        {presence.byName || presence.by}
      </span>
    </span>
  )
}

/**
 * One remote participant's cursor, drawn by re-rendering the document text
 * invisibly with a zero-width caret anchor inline at the selection end and
 * a tinted span over the selected range. Because the anchor takes no width,
 * it lands at exactly the coordinates the textarea gives the same
 * characters — no caret-position math, no mirror measurement pass.
 */
function CursorLayer({
  text,
  presence,
}: {
  text: string
  presence: SeenDocPresence
}) {
  const start = Math.min(presence.start ?? 0, text.length)
  const end = Math.min(presence.end ?? 0, text.length)
  const [selStart, selEnd] = start <= end ? [start, end] : [end, start]
  return (
    <div
      aria-hidden
      className={`whitespace-pre-wrap break-words text-transparent ${TEXT_CLASSES}`}
    >
      {text.slice(0, selStart)}
      {selEnd > selStart ? (
        <span style={{ backgroundColor: `${presence.color}33` }}>
          {text.slice(selStart, selEnd)}
        </span>
      ) : null}
      <CursorCaret presence={presence} />
      {text.slice(selEnd)}
      {"​"}
    </div>
  )
}

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
  const presenceMap = useStore($docPresence)
  const { localParticipant } = useLocalParticipant()
  const participants = useParticipants()
  const { send } = useDataChannel(DataTopic.Doc)
  const { send: sendPresenceRaw } = useDataChannel(DataTopic.DocPresence)

  // What the textarea shows. Kept separate from the store so a remote edit
  // arriving mid-sentence can be handled deliberately rather than yanking
  // the cursor on every keystroke someone else makes.
  const [draft, setDraft] = useState(doc.text)
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const editingRef = useRef(editing)
  editingRef.current = editing
  const draftRef = useRef(draft)
  draftRef.current = draft
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // The store text the draft was last synced to; when they match, the local
  // person has nothing unpublished and remote edits can land even mid-focus.
  const syncedTextRef = useRef(doc.text)

  // This participant's cursor color: predefined palette by join order for
  // the first ten people, identity-derived hue after that.
  const myColor = useMemo(() => {
    const sorted = [...participants].sort((a, b) => {
      const ta = a.joinedAt?.getTime() ?? Number.POSITIVE_INFINITY
      const tb = b.joinedAt?.getTime() ?? Number.POSITIVE_INFINITY
      return ta !== tb ? ta - tb : a.identity.localeCompare(b.identity)
    })
    const index = sorted.findIndex(
      (p) => p.identity === localParticipant.identity,
    )
    return docCursorColor(localParticipant.identity, index)
  }, [participants, localParticipant])

  // Remote edits land in the textarea unless this person has unpublished
  // typing of their own — losing what someone is actively writing is worse
  // than briefly showing a stale paragraph. When they're merely focused with
  // nothing pending, the edit applies and their caret is carried across it.
  useEffect(() => {
    if (doc.text === draftRef.current) {
      syncedTextRef.current = doc.text
      return
    }
    const hasPendingLocal =
      editingRef.current && draftRef.current !== syncedTextRef.current
    if (hasPendingLocal) return
    const ta = textareaRef.current
    const selStart = ta?.selectionStart ?? null
    const selEnd = ta?.selectionEnd ?? null
    const prev = draftRef.current
    syncedTextRef.current = doc.text
    setDraft(doc.text)
    if (editingRef.current && ta && selStart !== null && selEnd !== null) {
      const nextStart = remapOffset(prev, doc.text, selStart)
      const nextEnd = remapOffset(prev, doc.text, selEnd)
      requestAnimationFrame(() => {
        if (textareaRef.current === ta && document.activeElement === ta) {
          ta.setSelectionRange(nextStart, nextEnd)
        }
      })
    }
  }, [doc.text])

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPersist = useRef<SharedDoc | null>(null)

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
      syncedTextRef.current = update.text
      void send(new TextEncoder().encode(JSON.stringify(update)), {
        topic: DataTopic.Doc,
        reliable: true,
      })
      // Persisted too — the data message only reaches people already here —
      // but on its own, slower clock: the store serves late joiners, so it
      // doesn't need every intermediate keystroke.
      pendingPersist.current = update
      if (persistTimer.current) clearTimeout(persistTimer.current)
      persistTimer.current = setTimeout(() => {
        const body = pendingPersist.current
        pendingPersist.current = null
        if (!body) return
        void fetch(`/api/rooms/${slug}/doc`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      }, PERSIST_DEBOUNCE_MS)
    },
    [localParticipant, send, slug],
  )

  // Flush the durable copy on the way out rather than dropping it.
  useEffect(
    () => () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
      const body = pendingPersist.current
      if (!body) return
      pendingPersist.current = null
      void fetch(`/api/rooms/${slug}/doc`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => undefined)
    },
    [slug],
  )

  // Debounced: publishing per keystroke would flood the data channel.
  useEffect(() => {
    if (!editing) return
    const timer = setTimeout(() => publish(draft), PUBLISH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, editing, publish])

  // --- Presence: where this person's cursor is, broadcast lossy ---

  const presenceThrottle = useRef<{
    lastAt: number
    timer: ReturnType<typeof setTimeout> | null
  }>({ lastAt: 0, timer: null })

  const sendPresence = useCallback(
    (start: number | null, end: number | null) => {
      const msg: DocPresence = {
        by: localParticipant.identity,
        byName: localParticipant.name || localParticipant.identity,
        color: myColor,
        start,
        end,
        at: Date.now(),
      }
      void sendPresenceRaw(new TextEncoder().encode(JSON.stringify(msg)), {
        topic: DataTopic.DocPresence,
        reliable: false,
      })
    },
    [localParticipant, myColor, sendPresenceRaw],
  )

  /** Reads the current selection and broadcasts it, throttled. */
  const queuePresence = useCallback(() => {
    const fire = () => {
      const ta = textareaRef.current
      if (!ta || document.activeElement !== ta) return
      presenceThrottle.current.lastAt = Date.now()
      sendPresence(ta.selectionStart, ta.selectionEnd)
    }
    const state = presenceThrottle.current
    const elapsed = Date.now() - state.lastAt
    if (elapsed >= PRESENCE_THROTTLE_MS) {
      fire()
    } else if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null
        fire()
      }, PRESENCE_THROTTLE_MS - elapsed)
    }
  }, [sendPresence])

  // Heartbeat while focused, so an idle cursor doesn't get pruned as stale.
  useEffect(() => {
    if (!editing) return
    const interval = setInterval(() => {
      const ta = textareaRef.current
      if (ta && document.activeElement === ta) {
        sendPresence(ta.selectionStart, ta.selectionEnd)
      }
    }, PRESENCE_HEARTBEAT_MS)
    return () => clearInterval(interval)
  }, [editing, sendPresence])

  // Sweep out cursors of people who stopped sending (closed panel, etc).
  useEffect(() => {
    const interval = setInterval(
      () => pruneDocPresence(PRESENCE_STALE_MS),
      2000,
    )
    return () => clearInterval(interval)
  }, [])

  // Leaving the panel entirely: tell the room this cursor is gone.
  useEffect(
    () => () => {
      const state = presenceThrottle.current
      if (state.timer) clearTimeout(state.timer)
      sendPresence(null, null)
    },
    [sendPresence],
  )

  const remoteCursors = useMemo(
    () =>
      Object.values(presenceMap).filter(
        (p) =>
          p.by !== localParticipant.identity &&
          p.start !== null &&
          p.end !== null,
      ),
    [presenceMap, localParticipant.identity],
  )

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

      <div className="relative min-h-0 flex-1">
        <textarea
          ref={textareaRef}
          className={`absolute inset-0 size-full resize-none border-0 bg-transparent focus:outline-none ${TEXT_CLASSES}`}
          spellCheck={false}
          value={draft}
          placeholder={
            "# Plan\n\nWrite here, or ask an agent to draft it.\nEveryone in the meeting sees the same document."
          }
          onChange={(e) => {
            setDraft(e.target.value)
            queuePresence()
          }}
          onSelect={queuePresence}
          onKeyUp={queuePresence}
          onClick={queuePresence}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onFocus={() => {
            setEditing(true)
            queuePresence()
          }}
          onBlur={() => {
            setEditing(false)
            // Don't wait out the debounce on the way out — leaving the field
            // is the clearest signal that an edit is finished.
            publish(draft)
            sendPresence(null, null)
          }}
        />
        {/* Remote cursors: one invisible copy of the text per participant,
            scrolled in lockstep with the textarea, showing only the caret,
            name pill, and selection tint. */}
        {remoteCursors.length > 0 && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div style={{ transform: `translateY(-${scrollTop}px)` }}>
              {remoteCursors.map((presence) => (
                <div key={presence.by} className="absolute inset-x-0 top-0">
                  <CursorLayer text={draft} presence={presence} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
