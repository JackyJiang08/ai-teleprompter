// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// speech-sidecar — on-device speech recognition bridge for the teleprompter.
//
// Runs Apple's SFSpeechRecognizer with requiresOnDeviceRecognition=true and
// streams partial transcripts as NDJSON on stdout. Managed as a Tauri sidecar
// by the main app; can also be run standalone for debugging:
//
//   speech-sidecar --locale en-US
//
// Protocol (one JSON object per line on stdout):
//   {"type":"ready","locale":"en-US","onDevice":true}
//   {"type":"partial","session":1,"text":"hello world",
//    "words":[{"w":"hello","t":0.12,"d":0.31,"c":0.9}, …]}   // per-segment:
//        substring, timestamp (s, from session audio start), duration (s),
//        confidence (0..1). "text" stays for display/back-compat.
//   {"type":"final","session":1,"text":"…","words":[…]}      // session then increments
//   {"type":"error","code":"...","message":"...","fatal":true|false}
// Every message additionally carries "t" (ms since epoch), added by emit().
//
// Fatal error codes: auth_denied, auth_restricted, locale_unavailable,
// ondevice_unsupported, audio_error, recognizer_storm.
// Non-fatal: recognizer_error (a new session is started automatically).
//
// No audio or transcript ever leaves the process except via stdout to the
// parent app; recognition is forced on-device.

import AVFoundation
import CryptoKit
import Foundation
import Speech

// ── stdout emitter ─────────────────────────────────────────
// FileHandle.write is a direct write(2) per NDJSON line — no stdio buffering,
// so each partial reaches the parent the moment it is emitted. Every message
// carries "t" (ms since epoch) for latency instrumentation.
let emitQueue = DispatchQueue(label: "emit")
func emit(_ obj: [String: Any]) {
    emitQueue.sync {
        var stamped = obj
        stamped["t"] = Int(Date().timeIntervalSince1970 * 1000)
        guard let data = try? JSONSerialization.data(withJSONObject: stamped) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

func fatalError(code: String, message: String) -> Never {
    emit(["type": "error", "code": code, "message": message, "fatal": true])
    exit(2)
}

// ── args ───────────────────────────────────────────────────
// --locale <id>       recognition locale (default en-US)
// --script <path>     file holding the script text being read; used to build
//                     a customized language model (macOS 14+) that biases
//                     recognition toward the exact words on screen. Silently
//                     ignored when unsupported.
// --contextual <path> newline-separated vocabulary (the script's non-stopword
//                     words, prepared by the frontend); set as
//                     contextualStrings on every recognition request — works
//                     on all supported macOS versions, unlike the custom LM.
// --tricky <path>     newline-separated user-supplied "tricky words": either
//                     a bare word (boosted via contextualStrings + a
//                     high-count LM phrase) or "word=phoneme phoneme …"
//                     (X-SAMPA) which additionally registers a
//                     CustomPronunciation in the custom LM (macOS 14+).
// --audio-file <path> dev/measurement only: feed this audio file to the
//                     recognizer at real-time pace instead of the microphone
//                     (used by scripts/track-latency.mjs for deterministic
//                     latency numbers; never set by the app)
var localeId = "en-US"
var audioFilePath: String? = nil
var scriptFilePath: String? = nil
var contextualFilePath: String? = nil
var trickyFilePath: String? = nil
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    if a == "--locale", let v = args.next() { localeId = v }
    if a == "--script", let v = args.next() { scriptFilePath = v }
    if a == "--contextual", let v = args.next() { contextualFilePath = v }
    if a == "--tricky", let v = args.next() { trickyFilePath = v }
    if a == "--audio-file", let v = args.next() { audioFilePath = v }
}

// ── recognition vocabulary ─────────────────────────────────
// Tricky words: user-maintained list from Settings (empty by default).
// "word" boosts recognition; "word=phonemes" additionally supplies an
// X-SAMPA pronunciation for the custom LM.
struct TrickyEntry {
    let grapheme: String
    let phonemes: [String]
}
var trickyEntries: [TrickyEntry] = []
if let path = trickyFilePath, let raw = try? String(contentsOfFile: path, encoding: .utf8) {
    for line in raw.components(separatedBy: .newlines) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }
        if let eq = trimmed.firstIndex(of: "=") {
            let grapheme = String(trimmed[..<eq]).trimmingCharacters(in: .whitespaces)
            let phonemes = String(trimmed[trimmed.index(after: eq)...])
                .split(separator: " ").map(String.init)
            if !grapheme.isEmpty { trickyEntries.append(TrickyEntry(grapheme: grapheme, phonemes: phonemes)) }
        } else {
            trickyEntries.append(TrickyEntry(grapheme: trimmed, phonemes: []))
        }
    }
}

