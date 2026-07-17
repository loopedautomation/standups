// A realtime speech-to-speech session with OpenAI, ported from the looped
// agent-framework's triggers/realtime.ts. The realtime model is only the
// interaction layer: it hears, talks, and decides when to speak. Everything
// that needs tools, knowledge or judgment it hands to the agent through one
// function call, and the looped agent loop does the work with its own
// permissions and audit trail. No SDK — the protocol is JSON events over a
// websocket.

/** The audio format both directions of the session speak: 24 kHz mono PCM16. */
export const REALTIME_SAMPLE_RATE = 24_000

/** The tool the realtime model calls to put the agent to work. */
export const DELEGATE_TOOL = "ask_agent"

const DEFAULT_HOST = "wss://api.openai.com/v1/realtime"

export type RealtimeSessionOptions = {
  model: string
  voice: string
  apiKey: string
  /** The agent's purpose, so the voice model knows whose mouth it is. */
  instructions: string
  /** Runs the prompt through the looped agent and resolves with the reply. */
  delegate: (request: string) => Promise<string>
  /** Speak these 24 kHz mono PCM16 bytes into the room. */
  onAudio: (pcm: Uint8Array) => void
  /** The human started talking over us — cut off whatever is still playing. */
  onInterrupt: () => void
  /** The model started/finished speaking (drives the state attribute). */
  onSpeaking?: () => void
  onIdle?: () => void
  onError?: (message: string) => void
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

function fromBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"))
}

/**
 * One realtime conversation. Open it, push room audio in, and it pushes
 * spoken audio back out through `onAudio` — turn-taking, barge-in and
 * backchannels are the model's business, not ours.
 */
export class RealtimeSession {
  #opts: RealtimeSessionOptions
  #ws?: WebSocket
  #closed = false
  #resolveReady!: () => void
  #ready = new Promise<void>((resolve) => {
    this.#resolveReady = resolve
  })
  #responding = false

  constructor(opts: RealtimeSessionOptions) {
    this.#opts = opts
  }

  get live(): boolean {
    return !this.#closed && this.#ws?.readyState === WebSocket.OPEN
  }

  /** Whether the model is currently speaking a response. */
  get responding(): boolean {
    return this.#responding
  }

  #send(event: Record<string, unknown>) {
    if (this.#ws?.readyState === WebSocket.OPEN)
      this.#ws.send(JSON.stringify(event))
  }

  /** Connect and configure; resolves once the provider accepted the session. */
  async open(): Promise<void> {
    const url = `${DEFAULT_HOST}?model=${encodeURIComponent(this.#opts.model)}`
    // The websocket API carries no headers, so the key rides the subprotocol
    // — the provider's documented path for a non-browser client.
    const ws = new WebSocket(url, [
      "realtime",
      `openai-insecure-api-key.${this.#opts.apiKey}`,
    ])
    this.#ws = ws

    ws.onopen = () => {
      this.#send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: this.#opts.instructions,
          audio: {
            input: {
              format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
              // Server-side VAD is what makes this feel like a conversation:
              // the model decides when a turn ended and interrupts itself
              // when the human starts talking again.
              turn_detection: {
                type: "server_vad",
                create_response: true,
                interrupt_response: true,
              },
            },
            output: {
              format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
              voice: this.#opts.voice,
            },
          },
          tools: [
            {
              type: "function",
              name: DELEGATE_TOOL,
              description:
                "Ask the agent to do something on your behalf. It has this agent's tools, " +
                "memory and permissions but takes several seconds, so use it only when you " +
                "actually need it: taking an action, looking something up, or answering about " +
                "systems, data or private state. Answer general questions and conversation " +
                "yourself, directly. When you do call it, say a few words first so the person " +
                "knows you are working on it.",
              parameters: {
                type: "object",
                properties: {
                  request: {
                    type: "string",
                    description:
                      "What to ask the agent, in full sentences and self-contained.",
                  },
                },
                required: ["request"],
              },
            },
          ],
        },
      })
      this.#resolveReady()
    }

    ws.onmessage = (raw) => {
      try {
        this.#handle(JSON.parse(String(raw.data)))
      } catch {
        // ignore malformed frames
      }
    }
    ws.onerror = () => this.#opts.onError?.("realtime websocket error")
    ws.onclose = () => {
      this.#closed = true
      this.#resolveReady() // never strand a caller waiting on a dead socket
    }

    await this.#ready
  }

  #handle(event: { type: string; [key: string]: unknown }) {
    switch (event.type) {
      case "response.output_audio.delta":
        if (!this.#responding) {
          this.#responding = true
          this.#opts.onSpeaking?.()
        }
        this.#opts.onAudio(fromBase64(event.delta as string))
        break
      case "response.done":
        this.#responding = false
        this.#opts.onIdle?.()
        break
      case "input_audio_buffer.speech_started":
        // The human started talking over us: drop what we were about to say.
        this.#responding = false
        this.#opts.onInterrupt()
        break
      case "response.function_call_arguments.done":
        void this.#delegate({
          call_id: String(event.call_id),
          arguments: String(event.arguments),
        })
        break
      case "error":
        this.#opts.onError?.(JSON.stringify(event.error))
        break
    }
  }

  /**
   * The model asked the agent for something. Run it, hand the answer back as
   * the tool's result, and ask for a spoken response. A failed run comes back
   * as text too — the model can tell the person what broke.
   */
  async #delegate(call: { call_id: string; arguments: string }) {
    let output: string
    try {
      const { request } = JSON.parse(call.arguments) as { request: string }
      output = await this.#opts.delegate(request)
    } catch (err) {
      output = `The agent could not answer: ${(err as Error).message}`
    }
    this.#send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.call_id, output },
    })
    this.#send({ type: "response.create" })
  }

  /** Ask the model to say something specific (e.g. the join greeting). */
  say(text: string) {
    // Creating a response while one is active is an API error; skip instead.
    if (this.#responding) return
    this.#send({
      type: "response.create",
      response: { instructions: `Say, more or less: ${text}` },
    })
  }

  /** Push 24 kHz mono PCM16 audio from the room into the session. */
  appendAudio(pcm: Uint8Array) {
    if (!pcm.length) return
    this.#send({ type: "input_audio_buffer.append", audio: toBase64(pcm) })
  }

  close() {
    this.#closed = true
    this.#ws?.close()
  }
}
