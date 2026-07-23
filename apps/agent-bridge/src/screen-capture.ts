import {
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  TrackKind,
  TrackSource,
  VideoBufferType,
  type VideoFrame,
  VideoStream,
} from "@livekit/rtc-node"
import sharp from "sharp"

const MAX_WIDTH = 1280
const JPEG_QUALITY = 70
/** Don't re-encode more than once per second even if turns are frequent. */
const ENCODE_INTERVAL_MS = 1000

export type CapturedFrame = {
  mediaType: "image/jpeg"
  data: string
  sharerName: string
}

/** An image as the brain's TTY protocol carries it. */
export type BrainImage = { mediaType: string; data: string }

/**
 * Whether agents may look at shared screens at all. A meeting where the
 * agent silently reads every frame of whatever you share is not one people
 * can consent to by default in every deployment, so it's one env var to turn
 * off — `AGENT_SCREEN_VISION=off` — and the web UI tells sharers which way
 * it's set rather than leaving it to the operator to remember.
 */
export function screenVisionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = env.AGENT_SCREEN_VISION?.trim().toLowerCase()
  return flag !== "off" && flag !== "false" && flag !== "0"
}

/**
 * Attaches the current screenshare frame to a turn, if there is one.
 *
 * Every path that talks to the brain — voice turn, chat reply, realtime
 * delegation — needs the same two things done identically: the image on the
 * message, and a line of text telling the model the image is there and whose
 * screen it is. Three hand-rolled copies of that had already drifted apart.
 */
export async function attachScreenFrame(
  screen: ScreenCapture | null | undefined,
  text: string,
): Promise<{ text: string; images?: BrainImage[] }> {
  const capture = screen?.active
    ? await screen.latestJpeg().catch(() => null)
    : null
  if (!capture) return { text }
  return {
    text: `[A current frame of ${capture.sharerName}'s shared screen is attached.]\n${text}`,
    images: [{ mediaType: capture.mediaType, data: capture.data }],
  }
}

/** What ScreenCapture reports about itself — wired by the worker into the
 * room's debug feed, because every prior failure in this path was silent. */
export type ScreenCaptureLog = (
  level: "info" | "error",
  message: string,
) => void

/** A frame source for one track — injectable so tests can drive frames. */
type FrameStream = AsyncIterable<{ frame: VideoFrame }> & {
  cancel: () => Promise<unknown>
}

/** A stream that ends immediately this many times in a row is dead. */
const MAX_FRAMELESS_RESTARTS = 3
const RESTART_DELAY_MS = 1000

/**
 * Watches the room for screenshare video tracks and keeps the most recent
 * frame, encoded lazily to JPEG when a turn asks for it.
 */
export class ScreenCapture {
  #room: Room
  #latest: { frame: VideoFrame; sharerName: string; sid: string } | null = null
  #encoded: { at: number; result: CapturedFrame } | null = null
  #streams = new Map<string, { stop: () => void }>()
  readonly #enabled: boolean
  readonly #log: ScreenCaptureLog
  readonly #makeStream: (track: RemoteTrack) => FrameStream