// contextualStrings: tricky words first (highest value), then the script
// vocabulary; deduplicated case-insensitively and capped at 100 entries
// (Apple guidance for the contextualStrings API).
let contextualCap = 100
var contextualStrings: [String] = trickyEntries.map { $0.grapheme }
if let path = contextualFilePath, let raw = try? String(contentsOfFile: path, encoding: .utf8) {
    contextualStrings += raw.components(separatedBy: .newlines)
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
}
var seenContextual = Set<String>()
contextualStrings = contextualStrings.filter { seenContextual.insert($0.lowercased()).inserted }
if contextualStrings.count > contextualCap {
    contextualStrings = Array(contextualStrings.prefix(contextualCap))
}

// ── authorization ──────────────────────────────────────────
let authSem = DispatchSemaphore(value: 0)
var authStatus = SFSpeechRecognizer.authorizationStatus()
if authStatus == .notDetermined {
    SFSpeechRecognizer.requestAuthorization { status in
        authStatus = status
        authSem.signal()
    }
    authSem.wait()
}
switch authStatus {
case .authorized: break
case .restricted: fatalError(code: "auth_restricted", message: "Speech recognition is restricted on this Mac.")
default: fatalError(code: "auth_denied", message: "Speech recognition permission was denied.")
}

// ── recognizer ─────────────────────────────────────────────
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
    fatalError(code: "locale_unavailable", message: "No speech recognizer for locale \(localeId).")
}
guard recognizer.supportsOnDeviceRecognition else {
    fatalError(code: "ondevice_unsupported",
               message: "On-device recognition unavailable for \(localeId). Install the dictation language in System Settings › Keyboard › Dictation.")
}

// ── recognition pipeline ───────────────────────────────────
final class Pipeline: NSObject {
    let recognizer: SFSpeechRecognizer
    let engine = AVAudioEngine()
    let lock = NSLock()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var session = 1
    var sessionStart = Date()
    var quickFailures = 0

    init(recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
        super.init()
    }

    func startAudio() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            self.lock.lock()
            let req = self.request
            self.lock.unlock()
            req?.append(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    // Measurement mode: stream an audio file into the recognizer at
    // real-time pace, as if it were live microphone input.
    func startFileFeed(path: String) throws {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        let format = file.processingFormat
        let chunk: AVAudioFrameCount = 1024
        Thread.detachNewThread { [weak self] in
            emit(["type": "feed", "state": "start", "frames": Int(file.length),
                  "sampleRate": format.sampleRate])
            while let self = self, file.framePosition < file.length {
                guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) else { break }
                do { try file.read(into: buf, frameCount: chunk) } catch { break }
                if buf.frameLength == 0 { break }
                self.lock.lock()
                let req = self.request
                self.lock.unlock()
                req?.append(buf)
                // pace to real time
                Thread.sleep(forTimeInterval: Double(buf.frameLength) / format.sampleRate)
            }
            emit(["type": "feed", "state": "end"])
        }
    }

    // Customized language model configuration (SFSpeechLanguageModel.
    // Configuration on macOS 14+; stored as Any so the class loads on 13).
    var customLM: Any? = nil

    func adoptCustomLM(_ config: Any) {
        lock.lock()
        customLM = config
        lock.unlock()
        // Rotate so the next session picks up the biased model
        rotateSession()
    }

    func startSession() {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        req.taskHint = .dictation
        // Bias recognition toward the script's vocabulary on every request —
        // available on all supported macOS versions (the custom LM is 14+).
        if !contextualStrings.isEmpty {
            req.contextualStrings = contextualStrings
        }
        if #available(macOS 13.0, *) {
            req.addsPunctuation = false
        }
        if #available(macOS 14.0, *) {
            lock.lock()
            let lm = customLM as? SFSpeechLanguageModel.Configuration
            lock.unlock()
            if let lm = lm { req.customizedLanguageModel = lm }
        }
        lock.lock()
        request = req
        lock.unlock()
        sessionStart = Date()

        let current = session
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString
                let segments = result.bestTranscription.segments
                let confidence = segments.isEmpty
                    ? 0.0
                    : segments.map { Double($0.confidence) }.reduce(0, +) / Double(segments.count)
                // Per-word data: the matcher needs each segment's substring,
                // timestamp (s from session audio start), duration, and
                // confidence for stability gating and alignment.
                let words: [[String: Any]] = segments.map { seg in
                    ["w": seg.substring, "t": seg.timestamp, "d": seg.duration, "c": Double(seg.confidence)]
                }
                if result.isFinal {
                    emit(["type": "final", "session": current, "text": text,
                          "confidence": confidence, "words": words])
                    self.rotateSession()
                } else {
                    emit(["type": "partial", "session": current, "text": text,
                          "confidence": confidence, "words": words])
                }
            } else if let error = error {
                // A canceled task (session already rotated, e.g. when the
                // custom LM is adopted) reports a final error — ignore it,
                // or it would re-rotate the live session and cascade into a
                // recognizer_storm.
                if current != self.session { return }
                let elapsed = Date().timeIntervalSince(self.sessionStart)
                if elapsed < 2.0 {
                    self.quickFailures += 1
                } else {
                    self.quickFailures = 0
                }
                if self.quickFailures >= 3 {
                    fatalError(code: "recognizer_storm",
                               message: "Recognition keeps failing: \(error.localizedDescription)")
                }
                emit(["type": "error", "code": "recognizer_error",
                      "message": error.localizedDescription, "fatal": false])
                self.rotateSession()
            }
        }
    }

    func rotateSession() {
        lock.lock()
        request?.endAudio()
        request = nil
        lock.unlock()
        task?.cancel()
        task = nil
        session += 1
        // Small delay so a failing recognizer can't spin the CPU.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.startSession()
        }
    }
}

