import {
  defineAgent,
  type JobContext,
  type JobProcess,
  type JobRequest,
} from "@livekit/agents"
import {
  AudioStream,
  type RemoteParticipant,
  type RemoteTrack,
  TrackKind,
} from "@livekit/rtc-node"
import {
  type ParticipantMeta,
  parseParticipantMeta,
  TRANSCRIPTION_TOPIC,
} from "@meet/shared"
import {
  type Denoiser,
  type Finalizer,
  loadDenoiserFactory,
  loadFinalizer,
  loadSttEngine,
  STT_SAMPLE_RATE,
  type SttEngine,
} from "./stt.js"

/** Utterances longer than this are finalized from the streaming text. */
const MAX_FINALIZE_SECONDS = 60

// The platform transcriber: a hidden service participant that joins every
// room, runs local streaming STT (sherpa-onnx) over every human mic, and
// publishes live transcription segments attributed to the speaker — the
// web's useTranscriptions() renders them with no agent in the room at all.

/** Throttle interim updates so the UI isn't spammed on every decode step. */
const INTERIM_INTERVAL_MS = 300

export async function acceptTranscriberRequest(
  request: JobRequest,
): Promise<void> {
  const meta: ParticipantMeta = { kind: "service", service: "transcriber" }
  await request.accept("Transcriber", "svc-transcriber", JSON.stringify(meta))
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.stt = await loadSttEngine()
    proc.userData.denoiser = await loadDenoiserFactory()
    // The finalizer (Parakeet, ~1 GB resident) loads lazily when a room
    // actually starts — idle pool processes stay light.
  },
  entry: async (ctx: JobContext) => {
    const engine = ctx.proc.userData.stt as
      | SttEngine
      | { error: string }
      | undefined
    if (!engine || "error" in engine) {
      console.error(`transcriber disabled: ${engine?.error ?? "no engine"}`)
      return
    }

    const makeDenoiser = ctx.proc.userData.denoiser as
      | (() => Denoiser)
      | null
      | undefined
    // Kick off the heavyweight finalizer load now that this process serves a
    // real room; interim text flows immediately and finals upgrade once the
    // model is ready (streaming text is used until then).
    if (!ctx.proc.userData.finalizerLoading) {
      ctx.proc.userData.finalizerLoading = loadFinalizer()
    }
    let finalizer: Finalizer | null = null
    void (ctx.proc.userData.finalizerLoading as Promise<Finalizer | null>).then(
      (f) => {
        finalizer = f
      },
    )

    await ctx.connect()
    const local = ctx.room.localParticipant
    if (!local) throw new Error("no local participant")

    let nextSegment = 0

    const transcribe = (
      track: RemoteTrack,
      participant: RemoteParticipant,
      trackSid: string,
    ) => {
      const stream = new AudioStream(track, {
        sampleRate: STT_SAMPLE_RATE,
        numChannels: 1,
      })
      const stt = engine.createStream()
      // Per-speaker streaming noise suppression ahead of recognition, when
      // the GTCRN model is present. A denoiser failure must not stop
      // transcription — fall back to raw audio.
      let denoiser: Denoiser | null = null
      try {
        denoiser = makeDenoiser?.() ?? null
      } catch (err) {
        console.error(`denoiser disabled: ${(err as Error).message}`)
      }

      const publish = async (
        text: string,
        segmentId: string,
        final: boolean,
      ) => {
        try {
          const writer = await local.streamText({
            topic: TRANSCRIPTION_TOPIC,
            senderIdentity: participant.identity,
            attributes: {
              "lk.transcribed_track_id": trackSid,
              "lk.segment_id": segmentId,
              "lk.transcription_final": String(final),
            },
          })
          await writer.write(text)
          await writer.close()
        } catch {
          // room is closing or stream failed; nothing to do
        }
      }

      void (async () => {
        const reader = stream.getReader()
        let segmentId = `seg-${participant.identity}-${nextSegment++}`
        let lastInterim = 0
        let lastText = ""
        // The current utterance's audio, kept so the finalizer can
        // re-transcribe it accurately (casing + punctuation) at endpoint.
        let utterance: Float32Array[] = []
        let utteranceLen = 0
        const maxLen = MAX_FINALIZE_SECONDS * STT_SAMPLE_RATE

        const finalText = (streamingText: string): string => {
          if (!finalizer || utteranceLen === 0 || utteranceLen > maxLen) {
            return streamingText
          }
          const joined = new Float32Array(utteranceLen)
          let offset = 0
          for (const chunk of utterance) {
            joined.set(chunk, offset)
            offset += chunk.length
          }
          try {
            return finalizer.transcribe(joined) || streamingText
          } catch {
            return streamingText
          }
        }

        try {
          while (true) {
            const { value: frame, done } = await reader.read()
            if (done) break
            let samples: Float32Array<ArrayBufferLike> = new Float32Array(
              frame.data.length,
            )
            for (let i = 0; i < frame.data.length; i++) {
              samples[i] = frame.data[i] / 32768
            }
            if (denoiser) samples = denoiser.process(samples)
            if (samples.length === 0) continue
            stt.accept(samples)
            if (utteranceLen <= maxLen) {
              const copy = new Float32Array(samples)
              utterance.push(copy)
              utteranceLen += copy.length
            }

            const text = stt.text()
            if (stt.endpoint()) {
              if (text && text !== "") {
                await publish(finalText(text), segmentId, true)
              }
              stt.reset()
              segmentId = `seg-${participant.identity}-${nextSegment++}`
              lastText = ""
              utterance = []
              utteranceLen = 0
              continue
            }
            const now = Date.now()
            if (
              text &&
              text !== lastText &&
              now - lastInterim > INTERIM_INTERVAL_MS
            ) {
              lastInterim = now
              lastText = text
              await publish(text, segmentId, false)
            }
          }
        } catch {
          // track ended mid-read
        } finally {
          const text = stt.text()
          if (text) await publish(finalText(text), segmentId, true)
          stt.free()
        }
      })()
    }

    const shouldTranscribe = (participant: RemoteParticipant) => {
      const meta = parseParticipantMeta(participant.metadata)
      // Agents publish their own transcriptions; other services have no voice.
      return !meta || meta.kind === "human"
    }

    ctx.room.on("trackSubscribed", (track, pub, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return
      if (!shouldTranscribe(participant)) return
      transcribe(track, participant, pub.sid ?? track.sid ?? "")
    })
    for (const participant of ctx.room.remoteParticipants.values()) {
      if (!shouldTranscribe(participant)) continue
      for (const pub of participant.trackPublications.values()) {
        const t = pub.track
        if (t && t.kind === TrackKind.KIND_AUDIO) {
          transcribe(t, participant, pub.sid ?? t.sid ?? "")
        }
      }
    }
  },
})
