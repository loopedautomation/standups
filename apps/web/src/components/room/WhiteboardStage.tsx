"use client"

import { useStore } from "@nanostores/react"
import dynamic from "next/dynamic"
import { $agentDrawing } from "@/stores/canvas"

// Excalidraw is browser-only and heavy: loaded as its own chunk the first
// time someone opens the board, never on room join.
const WhiteboardCanvas = dynamic(
  () => import("./WhiteboardCanvas").then((m) => m.WhiteboardCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center">
        <span className="loading loading-spinner loading-lg" />
      </div>
    ),
  },
)

/** The shared whiteboard, owning the stage the way a screenshare does. */
export function WhiteboardStage({ slug }: { slug: string }) {
  const agentDrawing = useStore($agentDrawing)

  return (
    <div className="relative h-full w-full overflow-hidden rounded-box border border-base-300 bg-base-100">
      <WhiteboardCanvas slug={slug} />
      {/* Bottom-center: Excalidraw's own UI owns the top (menu, toolbar)
          and the bottom corners (zoom, help). */}
      {agentDrawing && (
        <div className="badge badge-primary absolute bottom-3 left-1/2 z-10 -translate-x-1/2 gap-2 shadow-md">
          <span className="loading loading-dots loading-xs" />
          {agentDrawing.name} is drawing
        </div>
      )}
    </div>
  )
}
