import type { ParticipantMeta } from "@meet/shared"
import { parseParticipantMeta, tokenRequestSchema } from "@meet/shared"
import { AccessToken, TokenVerifier } from "livekit-server-sdk"
import { nanoid } from "nanoid"
import { NextResponse } from "next/server"
import { livekitEnv, roomService } from "@/lib/server/livekit"
import {
  deriveHostKey,
  isRecreatableRoomSlug,
  isValidRoomSlug,
} from "@/lib/server/slug"

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

  // Meeting codes are durable: LiveKit garbage-collects empty rooms after a
  // few minutes, so a link recreates its room on demand — in the not-started
  // state, where only the creator's derived host key opens it. A guessed
  // code therefore yields nothing but an empty room the GC sweeps back up.
  let existing = await roomService()
    .listRooms([slug])
    .catch(() => [])
  if (existing.length === 0) {
    if (!isRecreatableRoomSlug(slug)) {
      return NextResponse.json(
        { error: "meeting not found or has ended" },
        { status: 404 },
      )
    }
    const recreated = await roomService()
      .createRoom({
        name: slug,
        emptyTimeout: 300,
        departureTimeout: 60,
        metadata: JSON.stringify({
          hostKey: deriveHostKey(slug),
          started: false,
        }),
      })
      .catch(() => null)
    if (!recreated) {
      return NextResponse.json(
        { error: "meeting not found or has ended" },
        { status: 404 },
      )
    }
    existing = [recreated]
  }

  // The meeting starts when its creator arrives. Room metadata carries the
  // hostKey minted at creation plus a started flag; only a request presenting
  // the key flips it. Everyone earlier gets 425 and the client polls.
  // (Rooms without metadata predate this gate — treat them as started.)
  const room = existing[0]
  let roomMeta: { hostKey?: string; started?: boolean; startedAt?: number } = {}
  try {
    roomMeta = JSON.parse(room.metadata || "{}")
  } catch {}
  const isCreator = !!roomMeta.hostKey && body.data.hostKey === roomMeta.hostKey
  const started = roomMeta.started !== false
  if (!started && !isCreator) {
    return NextResponse.json({ notStarted: true }, { status: 425 })
  }
  if (!started && isCreator) {
    // Stamp the start moment: the call timer anchors here, so a meeting
    // that reconvenes in a reused (not yet GC'd) room starts from 0:00
    // instead of inheriting the room's creation time.
    roomMeta = { ...roomMeta, started: true, startedAt: Date.now() }
    await roomService()
      .updateRoomMetadata(slug, JSON.stringify(roomMeta))
      .catch(() => undefined)
  }

  // Waiting room: the creator (or, in legacy/open rooms, the first human
  // into an empty room) enters directly; everyone after knocks — they join
  // with a restricted token (no publish/subscribe/data) and "waiting"
  // metadata until someone inside admits them (see ../admit/route.ts).
  // Only humans count: a lingering transcriber or agent must never claim
  // host, and joining "alone with the transcriber" should still unmute.
  let participantCount = 0
  try {
    participantCount = (await roomService().listParticipants(slug)).filter(
      (p) => parseParticipantMeta(p.metadata)?.kind === "human",
    ).length
  } catch {
    participantCount = 0
  }
  const isHost = isCreator || participantCount === 0
  let waiting = !isHost

  const { apiKey, apiSecret, publicUrl } = livekitEnv()

  // A refresh presents its previous token as proof of admission: accept it
  // if it verifies for this room with admitted (human) metadata, or — for a
  // knocker upgrading their proof right after admission — if its identity is
  // currently connected with human metadata.
  if (waiting && body.data.rejoinToken) {
    try {
      const claims = await new TokenVerifier(apiKey, apiSecret).verify(
        body.data.rejoinToken,
      )
      if (claims.video?.room === slug) {
        const kind = parseParticipantMeta(claims.metadata)?.kind
        if (kind === "human") {
          waiting = false
        } else if (kind === "waiting") {
          const sub = JSON.parse(
            Buffer.from(
              body.data.rejoinToken.split(".")[1] ?? "",
              "base64url",
            ).toString(),
          ).sub as string | undefined
          const live = sub
            ? (
                await roomService()
                  .listParticipants(slug)
                  .catch(() => [])
              ).find((p) => p.identity === sub)
            : undefined
          if (live && parseParticipantMeta(live.metadata)?.kind === "human") {
            waiting = false
          }
        }
      }
    } catch {
      // invalid/expired proof — knock like anyone else
    }
  }
  // A fresh occurrence: the first human entering (not knocking) resets the
  // call timer — covers both a first start and a meeting reconvening in a
  // room the GC hadn't swept yet.
  if (!waiting && participantCount === 0) {
    roomMeta = { ...roomMeta, startedAt: Date.now() }
    await roomService()
      .updateRoomMetadata(slug, JSON.stringify(roomMeta))
      .catch(() => undefined)
  }

  const identity = `user-${nanoid(10)}`
  const meta: ParticipantMeta = { kind: waiting ? "waiting" : "human" }
  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    name: body.data.displayName,
    metadata: JSON.stringify(meta),
    ttl: "2h",
  })
  token.addGrant({
    room: slug,
    roomJoin: true,
    // Never roomCreate: meeting creation is gated by the management
    // password; a join token must not be able to resurrect an ended room.
    roomCreate: false,
    roomAdmin: isHost,
    canPublish: !waiting,
    canSubscribe: !waiting,
    canPublishData: !waiting,
    // Lets the participant set their own attributes (e.g. raise hand, away)
    // and update their own metadata via setAttributes/setMetadata.
    canUpdateOwnMetadata: !waiting,
  })

  // Prefer the stamped start moment; rooms predating it (or open
  // deployments without the host gate) fall back to room creation time.
  const roomStartedAt =
    roomMeta.startedAt ??
    (Number(room.creationTimeMs ?? 0) || Number(room.creationTime ?? 0) * 1000)

  return NextResponse.json({
    token: await token.toJwt(),
    serverUrl: publicUrl,
    identity,
    participantCount,
    waiting,
    // Only the creator organises the meeting's agents. In open deployments
    // (no host gate) the first human in acts as host, as before.
    isHost: isCreator || (!roomMeta.hostKey && isHost),
    roomStartedAt,
  })
}
