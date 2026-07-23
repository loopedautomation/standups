// A realtime speech-to-speech session with Google's Gemini Live API
// (BidiGenerateContent over websocket). Same shape as the OpenAI
// RealtimeSession: the model is only the interaction layer, and anything
// needing tools or judgment is delegated to the looped agent brain.
//
// Protocol differences that matter here:
//  - input audio is 16 kHz PCM16 (output is 24 kHz, same as OpenAI)
//  - tool call arguments arrive as objects, not JSON strings
//  - the model always auto-responds to a completed turn; there is no
//    create_response switch, so the deterministic turn gate the OpenAI
//    session offers cannot be implemented — gated turn policies are
//    rejected upstream for this provider.

import {
  CANCEL_TOOL,
  CHAT_TOOL,
  DELEGATE_TOOL,
  DRAW_CANVAS_TOOL,
  LEAVE_TOOL,
  LOOK_TOOL,
  READ_CANVAS_TOOL,
  READ_DOC_TOOL,
  type RealtimeSessionOptions,
  toolDeclarations,
  UPDATE_DOC_TOOL,
  type VoiceSession,
} from "./realtime-session.js"

export const GEMINI_INPUT_SAMPLE_RATE = 16_000
export const GEMINI_OUTPUT_SAMPLE_RATE = 24_000

/** The alias-free preview model the Gemini API serves for Live audio. */
export const GEMINI_LIVE_DEFAULT_MODEL =
  "gemini-2.5-flash-native-audio-preview-12-2025"

const HOST =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"

/** How long a task may take before it goes to the background. */
const TASK_ACK_MS = 8_000

/**
 * Reconnect policy: Gemini Live drops sessions mid-meeting (observed 1011
 * "Internal error" and 1007 content-type rejections) and the agent would
 * otherwise fall silent for the rest of the call. Bounded backoff; the
 * attempt counter resets once a reconnected session completes setup, so
 * only consecutive failures exhaust it.
 */
const RECONNECT_MAX_ATTEMPTS = 5
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 15_000

type FunctionCall = { id: string; name: string; args?: Record<string, unknown> }

type ServerMessage = {
  setupComplete?: Record<string, never>
  serverContent?: {
    interrupted?: boolean
    turnComplete?: boolean
    modelTurn?: {
      parts?: { inlineData?: { mimeType?: string; data?: string } }[]
    }
    outputTranscription?: { text?: string }
  }
  toolCall?: { functionCalls?: FunctionCall[] }
  goAway?: { timeLeft?: string }
}

function fromBase64(base64: string): Uint8Array {
  // Copy out of Node's shared Buffer pool — downstream holds these bytes
  // async, and a pooled view gets overwritten by later allocations.
  const pooled = Buffer.from(base64, "base64")
  const owned = new Uint8Array(pooled.length)
  owned.set(pooled)
  return owned
}

