import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"

/**
 * cal.com → meet integration primitives.
 *
 * This module is deliberately NOT re-exported from the package barrel
 * (`@meet/shared`): it imports `node:crypto`, and pulling that into the barrel
 * would drag it into browser bundles that import anything from shared. Server
 * code imports it directly via the `@meet/shared/calcom` subpath instead.
 */

/** cal.com webhook trigger events this integration acts on. */
export const CalcomTrigger = {
  BookingCreated: "BOOKING_CREATED",
  BookingRescheduled: "BOOKING_RESCHEDULED",
  BookingCancelled: "BOOKING_CANCELLED",
  BookingRejected: "BOOKING_REJECTED",
} as const

/**
 * The slice of a cal.com webhook we rely on. cal.com sends far more than this;
 * `.passthrough()` keeps the rest rather than stripping it, so logging or
 * future fields stay available. `payload.uid` is the booking id we key the
 * room off — optional because non-booking triggers omit it, and we ignore
 * those.
 */
export const calcomWebhookSchema = z.object({
  triggerEvent: z.string(),
  createdAt: z.string().optional(),
  payload: z
    .object({
      uid: z.string().optional(),
      title: z.string().optional(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
    })
    .passthrough(),
})

export type CalcomWebhook = z.infer<typeof calcomWebhookSchema>

/**
 * Verify cal.com's `x-cal-signature-256` header: HMAC-SHA256 of the raw
 * request body, keyed by the webhook's secret, hex-encoded. Compared in
 * constant time so a mismatch leaks nothing about how far it matched.
 *
 * The body MUST be the exact bytes cal.com sent — verify before any
 * JSON round-trip, which would reorder keys and change the hash.
 */
export function verifyCalcomSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature) return false
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * A stable meeting code for a cal.com booking: HMAC of the booking uid folded
 * into a 10-digit number. Deterministic, so webhook redeliveries and the two
 * halves of a reschedule map to the same room; 10 digits so it satisfies
 * meet's recreatable-slug rule and the link survives room garbage collection
 * until the meeting actually happens. Derived from the same room secret as
 * host keys rather than the webhook secret, so rotating the webhook secret
 * doesn't move every scheduled room.
 */
export function bookingRoomSlug(bookingUid: string, secret: string): string {
  const digest = createHmac("sha256", `${secret}:calcom`)
    .update(bookingUid)
    .digest()
  const n = digest.readBigUInt64BE(0) % 10_000_000_000n
  return n.toString().padStart(10, "0")
}
