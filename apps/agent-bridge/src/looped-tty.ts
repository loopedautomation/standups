import WebSocket from "ws"

/** Frames spoken by the looped-af TTY trigger (agent-framework packages/triggers/tty.ts). */
export type TtyServerFrame =
  // `name` and `description` are the agent's own identity, added in a later
  // framework version; `handle` predates them and is the fallback for an
  // agent that doesn't send them yet.
  | {
      type: "hello"
      handle: string
      conversation_id: string
      name?: string
      description?: string
    }
  | { type: "step"; n: number }
  | { type: "assistant"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; content: string; durationMs: number }
  | { type: "compaction"; messageCount: number }
  | { type: "result"; status: string; reply: string; steps: number }
  | { type: "message"; text: string }
  | { type: "error"; error: string }

export type TtyClientOptions = {
  url: string
  token: string
  conversationId: string
  connectTimeoutMs?: number
  turnTimeoutMs?: number
}

/**
 * A persistent WebSocket client for a looped-af agent's TTY trigger.
 * One turn at a time: send input, stream frames until `result` or `error`.
 */
export class LoopedTtyClient {
  #opts: Required<TtyClientOptions>
  #ws: WebSocket | null = null
  /** Tail of the turn queue: each turn awaits the previous one's release. */
  #tail: Promise<void> = Promise.resolve()
  #aborted = false

  constructor(opts: TtyClientOptions) {
    this.#opts = {
      connectTimeoutMs: 10_000,
      turnTimeoutMs: 600_000,
      ...opts,
    }
  }

  async #connect(): Promise<WebSocket> {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) return this.#ws
    const url = new URL(this.#opts.url)
    url.searchParams.set("conversation_id", this.#opts.conversationId)
    // Bearer via subprotocol, matching the TTY trigger's browser-friendly auth.
    const ws = new WebSocket(url, [`bearer.${this.#opts.token}`])
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("TTY connect timeout")),
        this.#opts.connectTimeoutMs,
      )
      ws.once("open", () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    this.#ws = ws
    return ws
  }

  /**
   * Run one turn: send `input` (optionally with images, e.g. a screenshare
   * frame) and yield frames until the run finishes.
   * Turns that arrive while one is in flight queue behind it instead of
   * failing — a mid-turn utterance waits its turn rather than being dropped.
   *
   * A turn that dies before yielding a single frame is retried once on a
   * fresh connection — but only when the input plausibly never reached a
   * run: the connect itself failed, or the send went into a socket reused
   * from an earlier turn (the dominant failure: the agent restarted or the
   * connection idled out between turns, and the client hasn't noticed).
   * A freshly connected socket that dies after send is NOT retried — the
   * run may have started server-side, and replaying the input could execute
   * its actions twice.
   */
  async *runTurn(
    input: string,
    images?: { mediaType: string; data: string }[],
  ): AsyncGenerator<TtyServerFrame> {
    let release!: () => void
    const previous = this.#tail
    this.#tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      this.#aborted = false
      for (let attempt = 0; ; attempt++) {
        let yielded = false
        const reusedSocket = this.#ws?.readyState === WebSocket.OPEN
        let connected = false
        try {
          const ws = await this.#connect()
          connected = true
          const queue: TtyServerFrame[] = []
          let notify: (() => void) | null = null
          let closed: Error | null = null

          const onMessage = (data: WebSocket.RawData) => {
            try {
              queue.push(JSON.parse(String(data)) as TtyServerFrame)
            } catch {
              queue.push({ type: "error", error: "malformed frame from agent" })
            }
            notify?.()
          }
          const onClose = () => {
            closed = new Error(
              this.#aborted ? "cancelled" : "TTY connection closed",
            )
            notify?.()
          }
          ws.on("message", onMessage)
          ws.once("close", onClose)
          ws.once("error", onClose)

          const deadline = Date.now() + this.#opts.turnTimeoutMs
          try {
            ws.send(
              JSON.stringify({
                type: "input",
                text: input,
                ...(images?.length ? { images } : {}),
              }),
            )
            while (true) {
              while (queue.length === 0) {
                if (closed) throw closed
                if (Date.now() > deadline) throw new Error("TTY turn timeout")
                await new Promise<void>((resolve) => {
                  notify = resolve
                  setTimeout(resolve, 250)
                })
                notify = null
              }
              // biome-ignore lint/style/noNonNullAssertion: length checked above
              const frame = queue.shift()!
              // The server re-announces hello on connect; skip it mid-turn.
              if (frame.type === "hello") continue
              yielded = true
              yield frame
              if (frame.type === "result" || frame.type === "error") return
            }
          } finally {
            ws.off("message", onMessage)
            ws.off("close", onClose)
            ws.off("error", onClose)
          }
        } catch (err) {
          // Any connect failure is retriable (no run could have started);
          // a post-connect death only when the socket predated this turn.
          const retriable =
            attempt === 0 &&
            !yielded &&
            !this.#aborted &&
            (!connected ||
              (reusedSocket &&
                /TTY connection closed/.test((err as Error).message)))
          if (!retriable) throw err
          this.#ws?.close()
          this.#ws = null
        }
      }
    } finally {
      release()
    }
  }

  /**
   * Abort the in-flight turn. The TTY protocol has no cancel frame, but the
   * trigger's one-run-at-a-time flag is per-socket — dropping the socket
   * detaches the run (it finishes server-side into the void) and the next
   * turn reconnects clean. The aborted `runTurn` throws `Error("cancelled")`.
   */
  abortTurn() {
    this.#aborted = true
    this.#ws?.close()
    this.#ws = null
  }

  close() {
    this.#ws?.close()
    this.#ws = null
  }
}
