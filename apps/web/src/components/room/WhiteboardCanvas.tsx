"use client"

import {
  CaptureUpdateAction,
  Excalidraw,
  restoreElements,
} from "@excalidraw/excalidraw"
import type {
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types"
import {
  useDataChannel,
  useLocalParticipant,
  useParticipants,
} from "@livekit/components-react"
import {
  CANVAS_PRESENCE_HEARTBEAT_MS,
  CANVAS_PRESENCE_STALE_MS,
  CANVAS_PRESENCE_THROTTLE_MS,
  type CanvasDiff,
  type CanvasRecord,
  canvasPresenceSchema,
  chunkCanvasChanges,
  DataTopic,
  docCursorColor,
  MAX_CANVAS_MESSAGE_BYTES,
} from "@meet/shared"
import { useStore } from "@nanostores/react"
import { X } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"
import { roomAuthHeaders } from "@/lib/roomAuth"
import {
  $canvasOpen,
  $canvasRecords,
  adoptCanvasRecord,
  applyCanvasChanges,
  isElementChurn,
} from "@/stores/canvas"
import { $theme } from "@/stores/theme"
import "@excalidraw/excalidraw/index.css"

// Self-hosted because the app's COEP require-corp headers would block the
// default CDN; copied from the package by scripts/copy-excalidraw-assets.mjs.
if (typeof window !== "undefined") {
  ;(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
    "/excalidraw/"
}

/** Batch local edits before broadcasting; LWW makes lost interims harmless. */
const BROADCAST_THROTTLE_MS = 120

/**
 * How long local edits may accumulate before the durable snapshot PUT
 * fires. A trailing throttle, not a debounce: the bridge bases agent edits
 * on the snapshot store, so continuous local editing must not postpone the
 * PUT indefinitely — a starved store hands the agent stale LWW clocks and
 * its moves silently lose everywhere.
 */
const SNAPSHOT_THROTTLE_MS = 3_000

type LooseElement = Record<string, unknown>

/** The scene as Excalidraw wants it: live elements, sanitized and repaired. */
function sceneFromCache(): LooseElement[] {
  const elements = Object.values($canvasRecords.get())
    .filter((entry) => entry.record && entry.record.isDeleted !== true)
    .map((entry) => entry.record as LooseElement)
  // biome-ignore lint/suspicious/noExplicitAny: opaque element JSON
  return restoreElements(elements as any, null, {
    repairBindings: true,
    refreshDimensions: false,
  }) as unknown as LooseElement[]
}

/**
 * The collaborative Excalidraw surface. The nanostore record cache is the
 * source of truth; this component projects it into a live editor, broadcasts
 * local edits as element diffs, and folds remote diffs back in.
 */
export function WhiteboardCanvas({ slug }: { slug: string }) {
  const { localParticipant } = useLocalParticipant()
  const participants = useParticipants()
  const { send } = useDataChannel(DataTopic.Canvas)

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const presence = useRef(
    new Map<string, { name: string; x: number; y: number; at: number }>(),
  )
  const pendingBroadcast = useRef(new Map<string, CanvasRecord>())
  const broadcastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const remoteFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapshotDirty = useRef(false)

  const identity = localParticipant?.identity ?? ""
  const displayName = localParticipant?.name || identity
  // DaisyUI's data-theme is the source of truth; the prop re-renders on toggle.
  const theme = useStore($theme) === "looped-dark" ? "dark" : "light"

  // Stable join-order color assignment, hash fallback past the palette —
  // the same palette as the doc's cursors, so one person is one color
  // everywhere.
  const joinOrder = useMemo(
    () =>
      [...participants]
        .sort(
          (a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0),
        )
        .map((p) => p.identity),
    [participants],
  )
  const colorFor = (who: string) => docCursorColor(who, joinOrder.indexOf(who))

  const flushBroadcast = () => {
    if (broadcastTimer.current) {
      clearTimeout(broadcastTimer.current)
      broadcastTimer.current = null
    }
    const changes = [...pendingBroadcast.current.values()].map(shrinkForWire)
    pendingBroadcast.current.clear()
    if (changes.length === 0) return
    const diff: CanvasDiff = {
      type: "diff",
      from: identity,
      fromName: displayName,
      changes,
    }
    for (const chunk of chunkCanvasChanges(changes)) {
      void send(
        new TextEncoder().encode(JSON.stringify({ ...diff, changes: chunk })),
        { topic: DataTopic.Canvas, reliable: true },
      )
    }
  }

  const schedulePut = () => {
    snapshotDirty.current = true
    if (snapshotTimer.current) return
    snapshotTimer.current = setTimeout(() => {
      snapshotTimer.current = null
      putSnapshot()
    }, SNAPSHOT_THROTTLE_MS)
  }

  const putSnapshot = () => {
    if (!snapshotDirty.current) return
    snapshotDirty.current = false
    const body = { records: Object.values($canvasRecords.get()) }
    void fetch(`/api/rooms/${slug}/canvas`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...roomAuthHeaders(slug),
      },
      body: JSON.stringify(body),
    }).catch(() => undefined)
  }

  /**
   * Outgoing: every scene change is diffed against the cache by Excalidraw's
   * own version/versionNonce, which is also what makes remote applies safe —
   * an element we just merged in matches the cache exactly and is skipped,
   * so there is no echo loop.
   */
  const onSceneChange = () => {
    const api = apiRef.current
    if (!api) return
    // The onChange args omit deleted elements; deletions only show here.
    const elements =
      api.getSceneElementsIncludingDeleted() as unknown as LooseElement[]
    const cache = $canvasRecords.get()
    const at = Date.now()
    const touched: CanvasRecord[] = []
    for (const element of elements) {
      const id = element.id as string
      const cached = cache[id]?.record
      if (
        cached &&
        cached.version === element.version &&
        cached.versionNonce === element.versionNonce
      ) {
        continue
      }
      // A cache tombstone with a still-live scene element is a remote
      // delete/clear the editor hasn't applied yet — re-authoring it here
      // would resurrect the shape with a fresher LWW clock and the delete
      // would silently lose. Skip it; the scene rebuild drops it next.
      if (cached?.isDeleted === true && element.isDeleted !== true) {
        continue
      }
      // Version churn without a content change is Excalidraw's own
      // bookkeeping (fractional-index assignment on restore, binding
      // repairs): fold it into the cache but don't re-author the element —
      // bumping `v` here makes agent moves lose the LWW race later.
      if (cached && isElementChurn(cached, element)) {
        adoptCanvasRecord(id, element)
        continue
      }
      touched.push({
        id,
        record: JSON.parse(JSON.stringify(element)) as LooseElement,
        v: (cache[id]?.v ?? 0) + 1,
        at,
        by: identity,
      })
    }
    if (touched.length === 0) return
    for (const won of applyCanvasChanges(touched)) {
      pendingBroadcast.current.set(won.id, won)
    }
    if (!broadcastTimer.current) {
      broadcastTimer.current = setTimeout(flushBroadcast, BROADCAST_THROTTLE_MS)
    }
    schedulePut()
  }

  // Incoming: cache changes (remote diffs, late snapshot fetch) → editor.
  // Batched: a chunked agent diff arrives as many cache writes in one tick,
  // and one scene rebuild covers them all.
  // biome-ignore lint/correctness/useExhaustiveDependencies: onSceneChange reads only refs and stores; identity is the sole input that must resubscribe
  useEffect(() => {
    const unlisten = $canvasRecords.listen((records, _old, changedKey) => {
      if (records[changedKey]?.by === identity) return
      if (remoteFlushTimer.current) return
      remoteFlushTimer.current = setTimeout(() => {
        remoteFlushTimer.current = null
        const api = apiRef.current
        if (!api) return
        // Fold in any local edit Excalidraw has committed but not yet
        // delivered through onChange — a delete or drag landing while an
        // agent's reveal streams in. Rebuilding without it would silently
        // revert the edit; capturing it first re-authors it on top of the
        // just-merged remote clock, so it wins the LWW race instead.
        onSceneChange()
        try {
          api.updateScene({
            // biome-ignore lint/suspicious/noExplicitAny: opaque element JSON
            elements: sceneFromCache() as any,
            captureUpdate: CaptureUpdateAction.NEVER,
          })
        } catch (err) {
          // One bad element must not take the board down.
          console.warn("whiteboard: scene update failed", err)
        }
      }, 30)
    })
    return unlisten
  }, [identity])

  // Presence out: cursor position, throttled, with a heartbeat so cursors
  // survive quiet moments; lossy delivery, never persisted.
  const lastPresenceAt = useRef(0)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)
  const { send: sendPresence } = useDataChannel(
    DataTopic.CanvasPresence,
    (msg) => {
      try {
        const parsed = canvasPresenceSchema.safeParse(
          JSON.parse(new TextDecoder().decode(msg.payload)),
        )
        if (!parsed.success) return
        // The actual LiveKit sender outranks the payload's claimed one.
        const from = msg.from?.identity ?? parsed.data.from
        if (from === identity) return
        if (parsed.data.gone) {
          // A finished cursor (the agent's, when it stops drawing) leaves
          // immediately instead of lingering until the staleness prune.
          presence.current.delete(from)
        } else {
          presence.current.set(from, {
            name: msg.from?.name || parsed.data.name,
            x: parsed.data.x,
            y: parsed.data.y,
            at: Date.now(),
          })
        }
        pushCollaborators()
      } catch {}
    },
  )
  const sendCursor = () => {
    const point = lastPoint.current
    if (!point) return
    lastPresenceAt.current = Date.now()
    void sendPresence(
      new TextEncoder().encode(
        JSON.stringify({
          type: "cursor",
          from: identity,
          name: displayName,
          x: point.x,
          y: point.y,
          at: Date.now(),
        }),
      ),
      { topic: DataTopic.CanvasPresence, reliable: false },
    )
  }

  const pushCollaborators = () => {
    const api = apiRef.current
    if (!api) return
    const collaborators = new Map<SocketId, Collaborator>()
    for (const [who, cursor] of presence.current) {
      collaborators.set(who as SocketId, {
        username: cursor.name,
        pointer: { x: cursor.x, y: cursor.y, tool: "pointer" },
        color: { background: colorFor(who), stroke: colorFor(who) },
      })
    }
    api.updateScene({ collaborators })
  }

  useEffect(() => {
    const heartbeat = setInterval(sendCursor, CANVAS_PRESENCE_HEARTBEAT_MS)
    const prune = setInterval(() => {
      const cutoff = Date.now() - CANVAS_PRESENCE_STALE_MS
      let changed = false
      for (const [who, cursor] of presence.current) {
        if (cursor.at < cutoff) {
          presence.current.delete(who)
          changed = true
        }
      }
      if (changed) pushCollaborators()
    }, 2_000)
    return () => {
      clearInterval(heartbeat)
      clearInterval(prune)
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: reads refs only
  }, [])

  // Leaving the board: say what's pending, then persist immediately.
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount only
  useEffect(
    () => () => {
      flushBroadcast()
      if (snapshotTimer.current) clearTimeout(snapshotTimer.current)
      if (remoteFlushTimer.current) clearTimeout(remoteFlushTimer.current)
      putSnapshot()
    },
    [],
  )

  return (
    <div className="h-full w-full">
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api
        }}
        initialData={{
          // biome-ignore lint/suspicious/noExplicitAny: opaque element JSON
          elements: sceneFromCache() as any,
          scrollToContent: true,
        }}
        onChange={onSceneChange}
        onPointerUpdate={({ pointer }) => {
          lastPoint.current = { x: pointer.x, y: pointer.y }
          if (
            Date.now() - lastPresenceAt.current >=
            CANVAS_PRESENCE_THROTTLE_MS
          ) {
            sendCursor()
          }
        }}
        theme={theme}
        renderTopRightUI={() => (
          <button
            type="button"
            className="btn btn-circle btn-sm shadow-md"
            onClick={() => $canvasOpen.set(false)}
            aria-label="Close whiteboard"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        UIOptions={{
          canvasActions: {
            // Clearing wipes elements from the scene entirely (not
            // isDeleted), which the version differ can't see — and a
            // one-click room-wide wipe is a footgun anyway.
            clearCanvas: false,
            // Loading a .excalidraw file would replace the shared scene
            // outside the sync path.
            loadScene: false,
            export: false,
            saveToActiveFile: false,
          },
          tools: {
            // Images need Excalidraw's binary-file store, which the sync
            // doesn't carry — the tool would produce broken shapes.
            image: false,
          },
        }}
      />
    </div>
  )
}

/**
 * Keep a record under the reliable-message budget for broadcast: freehand
 * strokes can outgrow it, so their points are thinned until they fit. The
 * full-fidelity record still reaches the store via the snapshot PUT, and
 * LWW means the thinned copy is only ever an interim state.
 */
function shrinkForWire(entry: CanvasRecord): CanvasRecord {
  if (!entry.record) return entry
  if (JSON.stringify(entry).length <= MAX_CANVAS_MESSAGE_BYTES) return entry
  let points = entry.record.points as [number, number][] | undefined
  if (!Array.isArray(points)) return entry
  for (let attempt = 0; attempt < 4; attempt++) {
    const last: number = points.length - 1
    points = points.filter((_, i) => i % 2 === 0 || i === last)
    const candidate = {
      ...entry,
      record: { ...entry.record, points },
    }
    if (JSON.stringify(candidate).length <= MAX_CANVAS_MESSAGE_BYTES) {
      return candidate
    }
  }
  return { ...entry, record: { ...entry.record, points } }
}
