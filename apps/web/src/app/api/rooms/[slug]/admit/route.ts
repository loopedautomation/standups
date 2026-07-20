import type { ParticipantMeta } from "@meet/shared"
import { parseParticipantMeta } from "@meet/shared"
import { NextResponse } from "next/server"
import { z } from "zod"
import { roomService } from "@/lib/server/livekit"
import { isValidRoomSlug } from "@/lib/server/slug"

type Params = { params: Promise<{ slug: string }> }

const admitSchema = z.object({
  identity: z.string().min(1),
  action: z.enum(["admit", "deny"]),
  /** The admitter's own identity — must be an admitted human in the room. */
  requesterIdentity: z.string().min(1),
})

/**
 * Admit or deny a waiting participant. Anyone already admitted to the meeting
 * may approve (per current product decision — no host-only gating yet). The
 * requester is verified as a connected non-waiting human in the room; that's
 * spoofable by someone who can enumerate identities, but identities are
 * random and room-scoped.
 */
export async function POST(request: Request, { params }: Params) {
  const { slug } = await params
  if (!isValidRoomSlug(slug)) {
    return NextResponse.json({ error: "invalid room" }, { status: 400 })
  }
  const body = admitSchema.safeParse(await request.json().catch(() => null))
  if (!body.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 })
  }
  const { identity, action, requesterIdentity } = body.data

  const participants = await roomService()
    .listParticipants(slug)
    .catch(() => null)
  if (!participants) {
    return NextResponse.json({ error: "room not found" }, { status: 404 })
  }
  const requester = participants.find((p) => p.identity === requesterIdentity)
  if (
    !requester ||
    parseParticipantMeta(requester.metadata)?.kind !== "human"
  ) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 })
  }
  const target = participants.find((p) => p.identity === identity)
  if (!target || parseParticipantMeta(target.metadata)?.kind !== "waiting") {
    return NextResponse.json({ error: "not waiting" }, { status: 404 })
  }

  if (action === "deny") {
    await roomService()
      .removeParticipant(slug, identity)
      .catch(() => undefined)
    return NextResponse.json({ ok: true })
  }

  const meta: ParticipantMeta = { kind: "human" }
  await roomService().updateParticipant(slug, identity, {
    metadata: JSON.stringify(meta),
    permission: {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canPublishSources: [],
      // Admitted participants can raise their hand / set attributes, matching
      // the grant fresh joiners get in the token route.
      canUpdateMetadata: true,
      hidden: false,
      canSubscribeMetrics: false,
      recorder: false,
      agent: false,
    },
  })
  return NextResponse.json({ ok: true })
}
