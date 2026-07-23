import { EventEmitter } from "node:events"
import {
  TrackKind,
  TrackSource,
  VideoBufferType,
  VideoFrame,
} from "@livekit/rtc-node"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  attachScreenFrame,
  type CapturedFrame,
  ScreenCapture,
  screenVisionEnabled,
} from "./screen-capture.js"

type ScreenLike = Parameters<typeof attachScreenFrame>[0]

function fakeScreen(
  frame: CapturedFrame | null,
  { throws = false }: { throws?: boolean } = {},
): ScreenLike {
  return {
    active: frame !== null,
    latestJpeg: async () => {
      if (throws) throw new Error("encode failed")
      return frame
    },
  } as unknown as ScreenLike
}

const frame: CapturedFrame = {
  mediaType: "image/jpeg",
  data: "BASE64",
  sharerName: "Amin",
}

describe("screenVisionEnabled", () => {
  it("is on by default", () => {
    expect(screenVisionEnabled({})).toBe(true)
  })

  it("is off for off/false/0, case- and space-insensitively", () => {
    for (const value of ["off", "OFF", " off ", "false", "0"]) {
      expect(screenVisionEnabled({ AGENT_SCREEN_VISION: value })).toBe(false)
    }
  })

  it("stays on for anything else", () => {
    for (const value of ["on", "true", "1", ""]) {
      expect(screenVisionEnabled({ AGENT_SCREEN_VISION: value })).toBe(true)
    }
  })
})

describe("attachScreenFrame", () => {
  it("passes the text through untouched when nobody is sharing", async () => {
    expect(await attachScreenFrame(fakeScreen(null), "what's up?")).toEqual({
      text: "what's up?",
    })
  })

  it("leaves the turn alone when there is no capture at all", async () => {
    expect(await attachScreenFrame(undefined, "hello")).toEqual({
      text: "hello",
    })
    expect(await attachScreenFrame(null, "hello")).toEqual({ text: "hello" })
  })

  it("attaches the frame and names the sharer", async () => {
    const result = await attachScreenFrame(fakeScreen(frame), "what's this?")
    expect(result.images).toEqual([{ mediaType: "image/jpeg", data: "BASE64" }])
    expect(result.text).toBe(
      "[A current frame of Amin's shared screen is attached.]\nwhat's this?",
    )
  })

  it("tells the model the image is there, not just the brain", async () => {
    // The image alone isn't enough — a model that isn't told it received a
    // screenshot describes the conversation instead of the screen.
    const { text } = await attachScreenFrame(fakeScreen(frame), "q")
    expect(text.startsWith("[A current frame")).toBe(true)
    expect(text.endsWith("q")).toBe(true)
  })

  it("degrades to a plain turn when encoding fails", async () => {
    // A broken frame must not take the whole turn down with it — the agent
    // should answer without the picture rather than not answer at all.
    const result = await attachScreenFrame(
      fakeScreen(frame, { throws: true }),
      "still answer me",
    )
    expect(result).toEqual({ text: "still answer me" })
  })
})

// ---- ScreenCapture against a fake room ------------------------------------
// The room is an EventEmitter shaped like rtc-node's Room, and the frame
// stream is injected — so subscription handling, the restart loop, and the
// encode path run for real without a live LiveKit server.

type FakeParticipant = {
  name: string
  identity: string
  trackPublications: Map<string, FakePublication>
}
type FakePublication = {
  source: number
  subscribed: boolean
  track: FakeTrack | undefined
}
type FakeTrack = { kind: number; sid: string }

function fakeRoom(participants: FakeParticipant[] = []) {
  const room = new EventEmitter() as EventEmitter & {
    remoteParticipants: Map<string, FakeParticipant>
  }
  room.remoteParticipants = new Map(participants.map((p) => [p.identity, p]))
  return room
}

const screenTrack = (sid: string): FakeTrack => ({
  kind: TrackKind.KIND_VIDEO,
  sid,
})
const screenPub = (track?: FakeTrack): FakePublication => ({
  source: TrackSource.SOURCE_SCREENSHARE,
  subscribed: track !== undefined,
  track,
})

const rgbaFrame = (width = 4, height = 2) =>
  new VideoFrame(
    new Uint8Array(width * height * 4).fill(128),
    width,
    height,
    VideoBufferType.RGBA,
  )

/**
 * An injectable frame stream: yields the given frames, then either stays
 * open until cancelled (a live share) or ends (a dying stream).
 */
function frameStream(frames: VideoFrame[], { end = false } = {}) {
  let release: () => void = () => undefined
  const cancelled = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield { frame }
      if (!end) await cancelled
    },
    cancel: async () => release(),
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

// biome-ignore lint/suspicious/noExplicitAny: fakes stand in for rtc-node types
const capture = (
  room: any,
  opts: ConstructorParameters<typeof ScreenCapture>[2],
) => new ScreenCapture(room, true, opts)

