import { ReadableStream } from "node:stream/web"
import { type ChatContext, type llm, voice } from "@livekit/agents"
import {
  type AgentActivityEvent,
  type AgentState,
  spokenMentionRegExp,
  type TurnPolicy,
} from "@meet/shared"
import { CanvasBlockExtractor } from "./canvas-blocks.js"
import { DocBlockExtractor } from "./doc-blocks.js"
import type { TtyServerFrame } from "./looped-tty.js"
import type { Brain } from "./looped-webhook.js"
import type { AgentEntry } from "./registry.js"
import { attachScreenFrame, type ScreenCapture } from "./screen-capture.js"

export type BridgeCallbacks = {
  publishActivity: (event: AgentActivityEvent) => void
  publishChat: (text: string) => void
  setState: (state: AgentState) => void
  /**
   * Persist the shared document and broadcast it to the room. Present on the
   * pipeline path, where the brain writes the doc via marker blocks in its
   * replies (see doc-blocks.ts); the realtime path has its own doc tools.
   */
  writeDoc?: (text: string) => Promise<string>
  /**
   * Draw on the shared whiteboard from a raw canvas marker block (see
   * canvas-blocks.ts). Takes the unparsed block so validation errors flow
   * back through the same outcome channel as successful draws; the realtime
   * path has its own draw_on_canvas tool instead.
   */
  drawCanvas?: (block: string) => Promise<string>
}

/** Mutable per-session flags shared between the voice agent and the job. */
export class SessionState {
  muted = false
  /** Tracks whether the brain has been told about the current mute state. */
  notifiedMuted = false
  /** Deafened: audio input is disabled entirely; only chat mentions get through. */
  deafened = false
  /** Set when undeafened so the brain learns it missed part of the meeting. */
  notifyUndeafened = false
  /** on-mention policy: a participant called on the agent; answer next turn. */
  callOnPending = false
  /** Zapped: the agent responds freely until this epoch-ms deadline. */
  zappedUntil = 0
  /**
   * Effective turn policy: seeded from the registry, but the meeting's host
   * can change it mid-call (see the "set-turn-policy" control).
   */
  turnPolicy: TurnPolicy = "open"
}

/** Room facts fed to the brain alongside each turn. */
export type MeetingContext = {
  /** Current visible participants, re-read every turn. */
  roster: () => string
}

const instructions = (entry: AgentEntry) =>
  `You are ${entry.name}, an AI agent participating in a live voice meeting. ` +
  "Utterances arrive as '<Speaker>: <text>'. Keep spoken replies concise and conversational."

/**
 * A LiveKit voice agent whose "LLM" is a looped-af agent reached over its
 * TTY WebSocket. STT/TTS/VAD/turn-taking run in this process; thinking
 * happens in the looped agent, and its tool activity is re-published to the
 * room so the UI can render a live activity feed.
 */
export class LoopedVoiceAgent extends voice.Agent {
  #entry: AgentEntry
  #brain: Brain
  #callbacks: BridgeCallbacks
  #state: SessionState
  #screen: ScreenCapture | null
  #meeting: MeetingContext | null
  #lastRoster = ""

  constructor(
    entry: AgentEntry,
    brain: Brain,
    state: SessionState,
    callbacks: BridgeCallbacks,
    screen: ScreenCapture | null = null,
    meeting: MeetingContext | null = null,
  ) {
    super({ instructions: instructions(entry) })
    this.#entry = entry
    this.#brain = brain
    this.#state = state
    this.#callbacks = callbacks
    this.#screen = screen
    this.#meeting = meeting
  }

