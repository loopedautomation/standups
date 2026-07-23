import { bookingRoomSlug } from "@meet/shared/calcom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The room service is only used on cancel/reject here; stub it so the module
// imports without a live LiveKit.
vi.mock("@/lib/server/livekit", () => ({
  roomService: () => ({ deleteRoom: vi.fn().mockResolvedValue(undefined) }),
}))

const { handleCalcomBooking } = await import("./calcom")
const { deriveHostKey } = await import("./slug")

const SECRET = "meet-room-secretmeet-room-secretmeet"

beforeEach(() => {
  process.env.MEET_ROOM_SECRET = SECRET
  // Capture the writeback call without hitting the network.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, text: async () => "" }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const cfg = {
  webhookSecret: "whsec",
  apiKey: "cal_live_key",
  apiBase: "https://api.cal.com",
}

function booking(uid: string, triggerEvent = "BOOKING_CREATED") {
  return {
    triggerEvent,
    payload: { uid },
  } as Parameters<typeof handleCalcomBooking>[1]
}

describe("handleCalcomBooking — booking links carry no secrets", () => {
  it("writes back a plain link: the booking goes to every attendee, so a host key here handed host powers to the whole invite list", async () => {
    const uid = "booking-abc"
    const result = await handleCalcomBooking(
      cfg,
      booking(uid),
      "https://meet.example.com/api/integrations/cal",
    )
    expect(result.action).toBe("provisioned")
    if (result.action !== "provisioned") return

    const slug = bookingRoomSlug(uid, SECRET)
    expect(result.url).toContain(`/${slug}`)
    const url = new URL(result.url)
    expect(url.hash).toBe("")
    expect(url.search).toBe("")
    // Sanity: the derived key never appears anywhere in the link.
    expect(result.url).not.toContain(deriveHostKey(slug))
  })

  it("derives the same slug (and key) for redelivered bookings — idempotent", async () => {
    const a = await handleCalcomBooking(cfg, booking("same-uid"), "https://m/x")
    const b = await handleCalcomBooking(cfg, booking("same-uid"), "https://m/x")
    if (a.action !== "provisioned" || b.action !== "provisioned") {
      throw new Error("expected provisioned")
    }
    expect(a.url).toBe(b.url)
  })

  it("ignores a booking with no uid", async () => {
    const result = await handleCalcomBooking(
      cfg,
      { triggerEvent: "BOOKING_CREATED", payload: {} } as Parameters<
        typeof handleCalcomBooking
      >[1],
      "https://m/x",
    )
    expect(result.action).toBe("ignored")
  })
})