  constructor(
    room: Room,
    enabled = screenVisionEnabled(),
    opts: {
      log?: ScreenCaptureLog
      makeStream?: (track: RemoteTrack) => FrameStream
    } = {},
  ) {
    this.#room = room
    this.#enabled = enabled
    this.#log = opts.log ?? (() => undefined)
    this.#makeStream =
      opts.makeStream ?? ((track) => new VideoStream(track) as FrameStream)
    if (!enabled) {
      this.#log("info", "screen vision is off (AGENT_SCREEN_VISION)")
      return
    }
    room.on(
      "trackSubscribed",
      (track: RemoteTrack, pub: RemoteTrackPublication, participant) => {
        if (
          track.kind === TrackKind.KIND_VIDEO &&
          pub.source === TrackSource.SOURCE_SCREENSHARE
        ) {
          this.#watch(track, participant.name || participant.identity)
        }
      },
    )
    room.on("trackUnsubscribed", (track: RemoteTrack) => {
      const sid = track.sid ?? ""
      const watcher = this.#streams.get(sid)
      if (watcher) {
        watcher.stop()
        this.#streams.delete(sid)
        // Only drop the kept frame if it came from this track — during a
        // share takeover the old share's unsubscribe must not blank out the
        // frame the new share already latched.
        if (this.#latest?.sid === sid) {
          this.#latest = null
          this.#encoded = null
        }
      }
    })
    // Tracks subscribed before this instance existed never fire the event.
    // Today construction races nothing (no awaits between connect and here),
    // but that's an accident of the caller — sweep so it stays true.
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        const track = pub.track
        if (
          track &&
          pub.subscribed &&
          track.kind === TrackKind.KIND_VIDEO &&
          pub.source === TrackSource.SOURCE_SCREENSHARE &&
          !this.#streams.has(track.sid ?? "")
        ) {
          this.#watch(track, participant.name || participant.identity)
        }
      }
    }
  }

  /** True when a screenshare is running and agents are allowed to see it. */
  get active(): boolean {
    return this.#enabled && this.#latest !== null
  }

  /** Whether this deployment lets agents look at shared screens at all. */
  get enabled(): boolean {
    return this.#enabled
  }

  /** Who is sharing right now, for telling the agent what it could look at. */
  get sharerName(): string | null {
    return this.active ? (this.#latest?.sharerName ?? null) : null
  }

  #watch(track: RemoteTrack, sharerName: string) {
    const sid = track.sid ?? ""
    let stopped = false
    let stream: FrameStream | null = null
    this.#log("info", `watching ${sharerName}'s screenshare (${sid})`)
    const run = async () => {
      // The stream dying does not mean the share ended — that's what
      // trackUnsubscribed says. Reopen it until the track actually goes
      // away, giving up only when restarts stop producing frames.
      let framelessRestarts = 0
      while (!stopped) {
        const current = this.#makeStream(track)
        stream = current
        let sawFrame = false
        try {
          for await (const event of current) {
            if (stopped) break
            if (!sawFrame) {
              sawFrame = true
              framelessRestarts = 0
              this.#log(
                "info",
                `receiving frames from ${sharerName}'s screenshare ` +
                  `(${event.frame.width}x${event.frame.height})`,
              )
            }
            this.#latest = { frame: event.frame, sharerName, sid }
          }
        } catch (err) {
          this.#log(
            "error",
            `frame stream from ${sharerName} failed: ${(err as Error).message}`,
          )
        }
        if (stopped) return
        if (!sawFrame && ++framelessRestarts >= MAX_FRAMELESS_RESTARTS) {
          this.#log(
            "error",
            `frame stream from ${sharerName} produced no frames after ` +
              `${framelessRestarts} attempts; giving up on this track`,
          )
          this.#streams.delete(sid)
          return
        }
        this.#log(
          "error",
          `frame stream from ${sharerName} ended while the track is still ` +
            `subscribed; reopening in ${RESTART_DELAY_MS}ms`,
        )
        await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS))
      }
    }
    run().catch(() => undefined)
    this.#streams.set(sid, {
      stop: () => {
        stopped = true
        stream?.cancel().catch(() => undefined)
      },
    })
  }

  /** The most recent screenshare frame as JPEG, or null when nobody shares. */
  async latestJpeg(): Promise<CapturedFrame | null> {
    if (!this.#enabled) return null
    const latest = this.#latest
    if (!latest) return null
    if (this.#encoded && Date.now() - this.#encoded.at < ENCODE_INTERVAL_MS) {
      return this.#encoded.result
    }
    try {
      const rgba =
        latest.frame.type === VideoBufferType.RGBA
          ? latest.frame
          : latest.frame.convert(VideoBufferType.RGBA)
      const width = rgba.width
      const height = rgba.height
      let pipeline = sharp(
        Buffer.from(rgba.data.buffer, rgba.data.byteOffset, width * height * 4),
        { raw: { width, height, channels: 4 } },
      )
      if (width > MAX_WIDTH) pipeline = pipeline.resize({ width: MAX_WIDTH })
      const jpeg = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer()
      const result: CapturedFrame = {
        mediaType: "image/jpeg",
        data: jpeg.toString("base64"),
        sharerName: latest.sharerName,
      }
      this.#encoded = { at: Date.now(), result }
      return result
    } catch (err) {
      // attachScreenFrame degrades to a text-only turn on null — but the
      // failure must land in the logs, or "the agent can't see" is
      // undiagnosable from the outside (issue #110).
      this.#log(
        "error",
        `encoding ${latest.sharerName}'s frame failed: ${(err as Error).message}`,
      )
      return null
    }
  }
}
