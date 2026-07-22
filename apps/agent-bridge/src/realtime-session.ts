// A realtime speech-to-speech session with OpenAI, ported from the looped
// agent-framework's triggers/realtime.ts. The realtime model is only the
// interaction layer: it hears, talks, and decides when to speak. Everything
// that needs tools, knowledge or judgment it hands to the agent through one
// function call, and the looped agent loop does the work with its own
// permissions and audit trail. No SDK — the protocol is JSON events over a
// websocket.

/** The audio format both directions of the session speak: 24 kHz mono PCM16. */
export const REALTIME_SAMPLE_RATE = 24_000

/** The tool the realtime model calls to do focused work with its own tools. */
export const DELEGATE_TOOL = "do_task"

/** The tool the realtime model calls to stop an in-flight background task. */
export const CANCEL_TOOL = "cancel_task"

/** How long a task may take before it goes to the background. */
const TASK_ACK_MS = 8_000

/** The tool the realtime model calls to post into the meeting chat. */
export const CHAT_TOOL = "send_chat_message"

/** The tools the realtime model calls to read and write the shared document. */
export const READ_DOC_TOOL = "read_shared_doc"
export const WRITE_DOC_TOOL = "write_shared_doc"

/** The tool the realtime model calls to look at the shared screen. */
export const LOOK_TOOL = "look_at_screen"

const DEFAULT_HOST = "wss://api.openai.com/v1/realtime"

/**
 * The provider-independent surface a realtime speech-to-speech session
 * exposes to the agent runner. RealtimeSession (OpenAI) and
 * GeminiLiveSession both implement it; realtime-agent.ts only sees this.
 */
export interface VoiceSession {
  /** Sample rate of audio pushed in via appendAudio (Hz, mono PCM16). */
  readonly inputSampleRate: number
  /** Sample rate of audio delivered via onAudio (Hz, mono PCM16). */
  readonly outputSampleRate: number
  readonly live: boolean
  readonly responding: boolean
  open(): Promise<void>
  appendAudio(pcm: Uint8Array): void
  say(text: string): void
  notifyChat(line: string): void
  setGateOpen(open: boolean): void
  callOn(): void
  cancelResponse(): void
  close(): void
}

export type RealtimeSessionOptions = {
  model: string
  voice: string
  apiKey: string
  /** The agent's purpose, so the voice model knows whose mouth it is. */
  instructions: string
  /** Runs the prompt through the looped agent and resolves with the reply. */
  delegate: (request: string) => Promise<string>
  /**
   * Stop the in-flight background task. Returns true if there was one.
   * The aborted delegate promise is expected to reject with "cancelled".
   */
  cancelWork?: () => boolean
  /** Post a message into the meeting chat on the agent's behalf. */
  sendChat?: (text: string) => void
  /**
   * The meeting's shared markdown document. Reading and writing are separate
   * tools rather than one: writing replaces the whole document, so the model
   * has to have read it first to avoid deleting what it didn't know about.
   */
  readDoc?: () => Promise<string>
  writeDoc?: (text: string) => Promise<string>
  /**
   * Look at the screen someone is sharing and describe it. The realtime
   * model has no eyes of its own here — this captures a frame and puts it
   * in front of a vision-capable brain, resolving with what it saw.
   *
   * Omitted when nothing can see: vision turned off, or a webhook brain
   * that drops images. The tool is then not offered at all, so the model
   * can't promise a look it cannot take.
   */
  lookAtScreen?: () => Promise<string>
  /** Speak these 24 kHz mono PCM16 bytes into the room. */
  onAudio: (pcm: Uint8Array) => void
  /** The human started talking over us — cut off whatever is still playing. */
  onInterrupt: () => void
  /** The model started/finished speaking (drives the state attribute). */
  onSpeaking?: () => void
  onIdle?: () => void
  onError?: (message: string) => void
  /**
   * Deterministic turn gate. When set, the model NEVER auto-responds: each
   * committed turn is transcribed, and audio is only produced when the turn
   * matches `mention` (addressed by name) or callOn() is invoked. Unaddressed
   * turns get a silent text-only deliberation; if the model reports it has
   * something important, `onHandRaise` fires and a human decides.
   */
  gate?: {
    mention: RegExp
    onHandRaise: () => void
    /**
     * When false, even a name mention doesn't grant the floor — the agent
     * raises its hand and waits for callOn() (turn_policy "raise-hand").
     * Defaults to true (mentions speak, turn_policy "on-mention").
     */
    mentionSpeaks?: () => boolean
    /** Observability: every gate decision, with the transcript that drove it. */
    onDecision?: (
      transcript: string,
      decision: "speak" | "deliberate" | "raise-hand",
    ) => void
  }
}

