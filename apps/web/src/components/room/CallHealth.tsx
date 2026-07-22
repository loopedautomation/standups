"use client"

import { useParticipants, useRoomContext } from "@livekit/components-react"
import { parseParticipantMeta } from "@meet/shared"
import { ConnectionQuality, Track } from "livekit-client"
import { Activity } from "lucide-react"
import { useEffect, useState } from "react"
import { Modal } from "@/components/ui/Modal"

const POLL_MS = 2000

function formatKbps(bitsPerSecond: number): string {
  if (!bitsPerSecond) return "—"
  const kbps = bitsPerSecond / 1000
  return kbps >= 1000
    ? `${(kbps / 1000).toFixed(1)} Mbps`
    : `${Math.round(kbps)} kbps`
}

const QUALITY_LABEL: Record<ConnectionQuality, string> = {
  [ConnectionQuality.Excellent]: "excellent",
  [ConnectionQuality.Good]: "good",
  [ConnectionQuality.Poor]: "poor",
  [ConnectionQuality.Lost]: "lost",
  [ConnectionQuality.Unknown]: "unknown",
}

const QUALITY_BADGE: Record<ConnectionQuality, string> = {
  [ConnectionQuality.Excellent]: "badge-success",
  [ConnectionQuality.Good]: "badge-success",
  [ConnectionQuality.Poor]: "badge-warning",
  [ConnectionQuality.Lost]: "badge-error",
  [ConnectionQuality.Unknown]: "badge-ghost",
}

type LocalStats = {
  rttMs?: number
  jitterMs?: number
  packetsLost?: number
  audioBps: number
  videoBps: number
}

/** Poll WebRTC stats for the local participant's published tracks. */
function useLocalStats(): LocalStats {
  const room = useRoomContext()
  const [stats, setStats] = useState<LocalStats>({ audioBps: 0, videoBps: 0 })

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      const local = room.localParticipant
      const mic = local.getTrackPublication(Track.Source.Microphone)?.track
      const cam = local.getTrackPublication(Track.Source.Camera)?.track
      const next: LocalStats = {
        audioBps: mic?.currentBitrate ?? 0,
        videoBps: cam?.currentBitrate ?? 0,
      }
      // RTT rides the selected ICE candidate pair; loss/jitter come from the
      // SFU's receiver report about our outbound audio.
      const report = await (mic ?? cam)?.getRTCStatsReport?.()
      if (report) {
        for (const s of report.values()) {
          if (
            s.type === "candidate-pair" &&
            (s as { nominated?: boolean }).nominated &&
            (s as { currentRoundTripTime?: number }).currentRoundTripTime !==
              undefined
          ) {
            next.rttMs =
              (s as { currentRoundTripTime: number }).currentRoundTripTime *
              1000
          } else if (s.type === "remote-inbound-rtp") {
            const r = s as { jitter?: number; packetsLost?: number }
            if (r.jitter !== undefined) next.jitterMs = r.jitter * 1000
            if (r.packetsLost !== undefined) next.packetsLost = r.packetsLost
          }
        }
      }
      if (!cancelled) setStats(next)
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [room])

  return stats
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between text-sm">
      <span className="text-base-content/70">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </li>
  )
}

/** The settings panel's Network section: your own link, plus the room view. */
export function NetworkSection() {
  const room = useRoomContext()
  const stats = useLocalStats()
  const [healthOpen, setHealthOpen] = useState(false)
  // connectionQuality updates ride participant events; the poll cadence of
  // the stats hook re-renders often enough to keep this fresh.
  const quality = room.localParticipant.connectionQuality

  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-base-content/60 text-xs uppercase tracking-wide">
        Network
      </h3>
      <ul className="flex flex-col gap-1">
        <StatRow
          label="Connection quality"
          value={QUALITY_LABEL[quality] ?? "unknown"}
        />
        <StatRow
          label="Latency (RTT)"
          value={
            stats.rttMs !== undefined ? `${Math.round(stats.rttMs)} ms` : "—"
          }
        />
        <StatRow
          label="Jitter"
          value={
            stats.jitterMs !== undefined
              ? `${stats.jitterMs.toFixed(1)} ms`
              : "—"
          }
        />
        <StatRow
          label="Packets lost"
          value={stats.packetsLost !== undefined ? `${stats.packetsLost}` : "—"}
        />
        <StatRow label="Audio sent" value={formatKbps(stats.audioBps)} />
        <StatRow label="Video sent" value={formatKbps(stats.videoBps)} />
      </ul>
      <button
        type="button"
        className="btn btn-sm w-full gap-1"
        onClick={() => setHealthOpen(true)}
      >
        <Activity className="size-4" />
        Call health
      </button>
      <CallHealthModal
        isOpen={healthOpen}
        onClose={() => setHealthOpen(false)}
      />
    </section>
  )
}

/**
 * Everyone's link at a glance. Quality is reported by the server per
 * participant; bitrates are what this client sends (you) or receives
 * (everyone else) — a remote camera you've unsubscribed shows "—".
 */
function CallHealthModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean
  onClose: () => void
}) {
  const participants = useParticipants()
  // Re-render on a cadence: currentBitrate is a live getter, not reactive.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!isOpen) return
    const timer = setInterval(() => setTick((t) => t + 1), POLL_MS)
    return () => clearInterval(timer)
  }, [isOpen])

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <h3 className="pb-3 font-semibold text-lg">Call health</h3>
      <ul className="flex flex-col gap-3">
        {participants
          .filter((p) => parseParticipantMeta(p.metadata)?.kind !== "waiting")
          .map((p) => {
            let audio = 0
            let video = 0
            for (const pub of p.trackPublications.values()) {
              const bps = pub.track?.currentBitrate ?? 0
              if (pub.kind === Track.Kind.Audio) audio += bps
              else video += bps
            }
            return (
              <li key={p.identity} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {p.name || p.identity}
                  {p.isLocal && (
                    <span className="text-base-content/50"> (you)</span>
                  )}
                </span>
                <span className="font-mono text-base-content/70 text-xs">
                  ↑↓ {formatKbps(audio)} / {formatKbps(video)}
                </span>
                <span
                  className={`badge badge-sm ${QUALITY_BADGE[p.connectionQuality] ?? "badge-ghost"}`}
                >
                  {QUALITY_LABEL[p.connectionQuality] ?? "unknown"}
                </span>
              </li>
            )
          })}
      </ul>
      <p className="pt-3 text-base-content/50 text-xs">
        Quality is reported by the server for each participant. Bitrates are
        measured from this device: what you send, and what you receive from the
        others.
      </p>
    </Modal>
  )
}
