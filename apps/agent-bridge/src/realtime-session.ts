// A realtime speech-to-speech session with OpenAI, ported from the looped
// agent-framework's triggers/realtime.ts. The realtime model is only the
// interaction layer: it hears, talks, and decides when to speak. Everything
// that needs tools, knowledge or judgment it hands to the agent through one
// function call, and the looped agent loop does the work with its own
// permissions and audit trail. No SDK — the protocol is JSON events over a
// websocket.

import {
  type CanvasOp,
  canvasColorSchema,
  canvasOpBatchSchema,
} from "@meet/shared"

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

/**
 * The tools the realtime model calls to read and update the shared document.
 * Updating takes an *instruction*, not document text: the brain composes the
 * new document, so its judgment and audit trail cover doc writes too.
 */
export const READ_DOC_TOOL = "read_shared_doc"
export const UPDATE_DOC_TOOL = "update_shared_doc"

/** The tool the realtime model calls to look at the shared screen. */
export const LOOK_TOOL = "look_at_screen"

/** The tools the realtime model calls to read and draw on the whiteboard. */
export const READ_CANVAS_TOOL = "read_canvas"
export const DRAW_CANVAS_TOOL = "draw_on_canvas"

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
  /**
   * A chat message that addressed the agent by name: surface it AND elicit
   * a reply into the chat (send_chat_message), without speaking. Plain
   * notifyChat only adds context, so a realtime agent would otherwise stay
   * silent to @mentions forever (#112).
   */
  promptChatReply(line: string): void
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
   * The meeting's shared markdown document. Reading returns the text;
   * updating hands an *instruction* to the brain, which composes the new
   * document itself — the voice model never authors persistent content.
   */
  readDoc?: () => Promise<string>
  updateDoc?: (instruction: string) => Promise<string>
  /**
   * The meeting's shared whiteboard. Reading returns a text description of
   * every shape with its id; drawing takes a batch of primitive ops. Both
   * or neither — a model that can draw but not read would trample what
   * others drew.
   */
  readCanvas?: () => Promise<string>
  drawCanvas?: (ops: CanvasOp[]) => Promise<string>
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
   * Transcript of what the model just said aloud, one response at a time —
   * relayed to the brain so its record of the meeting includes the agent's
   * own side of the conversation.
   */
  onAgentSpoke?: (text: string) => void
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
  opts: Pick<
    RealtimeSessionOptions,
    "readDoc" | "updateDoc" | "readCanvas" | "drawCanvas" | "lookAtScreen"
  >,
): ToolDeclaration[] {
  return [
    {
      name: DELEGATE_TOOL,
      description:
        "Think and act: this is where your knowledge, memory, tools and " +
        "permissions live — it is you working, not another agent, so never " +
        "describe it as asking or waiting on someone else. Every answer of " +
        "substance comes from here: use it for anything factual, anything " +
        "about systems, data, people, documents or past conversations, any " +
        "opinion on the work, and any action — even when you feel sure of " +
        "the answer yourself. It takes seconds to minutes; say a few words " +
        "first so the person knows you're on it. If it takes long, it " +
        "continues in the background and you'll receive a [task finished] " +
        "note — until then, keep conversing normally and never invent a " +
        "result.",
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
    ...(opts.readDoc && opts.updateDoc
      ? [
          {
            name: READ_DOC_TOOL,
            description:
              "Read the meeting's shared markdown document — the notes and " +
              "plan everyone in the room can see. Read it whenever someone " +
              "refers to 'the doc', 'the notes' or 'the plan'.",
            parameters: { type: "object", properties: {} },
          },
          {
            name: UPDATE_DOC_TOOL,
            description:
              "Update the meeting's shared markdown document. Describe the " +
              "change to make in full — what to add, capture, or " +
              "restructure, with the specifics from the conversation folded " +
              "in — and the document is rewritten for you with everyone " +
              "else's work preserved. Use it when asked to write something " +
              "up, capture a decision, or draft a plan. It takes a moment, " +
              "so say a few words first; afterwards say what changed in a " +
              "few words — don't read the document back.",
            parameters: {
              type: "object",
              properties: {
                instruction: {
                  type: "string",
                  description:
                    "The change to make, in full sentences and " +
                    "self-contained, including the details it should capture.",
                },
              },
              required: ["instruction"],
            },
          },
        ]
      : []),
    ...(opts.readCanvas && opts.drawCanvas
      ? [
          {
            name: READ_CANVAS_TOOL,
            description:
              "Read what is currently on the meeting's shared whiteboard as " +
              "a text description — every shape with its id, position, size " +
              "and label. Use it before drawing onto an existing diagram, " +
              "and whenever someone refers to 'the whiteboard', 'the board' " +
              "or 'the diagram'.",
            parameters: { type: "object", properties: {} },
          },
          {
            name: DRAW_CANVAS_TOOL,
            description:
              "Draw on the meeting's shared whiteboard, which everyone can " +
              "see live. Send a batch of simple operations: rectangles, " +
              "ellipses, sticky notes, text, freehand lines, and arrows " +
              "that connect shapes by id. Coordinates are page pixels with " +
              "y growing DOWNWARD from the top-left origin: lay diagrams " +
              "out left-to-right or top-down starting near (0,0) on " +
              "roughly a 1600x1000 area, size boxes around 160x80, and " +
              "leave ~80px gaps. For charts and aligned layouts compute " +
              "positions with arithmetic, never by eye: bars on a shared " +
              "baseline all end at the same y+h, so a taller bar starts at " +
              "a SMALLER y; draw the axes from that same baseline. Placing " +
              "a shape inside a larger frame is fine. Omit x/y to " +
              "auto-place a loose shape in free space; every result " +
              "reports where each shape landed — use those positions when " +
              "placing the next ones, never reuse the same spot. Give " +
              "every shape a short memorable id " +
              "(e.g. 'api') so you can connect, move or update it later. " +
              "Build complex diagrams incrementally across several calls " +
              "while you talk — draw a part, say what it is, draw the " +
              "next. If others may have drawn, call read_canvas first. " +
              "Never narrate coordinates or ids out loud.",
            parameters: {
              type: "object",
              properties: {
                ops: {
                  type: "array",
                  description: "Operations applied in order.",
                  items: {
                    type: "object",
                    properties: {
                      op: {
                        type: "string",
                        enum: [
                          "rect",
                          "ellipse",
                          "text",
                          "note",
                          "arrow",
                          "draw",
                          "move",
                          "update",
                          "delete",
                          "clear",
                        ],
                      },
                      id: {
                        type: "string",
                        description:
                          "Short id, e.g. 'api'. Required for every op " +
                          "except clear.",
                      },
                      x: {
                        type: "number",
                        description:
                          "Page-pixel position. Omit on creates to " +
                          "auto-place clear of existing shapes.",
                      },
                      y: { type: "number" },
                      w: { type: "number" },
                      h: { type: "number" },
                      label: {
                        type: "string",
                        description: "Label on rect/ellipse/arrow shapes.",
                      },
                      text: {
                        type: "string",
                        description: "Content of text/note shapes.",
                      },
                      color: {
                        type: "string",
                        enum: [...canvasColorSchema.options],
                      },
                      fill: { type: "string", enum: ["none", "semi", "solid"] },
                      size: { type: "string", enum: ["s", "m", "l", "xl"] },
                      from: {
                        type: "string",
                        description: "Arrow start: a shape id to attach to.",
                      },
                      to: {
                        type: "string",
                        description: "Arrow end: a shape id to attach to.",
                      },
                      fromPoint: {
                        type: "object",
                        description: "Arrow start as a free point instead.",
                        properties: {
                          x: { type: "number" },
                          y: { type: "number" },
                        },
                      },
                      toPoint: {
                        type: "object",
                        description: "Arrow end as a free point instead.",
                        properties: {
                          x: { type: "number" },
                          y: { type: "number" },
                        },
                      },
                      points: {
                        type: "array",
                        description: "Freehand polyline, in page pixels.",
                        items: {
                          type: "object",
                          properties: {
                            x: { type: "number" },
                            y: { type: "number" },
                          },
                        },
                      },
                    },
                    required: ["op"],
                  },
                },
              },
              required: ["ops"],
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
      case "response.output_audio_transcript.done": {
        // What the agent just said aloud, for the brain's meeting record.
        const spoken = String(event.transcript ?? "").trim()
        if (spoken) this.#opts.onAgentSpoke?.(spoken)
        break
      }
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
        } else if (event.name === UPDATE_DOC_TOOL) {
          void this.#docTool(String(event.call_id), () =>
            this.#updateDocText(String(event.arguments)),
          )
        } else if (event.name === READ_CANVAS_TOOL) {
          void this.#docTool(String(event.call_id), () => this.#readCanvas())
        } else if (event.name === DRAW_CANVAS_TOOL) {
          void this.#docTool(String(event.call_id), () =>
            this.#drawCanvas(String(event.arguments)),
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

  async #updateDocText(rawArguments: string): Promise<string> {
    const { instruction } = JSON.parse(rawArguments) as {
      instruction?: string
    }
    if (typeof instruction !== "string" || !instruction.trim())
      return "No update instruction was provided."
    return (
      (await this.#opts.updateDoc?.(instruction)) ??
      "You couldn't update the document."
    )
  }

  async #readCanvas(): Promise<string> {
    return (await this.#opts.readCanvas?.()) ?? "You can't read the whiteboard."
  }

  async #drawCanvas(rawArguments: string): Promise<string> {
    const parsed = canvasOpBatchSchema.safeParse(
      (JSON.parse(rawArguments) as { ops?: unknown }).ops,
    )
    // Malformed ops go back as text, not an exception: the model can fix
    // its batch and retry instead of falling silent.
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return `Those drawing operations were invalid (${issue?.path.join(".")}: ${issue?.message}). Fix the batch and try again.`
    }
    return (
      (await this.#opts.drawCanvas?.(parsed.data)) ??
      "You can't draw right now."
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

  /**
   * An addressed chat message: inject it like notifyChat, then create a
   * text-only response so the model answers into the chat via its
   * send_chat_message tool instead of aloud. Skipped while a response is
   * in flight — the injected line still lands as context for later.
   */
  promptChatReply(line: string) {
    this.notifyChat(line)
    if (this.#responding) return
    this.#send({
      type: "response.create",
      response: {
        output_modalities: ["text"],
        instructions:
          "You were just addressed in the meeting's text chat (the last " +
          "[meeting chat] message). Reply briefly into the chat with the " +
          `${CHAT_TOOL} tool — text only, do not speak. If you genuinely ` +
          "have nothing to add, reply with a short acknowledgement.",
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
