"use client"

import { useParticipants, useTranscriptions } from "@livekit/components-react"

export function TranscriptPanel() {
  const transcriptions = useTranscriptions()
  const participants = useParticipants()
  const displayName = (identity?: string) => {
    if (!identity) return "unknown"
    const p = participants.find((p) => p.identity === identity)
    return p?.name || identity
  }

  if (transcriptions.length === 0) {
    return (
      <p className="p-4 text-base-content/50 text-sm">
        Live transcript appears here once an agent is in the meeting.
      </p>
    )
  }

  return (
    <ul className="space-y-2 p-4">
      {transcriptions.map((t) => (
        <li key={t.streamInfo.id} className="text-sm">
          <span className="font-medium">
            {displayName(t.participantInfo?.identity)}
          </span>
          <p className="text-base-content/80">{t.text}</p>
        </li>
      ))}
    </ul>
  )
}
