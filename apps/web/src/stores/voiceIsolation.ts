import { atom } from "nanostores"
import {
  readVoiceIsolationPref,
  writeVoiceIsolationPref,
} from "@/hooks/useVoiceIsolation"

// Shared voice-isolation preference: on by default, toggled from the settings
// panel (and the mic device menu), applied by the single useVoiceIsolation
// mount in ControlBar.
export const $voiceIsolation = atom<boolean>(readVoiceIsolationPref())

export function setVoiceIsolation(enabled: boolean) {
  $voiceIsolation.set(enabled)
  writeVoiceIsolationPref(enabled)
}