let pipeline = Pipeline(recognizer: recognizer)
do {
    if let path = audioFilePath {
        pipeline.startSession()
        try pipeline.startFileFeed(path: path)
    } else {
        try pipeline.startAudio()
        pipeline.startSession()
    }
} catch {
    fatalError(code: "audio_error", message: "Could not start audio capture: \(error.localizedDescription)")
}

emit(["type": "ready", "locale": localeId, "onDevice": true])

// ── Customized language model (macOS 14+) ──────────────────
// Biases on-device recognition toward the exact words of the current script
// — the biggest accuracy lever for names and technical terms. Built from the
// script text, cached per (script, locale) hash, prepared asynchronously so
// early sessions run on the stock model and rotate to the biased one when
// ready. Any failure (older macOS, unsupported locale, training error) is
// silent: recognition simply continues on the stock model.
@available(macOS 14.0, *)
func buildCustomLM(scriptText: String, pipeline: Pipeline) async {
    do {
        // Hash covers everything that shapes the model: script, locale,
        // tricky words, and a scheme version (bump on generation changes).
        let trickyKey = trickyEntries.map { "\($0.grapheme)=\($0.phonemes.joined(separator: " "))" }
            .joined(separator: "\n")
        let digest = SHA256.hash(data: Data((scriptText + "|" + localeId + "|" + trickyKey + "|v2").utf8))
        let hash = digest.map { String(format: "%02x", $0) }.joined().prefix(16)
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ai-teleprompter-lm", isDirectory: true)
        try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        let assetURL = cacheDir.appendingPathComponent("\(hash).bin")
        let lmURL = cacheDir.appendingPathComponent("\(hash).lm", isDirectory: true)

        if !FileManager.default.fileExists(atPath: assetURL.path) {
            // One phrase per script line (edits change the hash → rebuild)…
            let lines = scriptText
                .components(separatedBy: .newlines)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
                .prefix(500)
            // …plus sliding 3–5-word n-grams at a lower count, so the model
            // also learns local word ORDER (whole-line phrases alone bias
            // vocabulary but not transitions). Capped to bound training time.
            var ngrams: [String] = []
            let ngramCap = 3000
            outer: for line in lines {
                let ws = line.split(separator: " ").map(String.init)
                if ws.count < 3 { continue }
                for n in 3...5 {
                    if ws.count < n { break }
                    for start in 0...(ws.count - n) {
                        ngrams.append(ws[start..<(start + n)].joined(separator: " "))
                        if ngrams.count >= ngramCap { break outer }
                    }
                }
            }
            let tricky = trickyEntries
            let data = SFCustomLanguageModelData(
                locale: Locale(identifier: localeId),
                identifier: "com.jackyjiang.ai-teleprompter.script",
                version: "2.0"
            ) {
                for phrase in lines {
                    SFCustomLanguageModelData.PhraseCount(phrase: String(phrase), count: 10)
                }
                for gram in ngrams {
                    SFCustomLanguageModelData.PhraseCount(phrase: gram, count: 3)
                }
                for entry in tricky {
                    SFCustomLanguageModelData.PhraseCount(phrase: entry.grapheme, count: 30)
                }
                for entry in tricky where !entry.phonemes.isEmpty {
                    SFCustomLanguageModelData.CustomPronunciation(
                        grapheme: entry.grapheme, phonemes: entry.phonemes)
                }
            }
            try await data.export(to: assetURL)
        }

        let config = SFSpeechLanguageModel.Configuration(languageModel: lmURL)
        try await SFSpeechLanguageModel.prepareCustomLanguageModel(
            for: assetURL,
            clientIdentifier: "com.jackyjiang.ai-teleprompter",
            configuration: config
        )
        pipeline.adoptCustomLM(config)
        emit(["type": "lm", "state": "active", "cached": true])
    } catch {
        emit(["type": "lm", "state": "unavailable", "message": error.localizedDescription])
    }
}

if let path = scriptFilePath,
   let scriptText = try? String(contentsOfFile: path, encoding: .utf8),
   !scriptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    if #available(macOS 14.0, *) {
        Task { await buildCustomLM(scriptText: scriptText, pipeline: pipeline) }
    } else {
        emit(["type": "lm", "state": "unavailable", "message": "requires macOS 14"])
    }
}

signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }

RunLoop.main.run()
