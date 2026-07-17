import { ReadableStream } from "node:stream/web"
import { type ChatContext, type llm, voice } from "@livekit/agents"
import type { AgentActivityEvent, AgentState } from "@meet/shared"
import type { TtyServerFrame } from "./looped-tty.js"
import type { Brain } from "./looped-webhook.js"
import type { AgentEntry } from "./registry.js"
import type { ScreenCapture } from "./screen-capture.js"

export type BridgeCallbacks = {
  publishActivity: (event: AgentActivityEvent) => void
  publishChat: (text: string) => void
  setState: (state: AgentState) => void
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

  constructor(
    entry: AgentEntry,
    brain: Brain,
    state: SessionState,
    callbacks: BridgeCallbacks,
    screen: ScreenCapture | null = null,
  ) {
    super({ instructions: instructions(entry) })
    this.#entry = entry
    this.#brain = brain
    this.#state = state
    this.#callbacks = callbacks
    this.#screen = screen
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

    let text = input
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
    let images: { mediaType: string; data: string }[] | undefined
    const capture = this.#screen?.active
      ? await this.#screen.latestJpeg().catch(() => null)
      : null
    if (capture) {
      images = [{ mediaType: capture.mediaType, data: capture.data }]
      text = `[A current frame of ${capture.sharerName}'s shared screen is attached.]\n${text}`
    }

    const iterator = brain.runTurn(text, images)
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
                content: frame.content.slice(0, 2000),
                durationMs: frame.durationMs,
                at,
              })
              break
            case "assistant":
              if (state.muted) {
                callbacks.publishChat(frame.content)
              } else {
                controller.enqueue(frame.content)
              }
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
