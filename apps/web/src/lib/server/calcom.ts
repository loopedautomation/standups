import {
  bookingRoomSlug,
  CalcomTrigger,
  type CalcomWebhook,
} from "@meet/shared/calcom"
import { roomService } from "@/lib/server/livekit"
import { roomShareUrl } from "@/lib/server/roomUrl"
import { roomSecret } from "@/lib/server/slug"

/** The cal.com API version the booking-location endpoint requires. */
const CAL_API_VERSION = "2024-08-13"

export type CalcomConfig = {
  webhookSecret: string
  /** Optional: without it the link can't be written back to the booking. */
  apiKey: string | undefined
  /** API base — cloud is https://api.cal.com; self-hosted is your API host. */
  apiBase: string
}

/**
 * The integration is enabled only when a webhook secret is set — that secret
 * is what authenticates cal.com's deliveries, so without it there is nothing
 * to safely receive. Returns null when disabled.
 */
export function calcomConfig(): CalcomConfig | null {
  const webhookSecret = process.env.CALCOM_WEBHOOK_SECRET
  if (!webhookSecret) return null
  return {
    webhookSecret,
    apiKey: process.env.CALCOM_API_KEY || undefined,
    apiBase: (process.env.CALCOM_API_BASE ?? "https://api.cal.com").replace(
      /\/$/,
      "",
    ),
  }
}

export type CalcomResult =
  | { action: "ignored"; reason: string }
  | { action: "provisioned"; slug: string; url: string; wroteBack: boolean }
  | { action: "removed"; slug: string }

/**
 * Turn a verified cal.com webhook into a meet room outcome:
 *  - a new or rescheduled booking gets a stable room link written back onto the
 *    booking (so it lands in cal.com's confirmation email and calendar);
 *  - a cancelled or rejected booking has its room torn down.
 * Everything else is ignored. Idempotent: the slug is derived from the booking
 * uid, so redeliveries converge on the same room rather than piling up.
 */
export async function handleCalcomBooking(
  cfg: CalcomConfig,
  hook: CalcomWebhook,
  requestUrl: string,
): Promise<CalcomResult> {
  const uid = hook.payload.uid
  if (!uid) {
    return {
      action: "ignored",
      reason: `no booking uid (${hook.triggerEvent})`,
    }
  }
  const slug = bookingRoomSlug(uid, roomSecret())

  switch (hook.triggerEvent) {
    case CalcomTrigger.BookingCreated:
    case CalcomTrigger.BookingRescheduled: {
      // The slug is recreatable, so the room materialises on first join via
      // the token route — no need to pre-create one that would only be
      // garbage-collected before the meeting.
      //
      // A PLAIN link, deliberately: the booking location goes to every
      // attendee, and a link that carried the host key handed host powers
      // to the whole invite list. The host starts the meeting by entering
      // the management password on the "hasn't started yet" screen, which
      // exchanges it for this room's key.
      const url = roomShareUrl(slug, requestUrl)
      const wroteBack = await writeBackMeetingLink(cfg, uid, url)
      return { action: "provisioned", slug, url, wroteBack }
    }
    case CalcomTrigger.BookingCancelled:
    case CalcomTrigger.BookingRejected: {
      // Best-effort: usually there's no live room (it's a future booking), but
      // an imminent/instant meeting may have one — sweep it so it can't linger.
      await roomService()
        .deleteRoom(slug)
        .catch(() => undefined)
      return { action: "removed", slug }
    }
    default:
      return { action: "ignored", reason: hook.triggerEvent }
  }
}

/**
 * Set the booking's location to the meet link via
 * `PATCH /v2/bookings/{uid}/location`. cal.com updates the calendar event and
 * notifies attendees. Best-effort: a failure is logged and surfaced to the
 * caller but never throws — the room link itself is already valid, and cal.com
 * retries the webhook on a non-2xx response, which would re-notify attendees.
 */
async function writeBackMeetingLink(
  cfg: CalcomConfig,
  bookingUid: string,
  url: string,
): Promise<boolean> {
  if (!cfg.apiKey) {
    console.warn(
      "[calcom] CALCOM_API_KEY unset — booked %s but can't set the link on the booking",
      bookingUid,
    )
    return false
  }
  try {
    const res = await fetch(
      `${cfg.apiBase}/v2/bookings/${encodeURIComponent(bookingUid)}/location`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${cfg.apiKey}`,
          "cal-api-version": CAL_API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({ location: { type: "link", link: url } }),
      },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      console.error(
        "[calcom] setting booking %s location failed: %d %s",
        bookingUid,
        res.status,
        body.slice(0, 500),
      )
      return false
    }
    return true
  } catch (err) {
    console.error(
      "[calcom] error setting booking %s location:",
      bookingUid,
      err,
    )
    return false
  }
}
