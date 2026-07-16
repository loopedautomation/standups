import { customAlphabet } from "nanoid"

// Digits only, grouped for readability: e.g. 4821-0357-9964-1102.
// 16 digits ≈ 10^16 combinations — unguessable at any realistic rate.
const digits = customAlphabet("0123456789", 4)

export function generateRoomSlug(): string {
  return `${digits()}-${digits()}-${digits()}-${digits()}`
}

export function isValidRoomSlug(slug: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+){1,3}$/.test(slug) && slug.length <= 64
}
