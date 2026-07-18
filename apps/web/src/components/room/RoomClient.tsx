"use client"

import { LiveKitRoom } from "@livekit/components-react"
import type { TokenResponse } from "@meet/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { setLogLevel } from "livekit-client"
import { useCallback, useEffect, useState } from "react"
import { toast } from "react-toastify"
import { Lobby } from "@/components/room/Lobby"
import { MeetingView } from "@/components/room/MeetingView"
import { WaitingRoom } from "@/components/room/WaitingRoom"

const queryClient = new QueryClient()

export type JoinPreferences = {
  displayName: string
  audioEnabled: boolean
  videoEnabled: boolean
  audioDeviceId?: string
  videoDeviceId?: string
}

export function RoomClient({
  slug,
  shareBase,
}: {
  slug: string
  shareBase?: string
}) {
  // Surface connection diagnostics in the console; full debug via env flag.
  useEffect(() => {
    setLogLevel(process.env.NEXT_PUBLIC_LK_DEBUG === "1" ? "debug" : "info")
  }, [])

  const [session, setSession] = useState<{
    token: TokenResponse
    prefs: JoinPreferences
  } | null>(null)
  const [rejoining, setRejoining] = useState(false)
  const [admitted, setAdmitted] = useState(false)

  const handleJoin = useCallback(
    async (prefs: JoinPreferences, rejoinToken?: string) => {
      setAdmitted(false)
      try {
        const res = await fetch(`/api/rooms/${slug}/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: prefs.displayName, rejoinToken }),
        })
        if (res.status === 404) {
          toast.error(
            "This meeting doesn't exist or has already ended. Ask for a fresh link.",
          )
          return
        }
        if (!res.ok) throw new Error(`token request failed (${res.status})`)
        const token = (await res.json()) as TokenResponse
        try {
          sessionStorage.setItem(
            `rejoin:${slug}`,
            // The token doubles as proof of admission on the next refresh.
            JSON.stringify({ prefs, rejoinToken: token.token }),
          )
        } catch {}
        setSession({ token, prefs })
      } catch {
        toast.error("Could not join the meeting. Please try again.")
      }
    },
    [slug],
  )

  // A refresh rejoins the meeting automatically; only an explicit leave (or a
  // server-side disconnect) drops back to the lobby.
  useEffect(() => {
    let stored: { prefs: JoinPreferences; rejoinToken?: string } | null = null
    try {
      const raw = sessionStorage.getItem(`rejoin:${slug}`)
      if (raw) {
        const parsed = JSON.parse(raw)
        // Older entries stored the preferences at the top level.
        stored = parsed.prefs
          ? parsed
          : { prefs: parsed as JoinPreferences, rejoinToken: undefined }
      }
    } catch {}
    if (!stored?.prefs?.displayName) return
    setRejoining(true)
    handleJoin(stored.prefs, stored.rejoinToken).finally(() =>
      setRejoining(false),
    )
  }, [slug, handleJoin])

  // On admission, swap the stored waiting token for an admitted one while
  // the server can still see us connected as human — so a later refresh
  // walks straight in instead of knocking again.
  const handleAdmitted = useCallback(() => {
    setAdmitted(true)
    const current = sessionStorage.getItem(`rejoin:${slug}`)
    if (!current) return
    try {
      const stored = JSON.parse(current) as {
        prefs: JoinPreferences
        rejoinToken?: string
      }
      void fetch(`/api/rooms/${slug}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: stored.prefs.displayName,
          rejoinToken: stored.rejoinToken,
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((fresh: TokenResponse | null) => {
          if (fresh && !fresh.waiting) {
            sessionStorage.setItem(
              `rejoin:${slug}`,
              JSON.stringify({ prefs: stored.prefs, rejoinToken: fresh.token }),
            )
          }
        })
        .catch(() => undefined)
    } catch {}
  }, [slug])

  const handleLeave = useCallback(() => {
    try {
      sessionStorage.removeItem(`rejoin:${slug}`)
    } catch {}
    setSession(null)
  }, [slug])

  if (rejoining) {
    return (
      <main className="flex min-h-dvh items-center justify-center gap-3">
        <span className="loading loading-spinner" />
        Rejoining…
      </main>
    )
  }

  if (!session) {
    return <Lobby slug={slug} onJoin={handleJoin} />
  }

  const inWaitingRoom = session.token.waiting && !admitted

  // Phone-sized screens capture portrait video (9:16) — LiveKit's default
  // capture presets are landscape, which is what makes a phone's camera
  // publish a sideways-looking track. Applied as the room's capture default
  // so later camera toggles inherit it too.
  const portraitCapture =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 639px)").matches

  return (
    <LiveKitRoom
      token={session.token.token}
      serverUrl={session.token.serverUrl}
      options={{
        videoCaptureDefaults: portraitCapture
          ? { resolution: { width: 720, height: 1280 } }
          : undefined,
      }}
      // Waiting participants join without media; on admission WaitingRoom
      // brings devices up per the lobby preferences. Otherwise join with the
      // lobby's mic setting — unless others are already in the call, in
      // which case join muted (unmute from the control bar).
      audio={
        !session.token.waiting &&
        session.prefs.audioEnabled &&
        session.token.participantCount === 0 && {
          deviceId: session.prefs.audioDeviceId,
        }
      }
      video={
        !session.token.waiting &&
        session.prefs.videoEnabled && {
          deviceId: session.prefs.videoDeviceId,
        }
      }
      onDisconnected={handleLeave}
      onError={(err) => {
        toast.error(
          `Could not connect to the meeting server (${err.message}). ` +
            "Check that the LiveKit server is running and reachable.",
        )
      }}
      className="h-dvh"
    >
      <QueryClientProvider client={queryClient}>
        {inWaitingRoom ? (
          <WaitingRoom prefs={session.prefs} onAdmitted={handleAdmitted} />
        ) : (
          <MeetingView slug={slug} shareBase={shareBase} />
        )}
      </QueryClientProvider>
    </LiveKitRoom>
  )
}
