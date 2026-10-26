// gui-transcribe: transcribes a narrated preview recording on this Mac, with Apple's
// SpeechAnalyzer (macOS 26+). Gui runs it from src/main/transcribe.ts.
//
//   gui-transcribe <audio.wav> [--locale en-US]
//   gui-transcribe --prepare [--locale en-US]
//
// --prepare downloads the language's model, if the system doesn't have it yet, and prints
// nothing: Gui runs it when narration is turned on, so the first clip doesn't wait for it.
//
// Prints one JSON object to stdout:
//   { "locale": "en-US", "segments": [{ "start": ms, "end": ms, "text": "…",
//     "words": [{ "start": ms, "end": ms, "text": "…" }] }] }
// Exit codes: 0 done, 2 bad arguments, 3 unavailable on this Mac, 4 language unsupported,
// 1 anything else. Errors go to stderr as one line.

import AVFoundation
import CoreMedia
import Foundation
import Speech

struct Word: Encodable {
  let start: Int
  let end: Int
  let text: String
}

struct Segment: Encodable {
  let start: Int
  let end: Int
  let text: String
  let words: [Word]
}

struct Output: Encodable {
  let locale: String
  let segments: [Segment]
}

func fail(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

func ms(_ time: CMTime) -> Int {
  let seconds = CMTimeGetSeconds(time)
  return seconds.isFinite ? Int((seconds * 1000).rounded()) : 0
}

@available(macOS 26, *)
func transcriber(_ requested: Locale) async throws -> (SpeechTranscriber, Locale) {
  guard SpeechTranscriber.isAvailable else { fail("Speech transcription is unavailable on this Mac.", 3) }
  guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
    fail("Speech transcription doesn't support \(requested.identifier(.bcp47)).", 4)
  }
  let transcriber = SpeechTranscriber(
    locale: locale,
    transcriptionOptions: [],
    reportingOptions: [],
    attributeOptions: [.audioTimeRange]
  )
  // The system downloads a language's model the first time it's used, then keeps it.
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await request.downloadAndInstall()
  }
  return (transcriber, locale)
}

@available(macOS 26, *)
func transcribe(_ url: URL, _ requested: Locale) async throws -> Output {
  let (transcriber, locale) = try await transcriber(requested)
  let collect = Task { () throws -> [Segment] in
    var segments: [Segment] = []
    for try await result in transcriber.results where result.isFinal {
      var words: [Word] = []
      for run in result.text.runs {
        let text = String(result.text[run.range].characters)
          .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let range = run.audioTimeRange else { continue }
        words.append(Word(start: ms(range.start), end: ms(range.end), text: text))
      }
      let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty { continue }
      segments.append(
        Segment(start: ms(result.range.start), end: ms(result.range.end), text: text, words: words)
      )
    }
    return segments
  }
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let file = try AVAudioFile(forReading: url)
  if let last = try await analyzer.analyzeSequence(from: file) {
    try await analyzer.finalizeAndFinish(through: last)
  } else {
    await analyzer.cancelAndFinishNow()
  }
  let segments = try await collect.value
  return Output(locale: locale.identifier(.bcp47), segments: segments)
}

@main
struct Main {
  static func main() async {
    var args = Array(CommandLine.arguments.dropFirst())
    var requested = Locale.current
    if let flag = args.firstIndex(of: "--locale") {
      guard flag + 1 < args.count else { fail("--locale needs a value.", 2) }
      requested = Locale(identifier: args[flag + 1])
      args.removeSubrange(flag...(flag + 1))
    }
    let prepare = args.firstIndex(of: "--prepare")
    if let flag = prepare { args.remove(at: flag) }
    guard args.count == (prepare == nil ? 1 : 0) else {
      fail("Usage: gui-transcribe <audio file> [--locale xx-YY] | --prepare [--locale xx-YY]", 2)
    }
    guard #available(macOS 26, *) else { fail("Speech transcription needs macOS 26 or later.", 3) }
    if prepare != nil {
      do {
        _ = try await transcriber(requested)
        exit(0)
      } catch {
        fail(error.localizedDescription, 1)
      }
    }
    do {
      let output = try await transcribe(URL(fileURLWithPath: args[0]), requested)
      let encoder = JSONEncoder()
      FileHandle.standardOutput.write(try encoder.encode(output))
    } catch {
      fail(error.localizedDescription, 1)
    }
  }
}
