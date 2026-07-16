import { customAlphabet } from "nanoid"

// Digits only: e.g. 4821035799.
// 10 digits ≈ 10^10 combinations; rooms are ephemeral (5-min empty timeout),
// so live rooms are effectively unguessable at any realistic scan rate.
const digits = customAlphabet("0123456789", 10)

export function generateRoomSlug(): string {
  return digits()
}

export function isValidRoomSlug(slug: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+){0,3}$/.test(slug) && slug.length <= 64
}
