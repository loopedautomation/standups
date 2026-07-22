import { createHmac } from "node:crypto"
import { customAlphabet } from "nanoid"

// Digits only: e.g. 4821035799.
// 10 digits ≈ 10^10 combinations; codes are shareable as-is and durable —
// see isRecreatableRoomSlug for why recreation doesn't need a signature.
const digits = customAlphabet("0123456789", 10)

/**
 * The secret that host keys and booking room codes are derived from. Prefers
 * MEET_ROOM_SECRET so it can be rotated independently of the LiveKit key.
 */
export function roomSecret(): string {
  const s = process.env.MEET_ROOM_SECRET ?? process.env.LIVEKIT_API_SECRET
  if (!s) throw new Error("LIVEKIT_API_SECRET is required")
  return s
}

export function generateRoomSlug(): string {
  return digits()
}

/**
 * Whether a missing room may be recreated on demand for this slug (links
 * stay rejoinable after LiveKit's 5-min empty-room garbage collection).
 * Any well-formed meeting code qualifies: a recreated room starts in the
 * not-started state, so without the creator's derived host key nobody can
 * obtain a token for it — a guessed code yields only an empty room that
 * the GC sweeps back up. The management-password creation gate stays intact.
 */
export function isRecreatableRoomSlug(slug: string): boolean {
  return /^\d{10}$/.test(slug)
}

/**
 * The creator's key, derived from the slug rather than stored — so the
 * host-start gate survives room garbage collection and recreation.
 */
export function deriveHostKey(slug: string): string {
  return createHmac("sha256", `${roomSecret()}:host`).update(slug).digest("hex")
}

export function isValidRoomSlug(slug: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+){0,3}$/.test(slug) && slug.length <= 64
}
