"use client"

import { type TrackReference, VideoTrack } from "@livekit/components-react"
import { Minus, Plus, Scan } from "lucide-react"
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

const MIN_SCALE = 1
const MAX_SCALE = 4
// Multiplicative button steps stay even across the range (1 → 1.5 → 2.25 …);
// a fixed +0.5 would crawl near the top and leap near the bottom.
const STEP = 1.5

type Offset = { x: number; y: number }

export function ScreenShareTile({ trackRef }: { trackRef: TrackReference }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { scale, offset, animated, zoomTo, reset, handlers } =
    usePanZoom(containerRef)
  const zoomed = scale > MIN_SCALE

  return (
    <div
      ref={containerRef}
      // touch-none hands pinch/pan gestures to us instead of the browser's
      // native page zoom; select-none stops drags from selecting the badge.
      className={`relative size-full touch-none select-none overflow-hidden rounded-box bg-base-300 ${
        zoomed ? "cursor-grab active:cursor-grabbing" : ""
      }`}
      {...handlers}
    >
      <VideoTrack
        trackRef={trackRef}
        className="size-full object-contain"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          // Animate only the button/double-click jumps; a live gesture must
          // stay glued to the pointer, so those set animated=false.
          transition: animated ? "transform 150ms ease-out" : "none",
        }}
      />

      {/* Zoom controls. stopPropagation keeps a button press from also
          starting a pan drag on the tile beneath it. */}
      <div
        className="absolute top-2 right-2 z-10 flex items-center gap-1"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="join rounded-box bg-base-100/80 backdrop-blur">
          <button
            type="button"
            className="btn join-item btn-ghost btn-sm"
            onClick={() => zoomTo(scale / STEP, null, true)}
            disabled={scale <= MIN_SCALE}
            aria-label="Zoom out"
          >
            <Minus className="size-4" />
          </button>
          <span className="join-item flex min-w-12 items-center justify-center px-1 font-medium text-base-content text-xs tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="btn join-item btn-ghost btn-sm"
            onClick={() => zoomTo(scale * STEP, null, true)}
            disabled={scale >= MAX_SCALE}
            aria-label="Zoom in"
          >
            <Plus className="size-4" />
          </button>
        </div>
        {zoomed && (
          <div className="tooltip tooltip-bottom" data-tip="Reset zoom">
            <button
              type="button"
              className="btn btn-circle btn-ghost btn-sm border-0 bg-base-100/80 backdrop-blur"
              onClick={reset}
              aria-label="Reset zoom"
            >
              <Scan className="size-4" />
            </button>
          </div>
        )}
      </div>

      <span className="absolute bottom-2 left-2 badge badge-neutral badge-sm bg-base-100/80 text-base-content backdrop-blur">
        {trackRef.participant.name || trackRef.participant.identity} is
        presenting
      </span>
    </div>
  )
}

type PanZoom = {
  scale: number
  offset: Offset
  animated: boolean
  /** Zoom to an absolute scale, optionally keeping a client point fixed. */
  zoomTo: (scale: number, focal: Offset | null, animate?: boolean) => void
  reset: () => void
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void
    onDoubleClick: (e: ReactPointerEvent<HTMLDivElement>) => void
  }
}

/**
 * Pan + zoom over a fixed container. State lives in a ref (the source of truth
 * gestures read synchronously) mirrored into React state for rendering, so
 * back-to-back wheel/pointer events never race on a stale value.
 */
function usePanZoom(containerRef: RefObject<HTMLDivElement | null>): PanZoom {
  const [view, setView] = useState({
    scale: MIN_SCALE,
    offset: { x: 0, y: 0 } as Offset,
    animated: false,
  })
  const ref = useRef(view)
  const set = useCallback((next: typeof view) => {
    ref.current = next
    setView(next)
  }, [])

  // Keep the scaled frame covering the viewport: pan reaches every edge of the
  // content but never past it into the letterbox.
  const clamp = useCallback(
    (s: number, o: Offset): Offset => {
      const el = containerRef.current
      if (!el || s <= MIN_SCALE) return { x: 0, y: 0 }
      const maxX = ((s - 1) * el.clientWidth) / 2
      const maxY = ((s - 1) * el.clientHeight) / 2
      return {
        x: Math.max(-maxX, Math.min(maxX, o.x)),
        y: Math.max(-maxY, Math.min(maxY, o.y)),
      }
    },
    [containerRef],
  )

  const zoomTo = useCallback(
    (rawScale: number, focal: Offset | null, animate = false) => {
      const el = containerRef.current
      if (!el) return
      const { scale: prev, offset: prevOff } = ref.current
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, rawScale))
      if (next === prev) return
      // Focal point relative to the element centre (its transform origin);
      // (0,0) = zoom about the centre, which is what the +/- buttons pass.
      let fx = 0
      let fy = 0
      if (focal) {
        const rect = el.getBoundingClientRect()
        fx = focal.x - (rect.left + rect.width / 2)
        fy = focal.y - (rect.top + rect.height / 2)
      }
      // Solve for the offset that keeps the focal point stationary as scale
      // goes prev → next (screen = offset + scale · content).
      const offset = clamp(next, {
        x: fx - (next / prev) * (fx - prevOff.x),
        y: fy - (next / prev) * (fy - prevOff.y),
      })
      set({ scale: next, offset, animated: animate })
    },
    [containerRef, clamp, set],
  )

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const { scale, offset } = ref.current
      if (scale <= MIN_SCALE) return
      set({
        scale,
        offset: clamp(scale, { x: offset.x + dx, y: offset.y + dy }),
        animated: false,
      })
    },
    [clamp, set],
  )

  const reset = useCallback(
    () => set({ scale: MIN_SCALE, offset: { x: 0, y: 0 }, animated: true }),
    [set],
  )

  // React marks onWheel passive, so preventDefault there is a no-op — attach a
  // non-passive native listener to stop the page scrolling while we zoom.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomTo(
        ref.current.scale * Math.exp(-e.deltaY * 0.0015),
        { x: e.clientX, y: e.clientY },
        false,
      )
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [containerRef, zoomTo])

  // Active pointers drive both single-finger pan and two-finger pinch.
  const pointers = useRef(new Map<number, Offset>())
  const pinchDist = useRef(0)

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const el = containerRef.current
      el?.setPointerCapture(e.pointerId)
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()]
        pinchDist.current = Math.hypot(a.x - b.x, a.y - b.y)
      }
    },
    [containerRef],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const p = pointers.current
      const prev = p.get(e.pointerId)
      if (!prev) return
      p.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (p.size >= 2) {
        const [a, b] = [...p.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinchDist.current > 0) {
          zoomTo(
            ref.current.scale * (dist / pinchDist.current),
            { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            false,
          )
        }
        pinchDist.current = dist
        return
      }

      panBy(e.clientX - prev.x, e.clientY - prev.y)
    },
    [panBy, zoomTo],
  )

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      pointers.current.delete(e.pointerId)
      if (pointers.current.size < 2) pinchDist.current = 0
      const el = containerRef.current
      if (el?.hasPointerCapture(e.pointerId))
        el.releasePointerCapture(e.pointerId)
    },
    [containerRef],
  )

  const onDoubleClick = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (ref.current.scale > MIN_SCALE) reset()
      else zoomTo(2, { x: e.clientX, y: e.clientY }, true)
    },
    [reset, zoomTo],
  )

  return {
    scale: view.scale,
    offset: view.offset,
    animated: view.animated,
    zoomTo,
    reset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick,
    },
  }
}
