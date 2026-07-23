import { docSnapshotPutSchema } from "@meet/shared"
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
 * Only an admitted member of this meeting may touch its document — proven
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
 * The meeting's shared markdown document, proxied to the bridge's store.
 *
 * Live editing goes over the data channel — this is the durable copy that a
 * refresh or a late joiner reads, and the one the agent writes into.
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
    const res = await bridgeFetch(`/rooms/${slug}/doc`)
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
  const participant = await authorize(request, slug)
  if (!participant) {
    return NextResponse.json({ error: "not authorized" }, { status: 401 })
  }
  const body = docSnapshotPutSchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!body.success) {
    return NextResponse.json({ error: "invalid doc update" }, { status: 400 })
  }
  // Attribution lives inside the CRDT's metadata and is display-only; what
  // matters here is that only a verified member can write at all (above).
  try {
    const res = await bridgeFetch(`/rooms/${slug}/doc`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.data),
    })
    return NextResponse.json(await res.json(), { status: res.status })
  } catch {
    return NextResponse.json({ error: "bridge unavailable" }, { status: 502 })
  }
}
