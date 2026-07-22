import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  bookingRoomSlug,
  calcomWebhookSchema,
  verifyCalcomSignature,
} from "./calcom.js"

const SECRET = "whsec_test_secret"

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex")
}

describe("verifyCalcomSignature", () => {
  const body = JSON.stringify({ triggerEvent: "BOOKING_CREATED" })

  it("accepts a signature computed over the exact body", () => {
    expect(verifyCalcomSignature(body, sign(body), SECRET)).toBe(true)
  })

  it("rejects a signature made with the wrong secret", () => {
    expect(verifyCalcomSignature(body, sign(body, "other"), SECRET)).toBe(false)
  })

  it("rejects when the body was tampered with after signing", () => {
    const sig = sign(body)
    expect(verifyCalcomSignature(`${body} `, sig, SECRET)).toBe(false)
  })

  it("rejects a missing or empty signature", () => {
    expect(verifyCalcomSignature(body, null, SECRET)).toBe(false)
    expect(verifyCalcomSignature(body, "", SECRET)).toBe(false)
  })

  it("rejects a malformed signature without throwing on length mismatch", () => {
    expect(verifyCalcomSignature(body, "deadbeef", SECRET)).toBe(false)
  })
})

describe("bookingRoomSlug", () => {
  it("is a 10-digit recreatable slug", () => {
    expect(bookingRoomSlug("abc-123", SECRET)).toMatch(/^\d{10}$/)
  })

  it("is deterministic for the same uid and secret", () => {
    expect(bookingRoomSlug("booking-xyz", SECRET)).toBe(
      bookingRoomSlug("booking-xyz", SECRET),
    )
  })

  it("differs across bookings and across secrets", () => {
    expect(bookingRoomSlug("a", SECRET)).not.toBe(bookingRoomSlug("b", SECRET))
    expect(bookingRoomSlug("a", SECRET)).not.toBe(bookingRoomSlug("a", "other"))
  })

  it("pads short numeric results to a full 10 digits", () => {
    // Whatever uid we throw at it, the output is always exactly 10 chars.
    for (const uid of ["", "1", "long-booking-uid-0000", "🙂"]) {
      expect(bookingRoomSlug(uid, SECRET)).toHaveLength(10)
    }
  })
})

describe("calcomWebhookSchema", () => {
  it("parses a BOOKING_CREATED payload and keeps the booking uid", () => {
    const parsed = calcomWebhookSchema.parse({
      triggerEvent: "BOOKING_CREATED",
      createdAt: "2024-01-01T00:00:00.000Z",
      payload: {
        uid: "unique-booking-id",
        title: "Strategy Session",
        startTime: "2024-01-01T10:00:00Z",
        endTime: "2024-01-01T10:15:00Z",
        attendees: [{ email: "guest@example.com", name: "Guest" }],
      },
    })
    expect(parsed.payload.uid).toBe("unique-booking-id")
    // Unknown fields survive rather than being stripped.
    expect((parsed.payload as { attendees?: unknown }).attendees).toBeDefined()
  })

  it("tolerates a trigger without a booking uid", () => {
    const parsed = calcomWebhookSchema.safeParse({
      triggerEvent: "FORM_SUBMITTED",
      payload: {},
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects a body missing triggerEvent", () => {
    expect(calcomWebhookSchema.safeParse({ payload: {} }).success).toBe(false)
  })
})
