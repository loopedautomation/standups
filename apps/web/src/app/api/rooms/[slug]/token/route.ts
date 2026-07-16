import type { ParticipantMeta } from "@meet/shared"
import { tokenRequestSchema } from "@meet/shared"
import { AccessToken } from "livekit-server-sdk"
import { nanoid } from "nanoid"
import { NextResponse } from "next/server"
import { livekitEnv, roomService } from "@/lib/server/livekit"
import { isValidRoomSlug } from "@/lib/server/slug"

type Params = { params: Promise<{ slug: string }> }

export async function POST(request: Request, { params }: Params) {
  const { slug } = await params
  if (!isValidRoomSlug(slug)) {
    return NextResponse.json({ error: "invalid room" }, { status: 400 })
  }

  const body = tokenRequestSchema.safeParse(await request.json())
  if (!body.success) {
    return NextResponse.json({ error: "displayName required" }, { status: 400 })
  }

  // First joiner becomes host (roomAdmin) — enables lock/remove controls.
  let participantCount = 0
  try {
    participantCount = (await roomService().listParticipants(slug)).length
  } catch {
    participantCount = 0
  }
  const isHost = participantCount === 0

  const { apiKey, apiSecret, publicUrl } = livekitEnv()
  const identity = `user-${nanoid(10)}`
  const meta: ParticipantMeta = { kind: "human" }
  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    name: body.data.displayName,
    metadata: JSON.stringify(meta),
    ttl: "2h",
  })
  token.addGrant({
    room: slug,
    roomJoin: true,
    roomCreate: true,
    roomAdmin: isHost,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })

  return NextResponse.json({
    token: await token.toJwt(),
    serverUrl: publicUrl,
    identity,
    participantCount,
  })
}
