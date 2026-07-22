import { calcomWebhookSchema, verifyCalcomSignature } from "@meet/shared/calcom"
import { NextResponse } from "next/server"
import { calcomConfig, handleCalcomBooking } from "@/lib/server/calcom"

/**
 * cal.com webhook receiver. Configure a webhook in cal.com (Settings →
 * Developer → Webhooks) pointing at this route with a signing secret matching
 * CALCOM_WEBHOOK_SECRET. On a new or rescheduled booking we mint a stable meet
 * room link and write it back onto the booking; on cancellation we tear the
 * room down. See calcom.md.
 */
export async function POST(request: Request) {
  const cfg = calcomConfig()
  // Unconfigured deployments don't advertise the endpoint at all.
  if (!cfg) return NextResponse.json({ error: "not found" }, { status: 404 })

  // Verify against the exact bytes cal.com signed — before any JSON parse,
  // which would reorder keys and break the HMAC.
  const raw = await request.text()
  const signature = request.headers.get("x-cal-signature-256")
  if (!verifyCalcomSignature(raw, signature, cfg.webhookSecret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 })
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 })
  }
  const parsed = calcomWebhookSchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: "unexpected payload" }, { status: 400 })
  }

  const result = await handleCalcomBooking(cfg, parsed.data, request.url)
  return NextResponse.json({ ok: true, ...result })
}
