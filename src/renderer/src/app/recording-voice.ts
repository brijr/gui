import { MAX_RECORDING_AUDIO_BYTES } from '../../../shared/bounded'

/**
 * The user's voice for a narrated recording: a track to mux into the clip (so it plays back
 * with sound), a level for the meter, and at the end a 16 kHz mono WAV for transcription.
 */
export interface Voice {
  track: MediaStreamTrack
  /** How loud it is right now, 0 to 1 */
  level(): number
  /** Starts keeping what's said; call as the video recorder starts, so both share time 0. */
  start(): void
  /** Stops the mic and gives what was said as WAV, or null if nothing was kept. */
  finish(): Promise<Uint8Array | null>
  dispose(): void
}

const SAMPLE_RATE = 16_000

export async function captureVoice(): Promise<Voice> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  })
  const [track] = stream.getAudioTracks()
  if (!track) {
    for (const each of stream.getTracks()) each.stop()
    throw new Error('No microphone found.')
  }
  const context = new AudioContext()
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  context.createMediaStreamSource(stream).connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  )
  if (!mimeType) {
    for (const each of stream.getTracks()) each.stop()
    void context.close()
    throw new Error('Audio recording is unavailable.')
  }
  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data)
  }
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (recorder.state !== 'inactive') recorder.stop()
    for (const each of stream.getTracks()) each.stop()
    void context.close().catch(() => undefined)
  }
  return {
    track,
    level() {
      if (disposed) return 0
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += sample * sample
      // Speech sits around 0.02–0.2 RMS; this spreads it over the meter.
      return Math.min(1, Math.sqrt(sum / samples.length) * 6)
    },
    start() {
      if (!disposed && recorder.state === 'inactive') recorder.start(1000)
    },
    async finish() {
      if (disposed || recorder.state === 'inactive') {
        dispose()
        return null
      }
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
      })
      recorder.stop()
      await stopped
      dispose()
      if (!chunks.length) return null
      return toWav(await new Blob(chunks, { type: mimeType }).arrayBuffer())
    },
    dispose,
  }
}

/** Decodes the recorded audio and resamples it to 16 kHz mono 16-bit WAV. */
async function toWav(encoded: ArrayBuffer): Promise<Uint8Array | null> {
  const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE)
  const decoded = await decoder.decodeAudioData(encoded)
  const length = Math.ceil(decoded.duration * SAMPLE_RATE)
  if (length <= 0) return null
  const offline = new OfflineAudioContext(1, length, SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const pcm = (await offline.startRendering()).getChannelData(0)
  const bytes = 44 + pcm.length * 2
  if (bytes > MAX_RECORDING_AUDIO_BYTES) throw new Error('Narration is too long to transcribe.')
  const out = new DataView(new ArrayBuffer(bytes))
  const ascii = (at: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      out.setUint8(at + index, text.charCodeAt(index))
  }
  ascii(0, 'RIFF')
  out.setUint32(4, bytes - 8, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true)
  out.setUint16(22, 1, true)
  out.setUint32(24, SAMPLE_RATE, true)
  out.setUint32(28, SAMPLE_RATE * 2, true)
  out.setUint16(32, 2, true)
  out.setUint16(34, 16, true)
  ascii(36, 'data')
  out.setUint32(40, pcm.length * 2, true)
  for (let index = 0; index < pcm.length; index++) {
    const sample = Math.max(-1, Math.min(1, pcm[index]))
    out.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Uint8Array(out.buffer)
}
