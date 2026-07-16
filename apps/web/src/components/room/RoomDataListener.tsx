"use client"

import { useDataChannel } from "@livekit/components-react"
import {
  agentActivityEventSchema,
  chatMessageSchema,
  DataTopic,
} from "@meet/shared"
import { useEffect } from "react"
import {
  addAgentActivity,
  addChatMessage,
  resetRoomData,
} from "@/stores/roomData"

/** Always-mounted subscriber: chat and agent activity survive panel toggling. */
export function RoomDataListener() {
  useDataChannel(DataTopic.Chat, (msg) => {
    try {
      const parsed = chatMessageSchema.safeParse(
        JSON.parse(new TextDecoder().decode(msg.payload)),
      )
      if (parsed.success) addChatMessage(parsed.data)
    } catch {}
  })

  useDataChannel(DataTopic.AgentActivity, (msg) => {
    try {
      const parsed = agentActivityEventSchema.safeParse(
        JSON.parse(new TextDecoder().decode(msg.payload)),
      )
      if (parsed.success) addAgentActivity(parsed.data)
    } catch {}
  })

  useEffect(() => resetRoomData, [])

  return null
}
