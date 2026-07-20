import { timingSafeEqual } from "node:crypto"
import { TrackSource } from "livekit-server-sdk"
import { NextResponse } from "next/server"
import { z } from "zod"
import { roomService } from "@/lib/server/livekit"
import { deriveHostKey, isValidRoomSlug } from "@/lib/server/slug"

type Params = { params: Promise<{ slug: string }> }

const moderateSchema = z.object({
  identity: z.string().min(1),
  action: z.enum(["remove", "mute"]),
  /** The organiser's key, held only by the browser that created the room. */
  hostKey: z.string().min(1),
})

function keyMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Moderation actions on another participant — the organiser's alone, and
 * enforced server-side with the host key rather than by trusting a claimed
 * identity (as admit does).
 *
 * Removing disconnects someone; they can follow the link again but land in
 * the waiting room like any newcomer. Muting is deliberately one-way: a host
 * can silence a hot mic, but only its owner can turn it back on.
 */
export async function POST(request: Request, { params }: Params) {
  const { slug } = await params
  if (!isValidRoomSlug(slug)) {
    return NextResponse.json({ error: "invalid room" }, { status: 400 })
  }
  const body = moderateSchema.safeParse(await request.json().catch(() => null))
  if (!body.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 })
  }
  const { identity, action, hostKey } = body.data

  const rooms = await roomService()
    .listRooms([slug])
    .catch(() => [])
  if (rooms.length === 0) {
    return NextResponse.json({ error: "room not found" }, { status: 404 })
  }
  let roomMeta: { hostKey?: string } = {}
  try {
    roomMeta = JSON.parse(rooms[0].metadata || "{}")
  } catch {}
  // Rooms carry the key they were created with; fall back to the derived one
  // so a room recreated after garbage collection still authorises its host.
  const expected = roomMeta.hostKey ?? deriveHostKey(slug)
  if (!keyMatches(hostKey, expected)) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 })
  }

  if (action === "remove") {
    await roomService()
      .removeParticipant(slug, identity)
      .catch(() => undefined)
    return NextResponse.json({ ok: true })
  }

  // Mute: find the participant's live microphone publication and silence it.
  const participants = await roomService()
    .listParticipants(slug)
    .catch(() => [])
  const target = participants.find((p) => p.identity === identity)
  const mic = target?.tracks.find(
    (t) => t.source === TrackSource.MICROPHONE && !t.muted,
  )
  if (!mic) {
    return NextResponse.json({ ok: true, alreadyMuted: true })
  }
  await roomService()
    .mutePublishedTrack(slug, identity, mic.sid, true)
    .catch(() => undefined)
  return NextResponse.json({ ok: true })
}
