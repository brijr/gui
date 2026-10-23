import { fixWebmDuration } from '@fix-webm-duration/fix'
import { useEffect, useRef, useState } from 'react'
import {
  MAX_NARRATED_RECORDING_MS,
  MAX_RECORDING_MS,
  MAX_RECORDING_VIDEO_BYTES,
  NARRATED_RECORDING_FPS,
  RECORDING_FPS,
} from '../../../shared/bounded'
import type { WindowState } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { CircleDot, Mic, MicOff, Square, X } from '../lib/icons'
import { Button, PRESS } from '../lib/ui'
import { PointerOverlay } from './recording-pointer'
import { captureVoice, type Voice } from './recording-voice'

/** Frames for the agent are at most this many pixels on their longer side. */
const FRAME_SIZE = 1568
/** The clip itself, as played back. */
const VIDEO_SIZE = 1920
const NARRATE_KEY = 'gui:narrate-recordings'

function savedNarrate() {
  try {
    return localStorage.getItem(NARRATE_KEY) === 'true'
  } catch {
    return false
  }
}

export function RecordButton({ state, disabled }: { state: WindowState; disabled: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'saving'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState<number | null>(null)
  const [narrate, setNarrate] = useState(savedNarrate)
  const [error, setError] = useState<string | null>(null)
  /** Recording goes on, but without the user's voice: why */
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null)
  const stop = useRef<(() => void) | null>(null)
  const busy = useRef(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => () => stop.current?.(), [])
  const shown = error ?? voiceNotice
  const dismiss = () => {
    setError(null)
    setVoiceNotice(null)
  }
  useEffect(() => {
    if (!shown) return
    const clear = () => {
      setError(null)
      setVoiceNotice(null)
    }
    const timer = setTimeout(clear, 8000)
    // Like a notice, it goes with Esc or a click anywhere else.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clear()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) clear()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [shown])

  const toggleNarrate = () => {
    const next = !narrate
    setNarrate(next)
    try {
      localStorage.setItem(NARRATE_KEY, String(next))
    } catch {}
  }

  const start = async () => {
    if (busy.current) return
    busy.current = true
    setPhase('starting')
    setError(null)
    setVoiceNotice(null)
    let id: string | null = null
    let stream: MediaStream | null = null
    let voice: Voice | null = null
    let interval: ReturnType<typeof setInterval> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let offs: (() => void)[] = []
    let failure: string | null = null
    try {
      const armed = await gui.startRecording(narrate)
      id = armed.id
      if (armed.notice) setVoiceNotice(armed.notice)
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { max: 30 }, width: { max: 1920 }, height: { max: 1920 } },
        audio: false,
      })
      if (armed.narrated) {
        voice = await captureVoice().catch((cause: unknown) => {
          setVoiceNotice(
            cause instanceof Error && cause.name === 'NotAllowedError'
              ? 'Gui can’t use the microphone. Recording without your voice.'
              : `Recording without your voice: ${cause instanceof Error ? cause.message : 'the microphone is unavailable.'}`,
          )
          return null
        })
      }
      const narrated = voice !== null
      const maxDuration = narrated ? MAX_NARRATED_RECORDING_MS : MAX_RECORDING_MS
      const fps = narrated ? NARRATED_RECORDING_FPS : RECORDING_FPS
      const video = document.createElement('video')
      video.muted = true
      video.srcObject = stream
      await video.play()
      const current = await gui.getState()
      if (
        current.activeTab !== state.activeTab ||
        current.project?.root !== state.project?.root ||
        !current.preview.selectable
      )
        throw new Error('Preview changed while recording was starting.')
      const mimeType = (
        narrated
          ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
          : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      ).find((type) => MediaRecorder.isTypeSupported(type))
      if (!mimeType) throw new Error('Video recording is unavailable.')

      // The page's frames with the pointer drawn on top: the clip records this canvas.
      const fit = Math.min(1, VIDEO_SIZE / Math.max(video.videoWidth, video.videoHeight, 1))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(2, Math.round((video.videoWidth * fit) / 2) * 2)
      canvas.height = Math.max(2, Math.round((video.videoHeight * fit) / 2) * 2)
      const context = canvas.getContext('2d')
      const shrink = Math.min(1, FRAME_SIZE / Math.max(canvas.width, canvas.height))
      const still = document.createElement('canvas')
      still.width = Math.max(1, Math.round(canvas.width * shrink))
      still.height = Math.max(1, Math.round(canvas.height * shrink))
      const stillContext = still.getContext('2d')
      if (!context || !stillContext) throw new Error('Could not capture preview frames.')
      // Canvas pixels per CSS pixel of the page: the capture is in device pixels.
      const unit = (canvas.width / Math.max(1, video.videoWidth)) * window.devicePixelRatio
      const pointer = new PointerOverlay()
      const recordingId = id
      offs.push(
        gui.onRecordingCursor((cursor) => {
          if (cursor.id === recordingId) pointer.set(cursor)
        }),
      )
      const composed = canvas.captureStream(30)
      const tracks = [...composed.getVideoTracks(), ...(voice ? [voice.track] : [])]
      const recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType,
        videoBitsPerSecond: narrated ? 2_000_000 : 3_000_000,
      })
      const chunks: Blob[] = []
      let bytes = 0
      let stopping = false
      let pending: Promise<void> = Promise.resolve()
      let capturing = false
      let last = -Infinity
      let fresh = true
      const started = performance.now()
      let durationMs = 0
      const finish = () => {
        if (stopping) return
        stopping = true
        durationMs = Math.min(maxDuration + 1000, Math.max(performance.now() - started, last))
        setPhase('saving')
        clearInterval(interval)
        clearTimeout(deadline)
        for (const off of offs) off()
        offs = []
        if (recorder.state !== 'inactive') recorder.stop()
        for (const track of stream?.getTracks() ?? []) track.stop()
        for (const track of composed.getTracks()) track.stop()
      }
      stop.current = finish
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return
        bytes += event.data.size
        if (bytes > MAX_RECORDING_VIDEO_BYTES) {
          failure = 'Recording reached its size limit. Please record a shorter clip.'
          finish()
          return
        }
        chunks.push(event.data)
      }
      recorder.onerror = () => {
        failure = 'Could not encode the recording.'
        finish()
      }
      recorder.onstop = async () => {
        try {
          await pending
          const audio = voice ? await voice.finish().catch(() => null) : null
          if (failure) throw new Error(failure)
          const blob = await fixWebmDuration(new Blob(chunks, { type: mimeType }), durationMs, {
            logger: false,
          })
          // Release the capture before main gives the keyboard to the chat.
          video.srcObject = null
          await gui.finishRecording(
            recordingId,
            durationMs,
            new Uint8Array(await blob.arrayBuffer()),
            performance.timeOrigin + started,
            audio,
          )
        } catch (cause) {
          await gui.discardRecording(recordingId).catch(() => undefined)
          setError(cause instanceof Error ? cause.message : 'Could not save the recording.')
        } finally {
          voice?.dispose()
          video.srcObject = null
          stop.current = null
          busy.current = false
          setElapsed(0)
          setLevel(null)
          setPhase('idle')
        }
      }
      // A new frame from the page, or the pointer moved: draw it, and keep a still of it
      // for the agent at most `fps` times a second.
      const draw = () => {
        if (stopping) return
        const moved = pointer.takeChanged()
        if (!fresh && !moved) return
        fresh = false
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        pointer.draw(context, canvas.width, canvas.height, unit)
        const at = Math.round((performance.now() - started) * 100) / 100
        if (capturing || at > maxDuration || at - last < 1000 / fps - 1) return
        capturing = true
        last = at
        stillContext.drawImage(canvas, 0, 0, still.width, still.height)
        pending = new Promise<Blob>((resolve, reject) =>
          still.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode a frame.'))),
            'image/jpeg',
            0.88,
          ),
        )
          .then(async (blob) => {
            const accepted = await gui.saveRecordingFrame(
              recordingId,
              at,
              new Uint8Array(await blob.arrayBuffer()),
            )
            if (!accepted && !stopping) {
              failure = 'Recording interrupted because the preview became unavailable.'
              finish()
            }
          })
          .catch((cause: unknown) => {
            failure = cause instanceof Error ? cause.message : 'Could not save frames.'
            finish()
          })
          .finally(() => {
            capturing = false
          })
      }
      const onFrame = () => {
        if (stopping) return
        fresh = true
        video.requestVideoFrameCallback(onFrame)
      }
      video.requestVideoFrameCallback(onFrame)
      draw()
      recorder.start(1000)
      voice?.start()
      for (const track of stream.getTracks()) track.onended = finish
      offs.push(
        gui.onState((next) => {
          if (
            next.activeTab !== state.activeTab ||
            next.project?.root !== state.project?.root ||
            !next.preview.selectable ||
            !next.preview.visible
          )
            finish()
        }),
      )
      let ticks = 0
      interval = setInterval(() => {
        draw()
        if (++ticks % 4) return
        setElapsed(performance.now() - started)
        if (voice) setLevel(voice.level())
      }, 1000 / 30)
      deadline = setTimeout(finish, maxDuration)
      setPhase('recording')
    } catch (cause) {
      clearInterval(interval)
      clearTimeout(deadline)
      for (const off of offs) off()
      for (const track of stream?.getTracks() ?? []) track.stop()
      voice?.dispose()
      if (id) await gui.discardRecording(id).catch(() => undefined)
      busy.current = false
      setLevel(null)
      setPhase('idle')
      setError(cause instanceof Error ? cause.message : 'Could not start recording.')
    }
  }

  // ⌥⌘R, from main as a user gesture (window.ts `recordPreview`): the same as a click.
  const toggle = useRef(() => {})
  toggle.current = () => {
    if (phase === 'recording') stop.current?.()
    else if (phase === 'idle' && !disabled) void start()
  }
  useEffect(() => {
    const onRecord = () => toggle.current()
    window.addEventListener('gui:record', onRecord)
    return () => window.removeEventListener('gui:record', onRecord)
  }, [])

  const recording = phase === 'recording'
  const label = recording
    ? 'Stop preview recording'
    : narrate
      ? 'Record preview with your voice'
      : 'Record preview'
  const idle = phase === 'idle'
  return (
    <div ref={root} className="relative no-drag flex items-center">
      {/* Record and its mic are one control, highlighted together on hover. The mic shows
          whether recordings are narrated: tinted while on, struck through while off. */}
      <div className="group/record flex h-7 items-center rounded-md transition-colors has-[button:enabled:hover]:bg-hover">
        <Button
          variant="ghost"
          icon={recording ? Square : CircleDot}
          disabled={phase === 'starting' || phase === 'saving' || (disabled && !recording)}
          onClick={() => (recording ? stop.current?.() : void start())}
          title={label}
          aria-label={label}
          // Its keys after the icon, like the toolbar's other tools.
          shortcut="recordPreview"
          // The seconds count up in place rather than shifting the button's width.
          className={cn(
            'pr-1.5 pl-2 enabled:hover:bg-transparent group-has-[button:enabled:hover]/record:text-fg',
            recording && 'text-danger tabular-nums',
          )}
        >
          {recording
            ? `${Math.floor(elapsed / 1000)}s`
            : phase === 'saving'
              ? 'Saving…'
              : phase === 'starting'
                ? 'Starting…'
                : null}
        </Button>
        {!recording && (
          <button
            type="button"
            aria-label="Narrate recordings"
            aria-pressed={narrate}
            title={
              narrate
                ? 'Recordings include your voice, transcribed for the agent. Click to turn off.'
                : 'Talk while you record: your voice is transcribed for the agent. Click to turn on.'
            }
            disabled={!idle}
            onClick={toggleNarrate}
            className={cn(
              'mr-0.5 -ml-0.5 flex size-6 shrink-0 items-center justify-center rounded transition-colors disabled:opacity-40',
              PRESS,
              narrate ? 'bg-accent-soft text-accent-text' : 'text-subtle hover:text-fg',
            )}
          >
            {narrate ? (
              <Mic className="size-3.5" aria-hidden="true" />
            ) : (
              <MicOff className="size-3.5" aria-hidden="true" />
            )}
          </button>
        )}
        {recording && level !== null && (
          // The mic is hearing them: a level that moves as they talk.
          <span
            role="img"
            aria-label="Microphone on"
            title="Recording your voice"
            className="mr-1 flex h-7 items-center gap-1 text-danger"
          >
            <Mic className="size-3.5" aria-hidden="true" />
            <span className="h-1 w-6 overflow-hidden rounded-full bg-hover">
              <span
                className="block h-full rounded-full bg-current transition-[width] duration-100"
                style={{ width: `${Math.round(Math.max(0.08, level) * 100)}%` }}
              />
            </span>
          </span>
        )}
      </div>
      {/* In the toolbar itself: anything hanging below it would sit under the preview, a
          native view drawn over this page. The reason is announced and in the tooltip. */}
      {shown && (
        <>
          <span role="alert" className="sr-only">
            {error ? "Couldn't record" : 'Recording without your voice'}: {shown}
          </span>
          <Button
            variant="danger"
            size="sm"
            trailingIcon={X}
            title={`${shown} Click to dismiss.`}
            onClick={dismiss}
            className="ml-1"
          >
            {error ? "Couldn't record" : 'No voice'}
          </Button>
        </>
      )}
    </div>
  )
}
