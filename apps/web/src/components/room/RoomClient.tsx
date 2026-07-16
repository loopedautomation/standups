"use client"

import { LiveKitRoom } from "@livekit/components-react"
import type { TokenResponse } from "@meet/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { Lobby } from "@/components/room/Lobby"
import { MeetingView } from "@/components/room/MeetingView"

const queryClient = new QueryClient()

export type JoinPreferences = {
  displayName: string
  audioEnabled: boolean
  videoEnabled: boolean
  audioDeviceId?: string
  videoDeviceId?: string
}

export function RoomClient({ slug }: { slug: string }) {
  const [session, setSession] = useState<{
    token: TokenResponse
    prefs: JoinPreferences
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleJoin = useCallback(
    async (prefs: JoinPreferences) => {
      setError(null)
      try {
        const res = await fetch(`/api/rooms/${slug}/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: prefs.displayName }),
        })
        if (!res.ok) throw new Error(`token request failed (${res.status})`)
        const token = (await res.json()) as TokenResponse
        setSession({ token, prefs })
      } catch {
        setError("Could not join the meeting. Please try again.")
      }
    },
    [slug],
  )

  // Back to the lobby (not the landing page) so a refresh or accidental
  // disconnect is one click from rejoining.
  const handleLeave = useCallback(() => {
    setSession(null)
  }, [])

  if (!session) {
    return <Lobby slug={slug} onJoin={handleJoin} error={error} />
  }

  return (
    <LiveKitRoom
      token={session.token.token}
      serverUrl={session.token.serverUrl}
      // Join with the lobby's mic setting — unless others are already in the
      // call, in which case join muted (unmute from the control bar).
      audio={
        session.prefs.audioEnabled &&
        session.token.participantCount === 0 && {
          deviceId: session.prefs.audioDeviceId,
        }
      }
      video={
        session.prefs.videoEnabled && {
          deviceId: session.prefs.videoDeviceId,
        }
      }
      onDisconnected={handleLeave}
      className="h-dvh"
    >
      <QueryClientProvider client={queryClient}>
        <MeetingView slug={slug} />
      </QueryClientProvider>
    </LiveKitRoom>
  )
}
