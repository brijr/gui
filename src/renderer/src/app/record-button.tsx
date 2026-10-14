import { fixWebmDuration } from '@fix-webm-duration/fix'
import { useEffect, useRef, useState } from 'react'
import type { WindowState } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { CircleDot, Square, X } from '../lib/icons'
import { Button } from '../lib/ui'

const MAX_DURATION = 60_000
const MAX_BYTES = 32 * 1024 * 1024

export function RecordButton({ state, disabled }: { state: WindowState; disabled: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'saving'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const stop = useRef<(() => void) | null>(null)
  const busy = useRef(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => () => stop.current?.(), [])
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 8000)
    // Like a notice, it goes with Esc or a click anywhere else.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setError(null)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setError(null)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [error])

  const start = async () => {
    if (busy.current) return
    busy.current = true
    setPhase('starting')
    setError(null)
    let id: string | null = null
    let stream: MediaStream | null = null
    let interval: ReturnType<typeof setInterval> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let off: (() => void) | undefined
    let failure: string | null = null
    try {
      id = await gui.startRecording()
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { max: 30 }, width: { max: 1920 }, height: { max: 1920 } },
        audio: false,
      })
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
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
        (type) => MediaRecorder.isTypeSupported(type),
      )
      if (!mimeType) throw new Error('Video recording is unavailable.')
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_000_000 })
      const chunks: Blob[] = []
      let bytes = 0
      let stopping = false
      let pending: Promise<void> = Promise.resolve()
      let capturing = false
      let last = -Infinity
      const started = performance.now()
      let mediaOrigin: number | null = null
      let firstFrameMs = 0
      let durationMs = 0
      const recordingId = id
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not capture preview frames.')
      const finish = () => {
        if (stopping) return
        stopping = true
        durationMs = Math.min(MAX_DURATION + 1000, Math.max(performance.now() - started, last))
        setPhase('saving')
        clearInterval(interval)
        clearTimeout(deadline)
        off?.()
        if (recorder.state !== 'inactive') recorder.stop()
        for (const track of stream?.getTracks() ?? []) track.stop()
      }
      stop.current = finish
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return
        bytes += event.data.size
        if (bytes > MAX_BYTES) {
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
          )
        } catch (cause) {
          await gui.discardRecording(recordingId).catch(() => undefined)
          setError(cause instanceof Error ? cause.message : 'Could not save the recording.')
        } finally {
          video.srcObject = null
          stop.current = null
          busy.current = false
          setElapsed(0)
          setPhase('idle')
        }
      }
      const frame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (stopping) return
        if (mediaOrigin === null) {
          mediaOrigin = metadata.mediaTime
          firstFrameMs = Math.max(0, performance.now() - started)
        }
        const at =
          Math.round(((metadata.mediaTime - mediaOrigin) * 1000 + firstFrameMs) * 100) / 100
        if (!capturing && at >= 0 && at <= MAX_DURATION && at - last >= 1000 / 30 - 1) {
          capturing = true
          last = at
          const scale = Math.min(1, 1568 / Math.max(video.videoWidth, video.videoHeight))
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
          context.drawImage(video, 0, 0, canvas.width, canvas.height)
          pending = new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
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
        video.requestVideoFrameCallback(frame)
      }
      recorder.start(1000)
      video.requestVideoFrameCallback(frame)
      for (const track of stream.getTracks()) track.onended = finish
      off = gui.onState((next) => {
        if (
          next.activeTab !== state.activeTab ||
          next.project?.root !== state.project?.root ||
          !next.preview.selectable ||
          !next.preview.visible
        )
          finish()
      })
      interval = setInterval(() => setElapsed(performance.now() - started), 250)
      deadline = setTimeout(finish, MAX_DURATION)
      setPhase('recording')
    } catch (cause) {
      clearInterval(interval)
      clearTimeout(deadline)
      off?.()
      for (const track of stream?.getTracks() ?? []) track.stop()
      if (id) await gui.discardRecording(id).catch(() => undefined)
      busy.current = false
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
  return (
    <div ref={root} className="relative no-drag flex items-center">
      <Button
        variant="ghost"
        icon={recording ? Square : CircleDot}
        disabled={phase === 'starting' || phase === 'saving' || (disabled && !recording)}
        onClick={() => (recording ? stop.current?.() : void start())}
        title={recording ? 'Stop preview recording' : 'Record preview'}
        aria-label={recording ? 'Stop preview recording' : 'Record preview'}
        // Its keys after the icon, like the toolbar's other tools.
        shortcut="recordPreview"
        // The seconds count up in place rather than shifting the button's width.
        // Spaced like the toolbar's other tools: the icon, then its keys.
        className={cn('pr-1.5 pl-2', recording && 'text-danger tabular-nums')}
      >
        {recording
          ? `${Math.floor(elapsed / 1000)}s`
          : phase === 'saving'
            ? 'Saving…'
            : phase === 'starting'
              ? 'Starting…'
              : null}
      </Button>
      {/* In the toolbar itself: anything hanging below it would sit under the preview, a
          native view drawn over this page. The reason is announced and in the tooltip. */}
      {error && (
        <>
          <span role="alert" className="sr-only">
            Couldn't record: {error}
          </span>
          <Button
            variant="danger"
            size="sm"
            trailingIcon={X}
            title={`${error} Click to dismiss.`}
            onClick={() => setError(null)}
            className="ml-1"
          >
            Couldn't record
          </Button>
        </>
      )}
    </div>
  )
}
