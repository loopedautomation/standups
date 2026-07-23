import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { deriveHostKey, isValidRoomSlug } from "@/lib/server/slug"

type Params = { params: Promise<{ slug: string }> }

/**
 * Exchange the deployment's management password for a room's host key.
 *
 * This is how a meeting with no creator browser gets a host: booked rooms
 * (cal.com writes plain links — no secrets in calendar invites), a host on
 * a new device, or a colleague taking over after the organiser left. The
 * password crosses the wire once; what the browser keeps is the per-room
 * key every host-gated route already understands, so a leaked browser
 * credential compromises one room, not the deployment.
 *
 * With no management password configured the deployment is open — room
 * creation is ungated — so host status is handed out on request for
 * consistency.
 */
export async function POST(request: Request, { params }: Params) {
  const { slug } = await params
  if (!isValidRoomSlug(slug)) {
    return NextResponse.json({ error: "invalid room" }, { status: 400 })
  }
  const required = process.env.MEET_MANAGEMENT_PASSWORD
  if (required) {
    const body = (await request.json().catch(() => null)) as {
      password?: unknown
    } | null
    const given = typeof body?.password === "string" ? body.password : ""
    const a = Buffer.from(given)
    const b = Buffer.from(required)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return NextResponse.json({ error: "wrong password" }, { status: 401 })
    }
  }
  return NextResponse.json({ hostKey: deriveHostKey(slug) })
}