  override async llmNode(
    chatCtx: ChatContext,
    _toolCtx: llm.ToolContext,
    _modelSettings: voice.ModelSettings,
  ): Promise<ReadableStream<string> | null> {
    const input = latestUserInput(chatCtx)
    if (!input) return null

    const entry = this.#entry
    const state = this.#state
    const callbacks = this.#callbacks
    const brain = this.#brain

    // Gated turn policies: stay quiet unless addressed by name or a
    // participant called on the agent. "raise-hand" additionally raises a
    // hand so a host can call on it; "on-mention" stays silent.
    let calledOn = false
    if (state.turnPolicy !== "open") {
      const zapped = Date.now() < state.zappedUntil
      const mentioned = spokenMentionRegExp(entry.name).test(input)
      // "raise-hand" is strict: even a name mention only raises the hand —
      // the floor is granted exclusively by call-on (zap still bypasses,
      // it's an explicit host action).
      const addressed =
        state.turnPolicy === "raise-hand" ? zapped : mentioned || zapped
      if (!addressed && !state.callOnPending) {
        if (
          state.turnPolicy === "raise-hand" &&
          !state.muted &&
          !state.deafened
        ) {
          callbacks.setState("hand-raised")
        }
        return null
      }
      calledOn = state.callOnPending
      state.callOnPending = false
      callbacks.setState(state.muted ? "muted" : "thinking")
    }

    let text = input
    if (calledOn) {
      text =
        "[You raised your hand and have now been called on — give the " +
        "answer you were holding, briefly, then yield the floor.]\n" +
        text
    }
    if (this.#meeting) {
      const roster = this.#meeting.roster()
      if (roster && roster !== this.#lastRoster) {
        this.#lastRoster = roster
        text = `[Participants currently in the meeting: ${roster}]\n${text}`
      }
    }
    if (state.notifyUndeafened) {
      text = `[You were deafened for a while and missed part of the meeting; you can hear again now.]\n${text}`
      state.notifyUndeafened = false
    }
    if (state.muted && !state.notifiedMuted) {
      text = `[You have been muted by a participant. You are still heard in the meeting but cannot speak; your replies will appear in the meeting chat instead. Keep them brief.]\n${text}`
      state.notifiedMuted = true
    } else if (!state.muted && state.notifiedMuted) {
      text = `[You have been unmuted and can speak again.]\n${text}`
      state.notifiedMuted = false
    }

    // A live screenshare rides along as a frame, so the agent can see it.
    const attached = await attachScreenFrame(this.#screen, text)

    // Doc and canvas writes ride inside the reply as marker blocks (see
    // doc-blocks.ts / canvas-blocks.ts): lifted out here so they get acted
    // on instead of spoken. Extraction state lives per turn — a block left
    // open by a barge-in dies with the stream.
    const docBlocks = callbacks.writeDoc ? new DocBlockExtractor() : null
    const canvasBlocks = callbacks.drawCanvas
      ? new CanvasBlockExtractor()
      : null
    const saveDoc = (text: string) => {
      const startedAt = Date.now()
      callbacks.publishActivity({
        type: "tool_call",
        agentId: entry.id,
        name: "update_shared_doc",
        arguments: "",
        at: startedAt,
      })
      void callbacks
        .writeDoc?.(text)
        .catch(() => "The document couldn't be saved.")
        .then((outcome) => {
          callbacks.publishActivity({
            type: "tool_result",
            agentId: entry.id,
            name: "update_shared_doc",
            content: outcome ?? "",
            durationMs: Date.now() - startedAt,
            at: Date.now(),
          })
        })
    }
    const drawBlock = (block: string) => {
      const startedAt = Date.now()
      callbacks.publishActivity({
        type: "tool_call",
        agentId: entry.id,
        name: "draw_on_canvas",
        arguments: "",
        at: startedAt,
      })
      void callbacks
        .drawCanvas?.(block)
        .catch(() => "The drawing couldn't be saved.")
        .then((content) => {
          callbacks.publishActivity({
            type: "tool_result",
            agentId: entry.id,
            name: "draw_on_canvas",
            content: content ?? "",
            durationMs: Date.now() - startedAt,
            at: Date.now(),
          })
        })
    }

    const iterator = brain.runTurn(attached.text, attached.images)
    return new ReadableStream<string>({
      async pull(controller) {
        try {
          const { value: frame, done } = await iterator.next()
          if (done) {
            controller.close()
            return
          }
          handleFrame(frame)
        } catch (err) {
          callbacks.setState(state.muted ? "muted" : "listening")
          controller.error(err)
        }

        /** Route reply text: lift marker blocks out, speak (or chat) the rest. */
        function speakOrSave(raw: string) {
          let content = raw
          if (docBlocks) {
            const { spoken, blocks } = docBlocks.feed(content)
            for (const doc of blocks) saveDoc(doc)
            content = spoken
          }
          if (canvasBlocks) {
            const { spoken, blocks } = canvasBlocks.feed(content)
            for (const block of blocks) drawBlock(block)
            content = spoken
          }
          if (!content.trim()) return
          if (state.muted) {
            callbacks.publishChat(content)
          } else {
            controller.enqueue(content)
          }
        }

        function handleFrame(frame: TtyServerFrame) {
          const at = Date.now()
          switch (frame.type) {
            case "step":
              callbacks.publishActivity({
                type: "step",
                agentId: entry.id,
                n: frame.n,
                at,
              })
              break
            case "tool_call":
              callbacks.setState(state.muted ? "muted" : "thinking")
              callbacks.publishActivity({
                type: "tool_call",
                agentId: entry.id,
                name: frame.name,
                arguments: frame.arguments,
                at,
              })
              break
            case "tool_result":
              callbacks.publishActivity({
                type: "tool_result",
                agentId: entry.id,
                name: frame.name,
                content: frame.content.slice(0, 8000),
                durationMs: frame.durationMs,
                at,
              })
              break
            case "assistant":
              speakOrSave(frame.content)
              break
            case "result":
              controller.close()
              break
            case "error":
              controller.error(new Error(frame.error))
              break
            default:
              break
          }
        }
      },
      async cancel() {
        // Barge-in: drain the generator so the client frees its turn slot.
        await iterator.return(undefined)
      },
    })
  }
}

function latestUserInput(chatCtx: ChatContext): string | null {
  for (let i = chatCtx.items.length - 1; i >= 0; i--) {
    const item = chatCtx.items[i]
    if (item.type === "message" && item.role === "user") {
      return item.textContent ?? null
    }
  }
  return null
}
