"use client"

import { type TrackReference, VideoTrack } from "@livekit/components-react"
import { Minus, Plus } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25
const WHEEL_ZOOM_SENSITIVITY = 0.0015

export function ScreenShareTile({ trackRef }: { trackRef: TrackReference }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  // True only while a step-zoom button's CSS transition is playing, so the
  // continuous wheel/pinch path stays untransitioned and doesn't stutter.
  const [animating, setAnimating] = useState(false)
  const animateTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)
  const dragOrigin = useRef({ x: 0, y: 0, panX: 0, panY: 0 })

  // A new presenter (or the same one restarting) shouldn't inherit the
  // previous viewer's zoom/pan.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trackSid drives the reset
  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [trackRef.publication.trackSid])

  const clampPan = useCallback((nextZoom: number, x: number, y: number) => {
    const el = containerRef.current
    if (!el || nextZoom <= 1) return { x: 0, y: 0 }
    const maxX = (el.clientWidth * (nextZoom - 1)) / 2
    const maxY = (el.clientHeight * (nextZoom - 1)) / 2
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    }
  }, [])

  const applyZoom = useCallback(
    (updater: (z: number) => number) => {
      setZoom((prev) => {
        const next =
          Math.round(
            Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, updater(prev))) * 100,
          ) / 100
        setPan((p) => clampPan(next, p.x, p.y))
        return next
      })
    },
    [clampPan],
  )

  const stepZoom = (delta: number) => {
    clearTimeout(animateTimeout.current)
    setAnimating(true)
    applyZoom((z) => z + delta)
    animateTimeout.current = setTimeout(() => setAnimating(false), 200)
  }

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    applyZoom((z) => z - e.deltaY * WHEEL_ZOOM_SENSITIVITY)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom <= MIN_ZOOM) return
    dragOrigin.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return
    const origin = dragOrigin.current
    setPan(
      clampPan(
        zoom,
        origin.panX + (e.clientX - origin.x),
        origin.panY + (e.clientY - origin.y),
      ),
    )
  }

  const endDrag = () => setDragging(false)

  // Rendering the sharer's own screen back to them nests the meeting window
  // inside itself, producing an infinite-recursion "hall of mirrors" effect.
  // Show them a placeholder instead; everyone else still sees the real feed.
  if (trackRef.participant.isLocal) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-1 rounded-box bg-base-300 text-center">
        <p className="font-medium text-base-content">
          You're presenting your screen
        </p>
        <p className="text-base-content/70 text-sm">
          Others can see your shared screen.
        </p>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative size-full overflow-hidden rounded-box bg-base-300"
      onWheel={onWheel}
    >
      <div
        className={`size-full ${zoom > MIN_ZOOM ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""}`}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "center center",
          transition:
            !dragging && animating
              ? "transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)"
              : "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onPointerCancel={endDrag}
      >
        <VideoTrack trackRef={trackRef} className="size-full object-contain" />
      </div>

      <span className="absolute bottom-2 left-2 badge badge-neutral badge-sm bg-base-100/80 text-base-content backdrop-blur">
        {trackRef.participant.name || trackRef.participant.identity} is
        presenting
      </span>

      <div className="absolute right-2 bottom-2 flex items-center gap-1 rounded-box bg-base-100/80 p-1 backdrop-blur">
        <button
          type="button"
          className="btn btn-circle btn-ghost btn-xs"
          onClick={() => stepZoom(-ZOOM_STEP)}
          disabled={zoom <= MIN_ZOOM}
          aria-label="Zoom out"
        >
          <Minus className="size-3.5" />
        </button>
        <span className="min-w-10 text-center text-xs tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className="btn btn-circle btn-ghost btn-xs"
          onClick={() => stepZoom(ZOOM_STEP)}
          disabled={zoom >= MAX_ZOOM}
          aria-label="Zoom in"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
