import { canvasSnapshotSchema } from "@meet/shared"
import { NextResponse } from "next/server"
import { bridgeFetch } from "@/lib/server/bridge"
import { isKicked } from "@/lib/server/kicked"
import {
  type VerifiedParticipant,
  verifyParticipant,
} from "@/lib/server/participantAuth"
import { isValidRoomSlug } from "@/lib/server/slug"

type Params = { params: Promise<{ slug: string }> }

/**
 * Only an admitted member of this meeting may touch its whiteboard — proven
 * by the caller's own LiveKit token, not by knowing the slug.
 */
async function authorize(
  request: Request,
  slug: string,
): Promise<VerifiedParticipant | null> {
  const participant = await verifyParticipant(request, slug)
  if (!participant || participant.kind !== "human") return null
  if (isKicked(slug, participant.identity)) return null
  return participant
}

/**
 * The meeting's shared whiteboard, proxied to the bridge's store.
 *
 * Live drawing goes over the data channel — this is the durable copy that a
 * refresh or a late joiner reads, and the debounced snapshot editors PUT.
 */
export async function GET(request: Request, { params }: Params) {
  const { slug } = await params
  if (!isValidRoomSlug(slug)) {
    return NextResponse.json({ error: "invalid room" }, { status: 400 })
  }
  if (!(await authorize(request, slug))) {
    return NextResponse.json({ error: "not authorized" }, { status: 401 })
  }
  try {
    const res = await bridgeFetch(`/rooms/${slug}/canvas`)
    return NextResponse.json(await res.json(), { status: res.status })
  } catch {
    return NextResponse.json({ error: "bridge unavailable" }, { status: 502 })
  }
}

export async function PUT(request: Request, { params }: Params) {
  const { slug } = await params
  if (!isValidRoomSlug(slug)) {
    return NextResponse.json({ error: "invalid room" }, { status: 400 })
  }
  if (!(await authorize(request, slug))) {
    return NextResponse.json({ error: "not authorized" }, { status: 401 })
  }
  const body = canvasSnapshotSchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!body.success) {
    return NextResponse.json({ error: "invalid canvas" }, { status: 400 })
  }
  try {
    const res = await bridgeFetch(`/rooms/${slug}/canvas`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.data),
    })
    return NextResponse.json(await res.json(), { status: res.status })
  } catch {
    return NextResponse.json({ error: "bridge unavailable" }, { status: 502 })
  }
}