/** Silent text-only check run after unaddressed turns when gated. */
const DELIBERATE_INSTRUCTIONS =
  "Do not speak. Silently decide: given what was just said, do you have " +
  "something genuinely important to contribute — a correction, a direct " +
  "answer to a question aimed at you, or critical information? Reply with " +
  "exactly PASS if not (this is almost always the answer), or RAISE_HAND " +
  "if yes. If you have a useful aside, you may also use send_chat_message."

/** A provider-neutral function tool; each session maps it to its wire shape. */
export type ToolDeclaration = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * The shared tool surface of a realtime agent. Both providers offer the same
 * tools with the same wording, so agent behavior doesn't depend on which
 * speech-to-speech model fronts the brain.
 */
export function toolDeclarations(
  opts: Pick<RealtimeSessionOptions, "readDoc" | "writeDoc" | "lookAtScreen">,
): ToolDeclaration[] {
  return [
    {
      name: DELEGATE_TOOL,
      description:
        "Go do focused work yourself: this runs your own tools, memory and " +
        "permissions — it is you working, not another agent, so never describe it " +
        "as asking or waiting on someone else. It takes seconds to minutes, so use " +
        "it only when you actually need it: taking an action, looking something up, " +
        "or answering about systems, data or private state. Answer general " +
        "questions and conversation directly. When you start a task, say a few " +
        "words first so the person knows you're on it. If it takes long, it " +
        "continues in the background and you'll receive a [task finished] note — " +
        "until then, keep conversing normally and never invent a result.",
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description:
              "What to work on, in full sentences and self-contained.",
          },
        },
        required: ["request"],
      },
    },
    {
      name: CANCEL_TOOL,
      description:
        "Stop the background task you are currently working on, e.g. when " +
        "someone tells you to stop, never mind, or changes their request.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: CHAT_TOOL,
      description:
        "Post a message into the meeting's text chat. Use it for links, " +
        "asides, or anything useful that doesn't warrant speaking out " +
        "loud and interrupting the conversation.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The chat message to post." },
        },
        required: ["text"],
      },
    },
    ...(opts.readDoc && opts.writeDoc
      ? [
          {
            name: READ_DOC_TOOL,
            description:
              "Read the meeting's shared markdown document — the notes and " +
              "plan everyone in the room can see. Read it before writing, " +
              "and whenever someone refers to 'the doc', 'the notes' or " +
              "'the plan'.",
            parameters: { type: "object", properties: {} },
          },
          {
            name: WRITE_DOC_TOOL,
            description:
              "Replace the meeting's shared markdown document. This " +
              "overwrites it entirely, so read it first and send back the " +
              "full document with your changes folded in — never just the " +
              "part you added, or you will delete everyone else's work. " +
              "Use it when asked to write up, capture, or restructure what " +
              "was discussed. Say what you changed in a few words out loud; " +
              "don't read the document back.",
            parameters: {
              type: "object",
              properties: {
                text: {
                  type: "string",
                  description: "The complete new document, in markdown.",
                },
              },
              required: ["text"],
            },
          },
        ]
      : []),
    ...(opts.lookAtScreen
      ? [
          {
            name: LOOK_TOOL,
            description:
              "Look at the screen someone is sharing right now and get a " +
              "description of what's on it. You cannot see the share any " +
              "other way, so use this for ANY question about what is on " +
              "screen, what someone is pointing at, an error they're " +
              "showing you, or what to do next in what they're doing — and " +
              "never guess at screen contents without calling it. It takes " +
              "a moment, so say something short first ('let me look'). " +
              "Each call sees the screen as it is at that moment: call it " +
              "again rather than relying on what you saw earlier.",
            parameters: { type: "object", properties: {} },
          },
        ]
      : []),
  ]
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