export class GeminiLiveSession implements VoiceSession {
  readonly inputSampleRate = GEMINI_INPUT_SAMPLE_RATE
  readonly outputSampleRate = GEMINI_OUTPUT_SAMPLE_RATE
  #opts: RealtimeSessionOptions
  #ws?: WebSocket
  #closed = false
  #resolveReady!: () => void
  #ready = new Promise<void>((resolve) => {
    this.#resolveReady = resolve
  })
  #responding = false
  /** Set by cancelResponse: drop audio until the model's turn completes. */
  #suppressTurn = false
  /** The current turn's spoken transcript, flushed on turnComplete. */
  #spokenBuf = ""
  #reconnectAttempts = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** True once any session completed setup — reconnects get a resume note. */
  #wasConnected = false

  constructor(opts: RealtimeSessionOptions) {
    this.#opts = opts
    if (opts.gate) {
      // Not silently: an agent configured to be gated but running ungated
      // would speak when it was promised to stay silent.
      throw new Error(
        "Gemini Live has no deterministic turn gate; gated turn policies " +
          "require the openai realtime provider",
      )
    }
  }

  get live(): boolean {
    return !this.#closed && this.#ws?.readyState === WebSocket.OPEN
  }

  get responding(): boolean {
    return this.#responding
  }

  #send(message: Record<string, unknown>) {
    if (this.#ws?.readyState === WebSocket.OPEN)
      this.#ws.send(JSON.stringify(message))
  }

  async open(): Promise<void> {
    this.#connect()
    await this.#ready
  }

  #connect(): void {
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve
    })
    const url = `${HOST}?key=${encodeURIComponent(this.#opts.apiKey)}`
    const ws = new WebSocket(url)
    this.#ws = ws

    ws.onopen = () => {
      this.#send({
        setup: {
          model: `models/${this.#opts.model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: this.#opts.voice },
              },
            },
          },
          systemInstruction: { parts: [{ text: this.#opts.instructions }] },
          // Transcribe the model's own speech so the brain's meeting record
          // includes the agent's side of the conversation.
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: toolDeclarations(this.#opts) }],
        },
      })
    }

    ws.onmessage = async (raw) => {
      try {
        // Frames arrive as Blob in Node's undici WebSocket; normalize to text.
        const data =
          raw.data instanceof Blob ? await raw.data.text() : String(raw.data)
        this.#handle(JSON.parse(data) as ServerMessage)
      } catch {
        // ignore malformed frames
      }
    }
    ws.onerror = () => this.#opts.onError?.("gemini live websocket error")
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return // superseded by a newer reconnect
      // Gemini closes the socket on setup errors (bad model, bad key)
      // instead of sending an error frame — surface the reason.
      if (ev.code !== 1000 && ev.reason) {
        this.#opts.onError?.(`gemini live closed: ${ev.code} ${ev.reason}`)
      }
      this.#resolveReady() // never strand a caller waiting on a dead socket
      if (this.#closed) return
      // A mid-turn drop leaves half-spoken state behind; reset it so the
      // reconnected session starts a clean turn, and flush queued playout.
      if (this.#responding) this.#opts.onInterrupt()
      this.#responding = false
      this.#suppressTurn = false
      this.#spokenBuf = ""
      this.#scheduleReconnect()
    }
  }

  #scheduleReconnect(): void {
    const attempt = ++this.#reconnectAttempts
    if (attempt > RECONNECT_MAX_ATTEMPTS) {
      this.#closed = true
      this.#opts.onError?.(
        `gemini live: gave up after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts`,
      )
      return
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
      RECONNECT_MAX_DELAY_MS,
    )
    this.#opts.onError?.(
      `gemini live: reconnecting in ${delay}ms (attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS})`,
    )
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      if (!this.#closed) this.#connect()
    }, delay)
  }

  #handle(message: ServerMessage) {
    if (message.setupComplete) {
      this.#reconnectAttempts = 0
      if (this.#wasConnected) {
        // A reconnected session has no conversation history — the setup
        // resends the instructions, but the model must not greet the room
        // as if it just arrived. Context only; no turnComplete, so the
        // model doesn't auto-respond to it.
        this.#sendUserText(
          "[Your voice connection dropped briefly and is now restored, " +
            "mid-meeting. Continue naturally from the live audio; do not " +
            "greet the room again or mention the interruption.]",
          false,
        )
      }
      this.#wasConnected = true
      this.#resolveReady()
      return
    }
    const content = message.serverContent
    if (content) {
      if (content.interrupted) {
        // The human started talking over us: drop what we were about to say.
        this.#responding = false
        this.#opts.onInterrupt()
      }
      for (const part of content.modelTurn?.parts ?? []) {
        const data = part.inlineData?.data
        if (!data || this.#suppressTurn) continue
        if (!this.#responding) {
          this.#responding = true
          this.#opts.onSpeaking?.()
        }
        this.#opts.onAudio(fromBase64(data))
      }
      if (content.outputTranscription?.text) {
        this.#spokenBuf += content.outputTranscription.text
      }
      if (content.turnComplete) {
        this.#responding = false
        this.#suppressTurn = false
        const spoken = this.#spokenBuf.trim()
        this.#spokenBuf = ""
        if (spoken) this.#opts.onAgentSpoke?.(spoken)
        this.#opts.onIdle?.()
      }
      return
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      this.#dispatchTool(call)
    }
    if (message.goAway) {
      this.#opts.onError?.(
        `gemini live: server going away (${message.goAway.timeLeft ?? "now"})`,
      )
    }
  }

  #finishTool(call: FunctionCall, output: string) {
    // Unlike OpenAI there is no response.create: the model continues on its
    // own once the function response lands.
    this.#send({
      toolResponse: {
        functionResponses: [
          { id: call.id, name: call.name, response: { output } },
        ],
      },
    })
  }

  #dispatchTool(call: FunctionCall) {
    switch (call.name) {
      case CHAT_TOOL: {
        const text = String(call.args?.text ?? "")
        if (text) this.#opts.sendChat?.(text)
        this.#finishTool(call, text ? "sent" : "empty message, nothing sent")
        break
      }
      case CANCEL_TOOL: {
        const stopped = this.#opts.cancelWork?.() ?? false
        this.#finishTool(
          call,
          stopped
            ? "Stopped. The task will not finish."
            : "There was no task running.",
        )
        break
      }
      case READ_DOC_TOOL:
        void this.#docTool(call, async () => {
          const text = await this.#opts.readDoc?.()
          return text?.trim()
            ? `The shared document currently reads:\n\n${text}`
            : "The shared document is empty."
        })
        break
      case UPDATE_DOC_TOOL:
        void this.#docTool(call, async () => {
          const instruction = call.args?.instruction
          if (typeof instruction !== "string" || !instruction.trim())
            return "No update instruction was provided."
          return (
            (await this.#opts.updateDoc?.(instruction)) ??
            "You couldn't update the document."
          )
        })
        break
      case READ_CANVAS_TOOL:
        void this.#docTool(
          call,
          async () =>
            (await this.#opts.readCanvas?.()) ??
            "You can't read the whiteboard.",
        )
        break
      case DRAW_CANVAS_TOOL:
        void this.#docTool(call, async () => {
          const instruction = call.args?.instruction
          if (typeof instruction !== "string" || !instruction.trim())
            return "No drawing instruction was provided."
          return (
            (await this.#opts.drawCanvas?.(instruction)) ??
            "You can't draw right now."
          )
        })
        break
      case LOOK_TOOL:
        void this.#docTool(
          call,
          async () =>
            (await this.#opts.lookAtScreen?.()) ??
            "You can't see the screen right now.",
        )
        break
      case LEAVE_TOOL:
        void this.#docTool(call, async () => {
          this.#opts.leaveMeeting?.()
          return "You're leaving the meeting now — say nothing further."
        })
        break
      case DELEGATE_TOOL:
        void this.#delegate(call)
        break
      default:
        this.#finishTool(call, `unknown tool: ${call.name}`)
    }
  }

  /** Shared plumbing: report the result, surfacing failures as text. */
  async #docTool(call: FunctionCall, run: () => Promise<string>) {
    let output: string
    try {
      output = await run()
    } catch (err) {
      output = `That didn't work: ${(err as Error).message}`
    }
    this.#finishTool(call, output)
  }

  /**
   * The model started a task. Quick tasks resolve as the tool's result;
   * anything slower is acknowledged immediately so the conversation stays
   * live, and the outcome lands later as a [task finished] note.
   */
  async #delegate(call: FunctionCall) {
    const request = String(call.args?.request ?? "")
    if (!request) {
      this.#finishTool(call, "You couldn't start that task: no request given.")
      return
    }

    const work = this.#opts.delegate(request).then(
      (reply) => ({ ok: true as const, reply }),
      (err: Error) => ({ ok: false as const, reply: err.message }),
    )
    const backgrounded = Symbol("backgrounded")
    const settled = await Promise.race([
      work,
      new Promise<typeof backgrounded>((resolve) =>
        setTimeout(() => resolve(backgrounded), TASK_ACK_MS),
      ),
    ])

    if (settled !== backgrounded) {
      this.#finishTool(
        call,
        settled.ok
          ? settled.reply
          : `You couldn't finish that task: ${settled.reply}`,
      )
      return
    }

    this.#finishTool(
      call,
      "The task is taking a while, so it's continuing in the background. " +
        "Briefly let the person know you're still on it if you haven't; " +
        "you'll get a [task finished] note here with the outcome — do not " +
        "report or invent a result before then.",
    )
    const result = await work
    const note = result.ok
      ? `[task finished] Your background task is done. Outcome:\n${result.reply}`
      : result.reply === "cancelled"
        ? "[task cancelled] Your background task was stopped before finishing."
        : `[task failed] Your background task failed: ${result.reply}`
    // A cancelled task stays quiet — the cancel_task ack already spoke.
    this.#sendUserText(note, !note.startsWith("[task cancelled]"))
  }

  #sendUserText(text: string, complete = true) {
    this.#send({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: complete,
      },
    })
  }

  /**
   * Surface a meeting chat message as context. Gemini has no way to add a
   * turn without completing it, so the instructions (chat is passive, reply
   * in chat or ignore) carry the weight of keeping the model quiet.
   */
  notifyChat(line: string) {
    this.#sendUserText(line)
  }

  /**
   * An addressed chat message: Gemini has no text-only response mode, so
   * the injected turn carries the instruction to answer through the chat
   * tool rather than aloud.
   */
  promptChatReply(line: string) {
    this.#sendUserText(
      `${line}\n[You were addressed by name in the meeting's text chat. ` +
        `Reply briefly into the chat using the ${CHAT_TOOL} tool; don't ` +
        "read your reply aloud.]",
    )
  }

  /** No-op: Gemini Live cannot be gated (rejected in the constructor). */
  setGateOpen(_open: boolean) {}

  /** A human called on the agent: give it the floor for one response. */
  callOn() {
    if (this.#responding) return
    this.#sendUserText(
      "[You raised your hand and have now been called on. Briefly say " +
        "what you wanted to contribute, then yield the floor.]",
    )
  }

  /**
   * Cancel the in-progress response (tap-to-interrupt / hard mute). There is
   * no cancel frame; the rest of this turn's audio is dropped instead.
   */
  cancelResponse() {
    if (!this.#responding) return
    this.#responding = false
    this.#suppressTurn = true
  }

  /** Ask the model to say something specific (e.g. the join greeting). */
  say(text: string) {
    if (this.#responding) return
    this.#sendUserText(`[Say, more or less: ${text}]`)
  }

  /** Push 16 kHz mono PCM16 audio from the room into the session. */
  appendAudio(pcm: Uint8Array) {
    if (!pcm.length) return
    this.#send({
      realtimeInput: {
        audio: {
          data: Buffer.from(pcm).toString("base64"),
          mimeType: `audio/pcm;rate=${GEMINI_INPUT_SAMPLE_RATE}`,
        },
      },
    })
  }

  close() {
    this.#closed = true
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
    this.#ws?.close()
  }
}
