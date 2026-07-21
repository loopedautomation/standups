import { sharedDocSchema } from "@meet/shared"
import { NextResponse } from "next/server"
import { bridgeFetch } from "@/lib/server/bridge"
import { isValidRoomSlug } from "@/lib/server/slug"

type Params = { params: Promise<{ slug: string }> }

/**
 * The meeting's shared markdown document, proxied to the bridge's store.
 *
 * Live editing goes over the data channel — this is the durable copy that a
 * refresh or a late joiner reads, and the one the agent writes into.
 */
export async function GET(_request: Request, { params }: Params) {
  const { slug } = await params
  if (!isValidRoomSlug(slug)) {
    return NextResponse.json({ error: "invalid room" }, { status: 400 })
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
  const body = sharedDocSchema.safeParse(await request.json().catch(() => null))
  if (!body.success) {
    return NextResponse.json({ error: "invalid doc" }, { status: 400 })
  }
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
