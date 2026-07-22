import { atom } from "nanostores"

const KEY = "incomingVideoOff"

/**
 * When true, remote camera tracks are unsubscribed entirely — the server
 * stops sending their video, which is the real bandwidth saving (hiding the
 * element alone wouldn't). Screenshares stay subscribed: they're usually
 * the reason you're in the meeting.
 */
export const $incomingVideoOff = atom<boolean>(
  typeof window !== "undefined" && localStorage.getItem(KEY) === "1",
)

export function setIncomingVideoOff(off: boolean) {
  $incomingVideoOff.set(off)
  try {
    localStorage.setItem(KEY, off ? "1" : "")
  } catch {}
}