describe("ScreenCapture", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("latches frames from a screenshare subscribed after construction", async () => {
    const room = fakeRoom()
    const screen = capture(room, {
      makeStream: () => frameStream([rgbaFrame()]),
    })
    expect(screen.active).toBe(false)
    room.emit("trackSubscribed", screenTrack("t1"), screenPub(), {
      name: "Amin",
      identity: "human-1",
    })
    await tick()
    expect(screen.active).toBe(true)
    expect(screen.sharerName).toBe("Amin")
  })

  it("sweeps a screenshare that was already subscribed at construction", async () => {
    // The window this closes: any future await between room connect and
    // ScreenCapture construction would silently lose pre-existing shares.
    const track = screenTrack("t1")
    const room = fakeRoom([
      {
        name: "Amin",
        identity: "human-1",
        trackPublications: new Map([["t1", screenPub(track)]]),
      },
    ])
    const screen = capture(room, {
      makeStream: () => frameStream([rgbaFrame()]),
    })
    await tick()
    expect(screen.active).toBe(true)
    expect(screen.sharerName).toBe("Amin")
  })

  it("ignores camera tracks", async () => {
    const room = fakeRoom()
    const screen = capture(room, {
      makeStream: () => frameStream([rgbaFrame()]),
    })
    room.emit(
      "trackSubscribed",
      screenTrack("t1"),
      { source: TrackSource.SOURCE_CAMERA, subscribed: true },
      { name: "Amin", identity: "human-1" },
    )
    await tick()
    expect(screen.active).toBe(false)
  })

  it("clears the frame when its own track unsubscribes, not another's", async () => {
    const room = fakeRoom()
    const screen = capture(room, {
      makeStream: () => frameStream([rgbaFrame()]),
    })
    const first = screenTrack("t1")
    const second = screenTrack("t2")
    room.emit("trackSubscribed", first, screenPub(), {
      name: "Amin",
      identity: "human-1",
    })
    await tick()
    room.emit("trackSubscribed", second, screenPub(), {
      name: "Bea",
      identity: "human-2",
    })
    await tick()
    expect(screen.sharerName).toBe("Bea")
    // The takeover window: the old share unsubscribing must not blank out
    // the frame the new share already latched.
    room.emit("trackUnsubscribed", first)
    expect(screen.active).toBe(true)
    expect(screen.sharerName).toBe("Bea")
    room.emit("trackUnsubscribed", second)
    expect(screen.active).toBe(false)
  })

  it("reopens a frame stream that dies while the track is subscribed", async () => {
    vi.useFakeTimers()
    const streams = [
      frameStream([rgbaFrame()], { end: true }),
      frameStream([rgbaFrame(8, 4)]),
    ]
    let opened = 0
    const room = fakeRoom()
    const screen = capture(room, {
      // biome-ignore lint/style/noNonNullAssertion: two streams, two opens
      makeStream: () => streams[opened++]!,
    })
    room.emit("trackSubscribed", screenTrack("t1"), screenPub(), {
      name: "Amin",
      identity: "human-1",
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.active).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(opened).toBe(2)
    expect(screen.active).toBe(true)
  })

  it("gives up on a track whose stream never produces frames", async () => {
    vi.useFakeTimers()
    let opened = 0
    const log: string[] = []
    const room = fakeRoom()
    capture(room, {
      makeStream: () => {
        opened++
        return frameStream([], { end: true })
      },
      log: (_level, message) => log.push(message),
    })
    room.emit("trackSubscribed", screenTrack("t1"), screenPub(), {
      name: "Amin",
      identity: "human-1",
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(opened).toBe(3)
    expect(log.some((m) => m.includes("giving up"))).toBe(true)
  })

  it("encodes the latched frame to a JPEG naming the sharer", async () => {
    const room = fakeRoom()
    const screen = capture(room, {
      makeStream: () => frameStream([rgbaFrame(16, 8)]),
    })
    room.emit("trackSubscribed", screenTrack("t1"), screenPub(), {
      name: "Amin",
      identity: "human-1",
    })
    await tick()
    const jpeg = await screen.latestJpeg()
    expect(jpeg).not.toBeNull()
    expect(jpeg?.mediaType).toBe("image/jpeg")
    expect(jpeg?.sharerName).toBe("Amin")
    expect(Buffer.from(jpeg?.data ?? "", "base64").subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    )
  })

  it("logs and returns null when encoding fails instead of hiding it", async () => {
    const log: string[] = []
    const room = fakeRoom()
    // A frame whose claimed dimensions exceed its buffer makes sharp fail.
    const broken = new VideoFrame(
      new Uint8Array(16),
      64,
      64,
      VideoBufferType.RGBA,
    )
    const screen = capture(room, {
      makeStream: () => frameStream([broken]),
      log: (_level, message) => log.push(message),
    })
    room.emit("trackSubscribed", screenTrack("t1"), screenPub(), {
      name: "Amin",
      identity: "human-1",
    })
    await tick()
    expect(await screen.latestJpeg()).toBeNull()
    expect(log.some((m) => m.includes("encoding"))).toBe(true)
  })

  it("stays inert when the deployment turns vision off", async () => {
    const room = fakeRoom()
    let opened = 0
    const screen = new ScreenCapture(
      // biome-ignore lint/suspicious/noExplicitAny: fake room
      room as any,
      false,
      {
        makeStream: () => {
          opened++
          return frameStream([rgbaFrame()])
        },
      },
    )
    room.emit("trackSubscribed", screenTrack("t1"), screenPub(), {
      name: "Amin",
      identity: "human-1",
    })
    await tick()
    expect(opened).toBe(0)
    expect(screen.active).toBe(false)
    expect(await screen.latestJpeg()).toBeNull()
  })
})
