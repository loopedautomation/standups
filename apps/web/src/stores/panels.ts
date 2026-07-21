import { atom } from "nanostores"

export type Panel =
  | "agents"
  | "doc"
  | "transcript"
  | "chat"
  | "participants"
  | "settings"
  | null

export const $openPanel = atom<Panel>(null)

export function togglePanel(panel: Exclude<Panel, null>) {
  $openPanel.set($openPanel.get() === panel ? null : panel)
}
