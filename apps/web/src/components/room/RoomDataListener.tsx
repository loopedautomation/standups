"use client"

import { useDataChannel } from "@livekit/components-react"
import {
  agentActivityEventSchema,
  chatMessageSchema,
  DataTopic,
  sharedDocSchema,
} from "@meet/shared"
import { useEffect } from "react"
import { applyDocUpdate, resetDoc } from "@/stores/doc"
import {
  addAgentActivity,
  addChatMessage,
  resetRoomData,
} from "@/stores/roomData"

/** Always-mounted subscriber: chat and agent activity survive panel toggling. */
export function RoomDataListener({ slug }: { slug: string }) {
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

  useDataChannel(DataTopic.Doc, (msg) => {
    try {
      const parsed = sharedDocSchema.safeParse(
        JSON.parse(new TextDecoder().decode(msg.payload)),
      )
      if (parsed.success) applyDocUpdate(parsed.data)
    } catch {}
  })

  // Data messages only reach people already in the room, so the document has
  // to be fetched once on arrival — otherwise everyone who joins after the
  // first line was written sees a blank page until somebody types.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/rooms/${slug}/doc`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body) return
        const parsed = sharedDocSchema.safeParse(body.doc)
        if (parsed.success) applyDocUpdate(parsed.data)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [slug])

  useEffect(
    () => () => {
      resetRoomData()
      resetDoc()
    },
    [],
  )

  return null
}