function fromBase64(base64: string): Uint8Array {
  // Copy out of Node's shared Buffer pool: downstream consumers (the audio
  // source queue) hold these bytes async, and a pooled view gets overwritten
  // by later allocations — which plays back as garbled, overlapping speech.
  const pooled = Buffer.from(base64, "base64")
  const owned = new Uint8Array(pooled.length)
  owned.set(pooled)
  return owned
}

/**
 * One realtime conversation. Open it, push room audio in, and it pushes
 * spoken audio back out through `onAudio` — turn-taking, barge-in and
 * backchannels are the model's business, not ours.
 */
export class RealtimeSession implements VoiceSession {
  readonly inputSampleRate = REALTIME_SAMPLE_RATE
  readonly outputSampleRate = REALTIME_SAMPLE_RATE
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
              // Gated sessions need the turn's text to check for a mention.
              ...(this.#opts.gate
                ? { transcription: { model: "gpt-4o-mini-transcribe" } }
                : {}),
              // Server-side VAD is what makes this feel like a conversation:
              // the model decides when a turn ended and interrupts itself
              // when the human starts talking again. With a gate, VAD still
              // segments turns but responses are created only by us — the
              // model cannot decide to speak on its own.
              turn_detection: {
                type: "server_vad",
                create_response: !this.#opts.gate,
                interrupt_response: true,
              },
            },
            output: {
              format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
              voice: this.#opts.voice,
            },
          },
          tools: toolDeclarations(this.#opts).map((t) => ({
            type: "function",
            ...t,
          })),
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
      case "conversation.item.input_audio_transcription.completed": {
        // Gated mode: a turn just finished. Addressed by name → speak.
        // Otherwise run a silent deliberation; a RAISE_HAND answer surfaces
        // as the hand-raised badge for a human to act on.
        const gate = this.#opts.gate
        if (!gate || this.#gateOpen) break
        const transcript = String(event.transcript ?? "")
        if (!transcript.trim()) break
        const mentioned = gate.mention.test(transcript)
        const speaks = mentioned && (gate.mentionSpeaks?.() ?? true)
        if (mentioned && !speaks) {
          // Addressed by name under raise-hand policy: it clearly has the
          // floor to ask for — no deliberation needed, hand goes straight up.
          gate.onDecision?.(transcript, "raise-hand")
          gate.onHandRaise()
          break
        }
        gate.onDecision?.(transcript, speaks ? "speak" : "deliberate")
        if (speaks) {
          if (!this.#responding) this.#send({ type: "response.create" })
        } else if (!this.#responding) {
          this.#send({
            type: "response.create",
            response: {
              output_modalities: ["text"],
              instructions: DELIBERATE_INSTRUCTIONS,
            },
          })
        }
        break
      }
      case "response.output_text.done":
        // Only gated deliberations produce text output.
        if (String(event.text ?? "").includes("RAISE_HAND")) {
          this.#opts.gate?.onHandRaise()
        }
        break
      case "response.function_call_arguments.done":
        if (event.name === CHAT_TOOL) {
          this.#sendChatMessage({
            call_id: String(event.call_id),
            arguments: String(event.arguments),
          })
        } else if (event.name === CANCEL_TOOL) {
          this.#cancelTask(String(event.call_id))
        } else if (event.name === READ_DOC_TOOL) {
          void this.#docTool(String(event.call_id), () => this.#readDocText())
        } else if (event.name === WRITE_DOC_TOOL) {
          void this.#docTool(String(event.call_id), () =>
            this.#writeDocText(String(event.arguments)),
          )
        } else if (event.name === LOOK_TOOL) {
          void this.#lookAtScreen(String(event.call_id))
        } else {
          void this.#delegate({
            call_id: String(event.call_id),
            arguments: String(event.arguments),
          })
        }
        break
      case "error":
        this.#opts.onError?.(JSON.stringify(event.error))
        break
    }
  }

  /**
   * The model started a task. Quick tasks resolve as the tool's result;
   * anything slower is acknowledged immediately so the conversation stays
   * live, and the outcome lands later as a [task finished] note. Failures
   * come back as text too — the model can tell the person what broke.
   */
  async #delegate(call: { call_id: string; arguments: string }) {
    const finish = (output: string) => {
      this.#send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.call_id, output },
      })
      this.#send({ type: "response.create" })
    }

    let request: string
    try {
      request = (JSON.parse(call.arguments) as { request: string }).request
    } catch (err) {
      finish(`You couldn't start that task: ${(err as Error).message}`)
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
      finish(
        settled.ok
          ? settled.reply
          : `You couldn't finish that task: ${settled.reply}`,
      )
      return
    }

    finish(
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
    this.#send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: note }],
      },
    })
    // Speak to the outcome unless mid-reply; then it surfaces next turn.
    // A cancelled task stays silent — the cancel_task ack already spoke.
    if (!this.#responding && !note.startsWith("[task cancelled]")) {
      this.#send({ type: "response.create" })
    }
  }

  /** The model wants to stop its in-flight background task. */
  #cancelTask(callId: string) {
    const stopped = this.#opts.cancelWork?.() ?? false
    this.#send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: stopped
          ? "Stopped. The task will not finish."
          : "There was no task running.",
      },
    })
    this.#send({ type: "response.create" })
  }

  async #readDocText(): Promise<string> {
    const text = await this.#opts.readDoc?.()
    return text?.trim()
      ? `The shared document currently reads:\n\n${text}`
      : "The shared document is empty."
  }

  async #writeDocText(rawArguments: string): Promise<string> {
    const { text } = JSON.parse(rawArguments) as { text?: string }
    if (typeof text !== "string") return "No document text was provided."
    return (
      (await this.#opts.writeDoc?.(text)) ?? "You couldn't write the document."
    )
  }

  /**
   * The model asked to look at the shared screen. Unlike a chat post this
   * does force a response — the person asked a question and is waiting on
   * the answer.
   */
  async #lookAtScreen(callId: string) {
    let output: string
    try {
      output = await (this.#opts.lookAtScreen?.() ??
        Promise.resolve("You can't see the screen right now."))
    } catch (err) {
      // Reported to the model rather than swallowed, so it can say the look
      // failed instead of inventing what it would have seen.
      output = `You tried to look at the screen but couldn't: ${(err as Error).message}`
    }
    this.#send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    })
    this.#send({ type: "response.create" })
  }

  /**
   * Shared plumbing for the document tools: report the result and let the
   * model speak. Failures come back as text rather than silence, so it can
   * say the write didn't land instead of claiming it did.
   */
  async #docTool(callId: string, run: () => Promise<string>) {
    let output: string
    try {
      output = await run()
    } catch (err) {
      output = `That didn't work: ${(err as Error).message}`
    }
    this.#send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    })
    this.#send({ type: "response.create" })
  }

  /** The model posted to the meeting chat; ack the call without forcing speech. */
  #sendChatMessage(call: { call_id: string; arguments: string }) {
    let output = "sent"
    try {
      const { text } = JSON.parse(call.arguments) as { text: string }
      if (text) this.#opts.sendChat?.(text)
      else output = "empty message, nothing sent"
    } catch (err) {
      output = `could not send: ${(err as Error).message}`
    }
    this.#send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.call_id, output },
    })
    // No response.create: posting to chat should not make the model speak.
  }

  /**
   * Surface a meeting chat message to the model as context, without
   * triggering a response — it can bring it up if relevant, or ignore it.
   */
  notifyChat(line: string) {
    this.#send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: line }],
      },
    })
  }

  #gateOpen = false

  /**
   * Temporarily lift the gate (zap): the model auto-responds like an
   * ungated session until the gate is restored.
   */
  setGateOpen(open: boolean) {
    if (!this.#opts.gate || this.#gateOpen === open) return
    this.#gateOpen = open
    this.#send({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              create_response: open,
              interrupt_response: true,
            },
          },
        },
      },
    })
  }

  /** A human called on the agent: give it the floor for one response. */
  callOn() {
    if (this.#responding) return
    this.#send({
      type: "response.create",
      response: {
        instructions:
          "You raised your hand and have now been called on. Briefly say " +
          "what you wanted to contribute, then yield the floor.",
      },
    })
  }

  /** Cancel the in-progress response (tap-to-interrupt / hard mute). */
  cancelResponse() {
    if (!this.#responding) return
    this.#responding = false
    this.#send({ type: "response.cancel" })
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
