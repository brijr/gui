# Narrated preview recordings: plan

Status: built (steps 1–4), not yet tried with a live microphone in the app. The whisper.cpp fallback (step 5) is not built.

## What was built

- **Recording.** The **Narrate** toggle (mic icon next to Record preview) is saved in the window's localStorage.
  - With it on, main asks macOS for the mic (`systemPreferences`) and arms one `getUserMedia` audio request for Gui's window only (`index.ts`).
  - The renderer records the voice (`app/recording-voice.ts`). It's muxed as Opus into the playback webm, and decoded to a 16 kHz WAV for transcription.
  - Narrated clips run up to 3 minutes and keep 10 frames/s. Silent ones keep 60 s and 30 frames/s. Limits are in `shared/bounded.ts`.
- **Pointer.**
  - `main/recording-cursor.ts` polls the pointer over the preview (60 Hz) and picks up button presses from `input-event`. It logs samples, pauses ("dwells", ≥ 400 ms still), and the element under the pointer (the tracer's new `at(x, y)`). It streams the position to the recorder.
  - The recorder draws every frame onto a canvas, with the pointer as a ring, a dot, and a ripple on press (`app/recording-pointer.ts`). It records that canvas (`canvas.captureStream`), so the clip and the agent's frames both show the pointer.
- **Transcript.**
  - `native/transcribe/main.swift` (built by `scripts/build-native.sh`, run by `main/transcribe.ts`) uses SpeechAnalyzer on device. It gives sentences with word times; about 0.5 s for a 5 s clip.
  - `Recordings` transcribes in the background after the clip is saved. It writes `transcript.json` and `captions.vtt`, deletes the WAV, and sends the updated clip to the chat (`recording:update`).
  - While a clip is transcribing, the composer says "Transcribing…" and Send waits. Then, if nothing's typed, the transcript becomes the message.
- **Agent.** `main/recording-prompt.ts` sends the following:
  - What the user said, as their request.
  - A narration that pairs each sentence with where the pointer was (`main/recording-narration.ts`, fenced, because element names come from the page).
  - The timeline as before.
  - Up to 8 frames picked at pointing words, pauses, clicks and mid-sentence, each labeled with the words and the pointer.
  - A new MCP tool, `recording_narration`, reads it by time range. Silent clips keep their first/middle/last frames.
- **Playback.** Narrated clips play with sound and captions (a `<track>` from `gui-recording://…/captions.vtt`; the scheme now sends CORS headers).
- **Needs human review (AGENTS.md):**
  - `NSMicrophoneUsageDescription` / `NSSpeechRecognitionUsageDescription` in `electron-builder.yml`.
  - `com.apple.security.device.audio-input` in both entitlements plists.
  - The helper packaged to `Contents/Resources/bin/gui-transcribe`, signed by osx-sign with the app.

Verified:
- `bun run check`, including new tests (`tests/recording-narration.test.ts`; `tests/transcribe.test.ts`, which runs the real helper on `say` speech).
- `bun run build`.
- A scratch Electron run of the renderer audio path: an Opus stream became a 16 kHz WAV, then a word-timed transcript, and VP9+Opus muxing works.

Chromium's fake-mic-from-file flag gave silence in this Electron, so that run fed a speech file through a stubbed `getUserMedia`.

Not verified:
- A live mic in the app.
- The pointer's position over device frames and zoom.
- Whether Chromium also draws the system pointer in captures (the ring reads fine over it either way).
- A signed build's mic prompt.

The e2e suite wasn't run.

## Goal

Let the user record the preview while they talk and point with the mouse ("this button is too close to *that* heading"). The agent gets the clip, a timed transcript, and where the cursor was during each sentence, so it can work out what "this" and "here" mean.

## What exists today

The **Record preview** button (⌥⌘R, `src/renderer/src/app/record-button.tsx`) already does most of the video side:

- `getDisplayMedia` captures only the preview's `WebContents`, through a capture that main arms for one request (`src/main/index.ts`, `setDisplayMediaRequestHandler`). Audio is refused on purpose (`request.audioRequested` → deny).
- `MediaRecorder` writes a VP9 webm for playback. A `requestVideoFrameCallback` loop also saves JPEG frames (≤30 fps, ≤1568 px) with exact timestamps.
- `RecordingTrace` (`src/main/recording-trace.ts`) injects a tracer into an isolated world in the preview. It logs clicks, hovers over interactive elements, typing, scrolls, animations, layout shifts and slow frames, on the same clock as the frames.
- `Recordings` (`src/main/recordings.ts`) stores `video.webm`, `N.jpg`, `timeline.json`, `manifest.json` per clip under `userData/recordings/<project>/<id>/`.
- When sent, `chat.ts` gives the agent the clip ID, a formatted timeline, and 3 overview frames (first, middle, last). With tools, it can call `recording_frames` and `recording_timeline` (`src/main/mcp-preview-tools.ts`).
- Limits: 60 s, 32 MB video, 1830 frames, 128 MB of frames, 3 clips per message.

Missing: **voice**, a **cursor you can see** (or at least a cursor track), and **overview frames chosen by what the user said**.

## User experience

1. The record button gets a mic toggle next to it ("Narrate"). It stays on once chosen, saved in prefs. The first use asks macOS for microphone access.
2. While recording, the toolbar shows the time and a small mic level meter, so it's obvious the mic is hearing them. (Phase 2: live captions.)
3. Stop → "Transcribing…" on the clip in the composer (a few seconds for a minute of speech).
4. When the composer is empty, the transcript becomes the message text, ready to edit. Otherwise it's only attached to the clip. The user can always edit before sending, so a mis-heard word gets fixed before the agent sees it.
5. Playback in the chat has sound, a drawn cursor, and captions (a WebVTT track built from the transcript).
6. Narrated clips can run up to 3 minutes. Silent clips keep today's 60 s.

## Design

### 1. Microphone audio

- **Capture** in the Gui window renderer with `getUserMedia({ audio: { echoCancellation, noiseSuppression, autoGainControl } })`, separately from the `getDisplayMedia` video. Don't ask `getDisplayMedia` for audio. Keep the "no audio" check in the display handler, because preview page sound is a different thing and should stay out.
- **Permissions**, all in main:
  - `session.defaultSession.setPermissionRequestHandler`: when the capture is armed *and narrating*, also allow `media` with `mediaTypes: ['audio']`. Video-device requests stay denied.
  - `systemPreferences.getMediaAccessStatus('microphone')` / `askForMediaAccess('microphone')` before arming. If access is denied, show "Turn on microphone access for Gui in System Settings → Privacy & Security" with a button that opens that pane, and record without voice.
  - `electron-builder.yml` → `extendInfo.NSMicrophoneUsageDescription`. Add `com.apple.security.device.audio-input` to both entitlements plists. Without it, hardened runtime gives silence or crashes. **This needs human review per AGENTS.md (release/signing).**
  - The preview partition keeps denying `media`, so the user's web app can never reach the mic.
  - If the user once said no, macOS won't ask again. They have to change it in System Settings, so the error message links there.
- **Two outputs from one mic track:**
  - The track is muxed into the playback webm (`new MediaStream([videoTrack, micTrack])`, `audio/webm;codecs=opus` alongside VP9). That gives sound when the user plays the clip back.
  - An `AudioWorklet` downsamples to 16 kHz mono PCM and streams chunks to main (one IPC per second). Main writes `audio.wav`. Transcription needs WAV (AVFoundation can't read webm/opus, and whisper.cpp wants 16 kHz WAV), and this avoids decoding the webm later.
- Bounds: 3 min × 16 kHz × 2 bytes ≈ 5.8 MB of WAV. Validate in main as `frame()` does (byte cap, monotonic chunk sequence, active draft only).

### 2. Cursor

The capture is of the `WebContents`, not the screen, so the macOS cursor may not be in the frames. Chromium's tab capture has a cursor overlay that hides when the mouse is idle. Idle is exactly when someone is pointing, so **check this first on a real clip** (step 0 below). The plan below works either way.

- **Track, in main.** While a capture is active, listen to the preview's `input-event` (already used in `tab.ts`) for `mouseMove`, `mouseDown`, `mouseUp`, `mouseWheel` and `mouseLeave`. On each event, read `screen.getCursorScreenPoint()` and convert it to a view point the same way `cursorOverPreview()` does. Then convert to a viewport point with the preview's scale, using `src/shared/coords.ts` helpers, not inline math. Throttle to 60 Hz. Keep a `{ at, x, y, down }` track (viewport CSS px) and also stream it to the Gui renderer.
- **Draw it into the recording.** The renderer already draws every frame onto a canvas for the JPEGs. Draw the cursor there too: an arrow, a soft halo, and a ripple on mouse down. Then record `canvas.captureStream(30)` (plus the mic track) instead of the raw display stream. Video and frames then both show the cursor, so the agent sees "the thing under the arrow" without doing coordinate math. Convert viewport → frame pixels with `frame.width / viewport.width` (store the viewport size in the manifest).
- **What's under it, in the page.** Extend the tracer: sample `elementFromPoint` at the cursor at most every 100 ms and log a `pointer` entry only when the target changes. Detect **dwells**: the cursor still (< 6 px) for ≥ 400 ms gives `{ kind: 'dwell', at, end, x, y, target }`. Dwells are the strongest "I'm pointing at this" signal and are what the transcript gets lined up with.

### 3. Transcription

Local first. Audio doesn't leave the Mac by default.

**Ship first: Apple SpeechAnalyzer / SpeechTranscriber (macOS 26+), in a small Swift helper.**

- `gui-transcribe <audio.wav> --locale en-US` prints JSON. It uses `SpeechAnalyzer.analyzeSequence(from: AVAudioFile)` with `SpeechTranscriber(attributeOptions: [.audioTimeRange])`. Result runs carry near-word time ranges. [finnvoor/yap](https://github.com/finnvoor/yap) is a working reference CLI.
- It's fast: about 45 s for a 34-minute file in MacStories' test, so about a second for a minute of speech.
- The OS manages model assets (`AssetInventory`), so nothing goes in the bundle. The first use of a language downloads its assets, which the helper reports as progress.
- 9 locales are listed (en-US, de, es, fr, it, ja, ko, pt-BR, zh-CN). Check `SpeechTranscriber.isAvailable` and `supportedLocales`, and use the system language when it's supported.
- The helper only reads a file, so it needs no mic permission. Reports suggest it also needs no speech-recognition prompt. Add `NSSpeechRecognitionUsageDescription` anyway and verify on a clean signed build.
- Build it in `native/transcribe/` with `swiftc`, and ship it via `extraResources` + `mac.binaries` so it's signed with Gui's Team ID and hardened runtime. Spawn it through `spawnProcess` in `src/main/process.ts`, with a timeout and a size cap on stdout. **Signing changes need human review.**

**Fallback: whisper.cpp** (MIT, Metal) for macOS 13–25 or unsupported languages. One signed `whisper-cli` binary. The model (`base.en` ≈ 148 MB, or multilingual `small-q5` ≈ 190 MB) downloads on first use into `userData/models`, with a checksum. Word times come from `-ml 1` or `-ojf` JSON, and Silero VAD trims silence. Gui's minimum is macOS 13, so this matters for some users. It can come after the Apple path, with "Voice transcription needs macOS 26" shown until then.

**Not chosen:**
- **Cloud** (Deepgram, ElevenLabs, OpenAI `whisper-1`, about $0.004–0.006/min, all with word timestamps): opt-in only, later, if at all.
- **transformers.js:** slow, and WebGPU word timestamps are broken.
- **Moonshine:** no timestamps.
- **The legacy `SFSpeechRecognizer`:** weaker timestamps, and file requests are reported to stall on macOS 26.
- **FluidAudio/Parakeet:** a strong alternative fallback (macOS 14+, very fast, good token timings), but a bigger download and CC-BY attribution.

Output in both cases is `transcript.json`: `{ engine, language, segments: [{ start, end, text, words?: [{ start, end, text }] }] }`, with ms on the clip's clock. The audio's first sample is aligned to the recorder's `started` time, which is the same origin the frames and the trace use.

### 4. What the agent gets

The speech is **the user's words**, so it's an instruction, unlike page content. It goes in its own block and is *not* fenced as untrusted. The page timeline stays fenced as it is now.

A new **narration** block, built in `chat.ts`, that merges speech with where the cursor was:

```
The user narrated this recording while pointing with the mouse. The cursor is drawn in the frames.
[0.0–2.4 s] "So when I hover this card"
    cursor dwelt on div.card:nth-of-type(2) > h3 "Pro plan" at 412,318 (frame 41)
[2.4–5.1 s] "this shadow jumps, and the price here is misaligned"
    cursor moved to span.price "$24/mo" at 470,362 (frame 98); hover → transition box-shadow 150 ms
```

- **Overview frames chosen by speech**, not first/middle/last: one frame per dwell, plus one at each pointing word ("this", "here", "that", "these", "there") using word timestamps. Fall back to segment midpoints. Cap at 8 images. Label each one with its time and the words spoken then.
- **Tools:** add `recording_transcript` (`recordingId`, optional `startMs`/`endMs`). It returns the segments with words, cursor positions and targets. Also merge `speech` and `dwell` entries into `recording_timeline` so one call shows "what was said, where the cursor was, what the page did". Raise the 61 000 ms caps in the tool schemas to the new maximum.
- **Agents without images** still get the narration block with element targets, which is enough for many edits.
- **No audio to agents.** ACP has an `audio` content block (`promptCapabilities.audio`), but `claude-agent-acp` and `codex-acp` both drop it, and the Claude API takes no audio or video. Text transcript plus image frames is what works everywhere.
- **Say which source wins.** The prompt tells the agent that frames and the cursor are more reliable than the words when they disagree, because speech recognition garbles names. (Gripe, the closest prior art, does the same.)

Prior art follows the same pattern:
- **Jam's MCP** returns a WebVTT transcript next to screenshots and logs.
- **Gripe** pairs each transcript line with keyframes, plus the pointer resolved to a selector and label, and has the user proofread the transcript first.

### 5. Storage, limits, history

- New files per clip: `audio.wav` (deleted after transcription succeeds; the webm keeps the playback sound), `transcript.json`, `cursor.json`.
- `RecordingAttachment` gains `narrated?: boolean`, `transcript?: string` (plain text, capped at ~4 KB for the history file), and `captionsUrl?` (`gui-recording://…/captions.vtt`, served by the same protocol handler).
- Caps move to `src/shared/bounded.ts` (AGENTS.md: shared growth caps): `MAX_RECORDING_MS` (60 s silent, 180 s narrated), and frames at 30 fps for the first 60 s, then 10 fps (≤ 3 000 frames total), so 3 min stays under the frame byte cap. Update the hard-coded `61_000` / `65_000` / `1830` values in `recordings.ts`, `index.ts`, `record-button.tsx` and `mcp-preview-tools.ts`, and `settleRecordings` in `history-record.ts`.
- Project lifetime: the transcription job belongs to the clip's `Recordings` and is cancelled on `dispose()`. A result that comes back after the project closed, or after the clip was discarded, is dropped (`stillCurrent`). The helper process is spawned through `src/main/process.ts`.

## Build order

0. **Spike (half a day).** Record a clip today and check the frames for the cursor while moving, and after 2 s idle. Check that `input-event` fires for mouse moves over the preview in a device frame and at zoom, and which coordinate space it reports. Check that `MediaRecorder` muxes `canvas.captureStream` + mic into one webm in Electron 44.
1. **Cursor track and drawn cursor** (no audio yet). Useful alone: today's silent clips get a visible pointer and dwell entries. Ship.
2. **Mic capture and playback sound.** Permissions, plist and entitlement (human review), mic toggle, level meter, opus track, WAV stream to main.
3. **Transcription** with the Swift helper (macOS 26+), `transcript.json`, "Transcribing…" state, transcript into the composer, captions track.
4. **Agent side.** Narration block, speech-chosen frames, `recording_transcript`, timeline merge, new caps.
5. **Fallback and polish.** whisper.cpp for macOS 13–25, live captions while recording (SpeechTranscriber streams partial results), a language picker, re-transcribe.

Tests: `tests/` unit tests for the narration formatter (speech + dwell merge, frame picks, caps) and the transcript parser. One e2e spec that records with a fake mic (Chromium's `--use-fake-device-for-media-stream` / `--use-file-for-fake-audio-capture`) and a stubbed transcriber, then checks the prompt blocks. Run it only when asked.

## Risks and open questions

- **Cursor already in capture?** Answered by step 0. If Chromium draws it, we could skip drawing our own, but it disappears when idle, so we likely still want ours.
- **Echo/feedback.** If the preview page plays sound, the mic picks it up through speakers. Echo cancellation helps. That's acceptable.
- **Privacy.** The mic is only on while the red recording indicator is showing. Audio never leaves the machine with a local engine. Delete the WAV after transcription.
- **Wrong words.** Users edit the transcript before sending. Code-ish words ("flexbox", "z-index", the project's own component names) are where engines fail. A custom vocabulary from the selection, file names and component names can help where the engine supports it.
