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
//   {"type":"vad","speaking":true|false,"floor":0.0042}       // voicing-state edges only
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

// Env-gated diagnostics to stderr (never on the stdout NDJSON channel).
// SIDECAR_DEBUG=1 turns on the live-path trace: input format, periodic RMS +
// endpointer state, and every session rotation. Used to diagnose the live
// microphone path (see docs/ARCHITECTURE.md §3.1 — Live-path smoke test).
let sidecarDebug = ProcessInfo.processInfo.environment["SIDECAR_DEBUG"] == "1"
func dbg(_ s: String) {
    if !sidecarDebug { return }
    FileHandle.standardError.write(Data(("[dbg] " + s + "\n").utf8))
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
// Silence-based endpointing (both live and file feed): Apple's on-device
// recognizer never emits an isFinal on its own for a continuous
// buffer-append request, and its partial-result segment timestamps are
// placeholders — only a *final* result carries real timestamps. So the
// pipeline watches the audio energy itself, and when the speaker pauses for
// SILENCE_MS it calls endAudio() to force a real final (real timestamps) and
// rotate to a fresh session — exactly the sentence-boundary session rotation
// a reader produces. This keeps any one session's transcript short (no head
// truncation on long readings) and is identical for microphone and
// --audio-file input, since both funnel through appendBuffer().
// Endpointing tuning. The silence threshold is ADAPTIVE — a fixed value can't
// serve both a silent room and a fan-noise room, and real microphone speech
// levels (RMS ~0.006–0.05 depending on distance and gain) straddle any fixed
// line. Instead a rolling noise floor tracks the quietest recent audio and
// the threshold sits a margin above it, clamped to sane bounds.
let SILENCE_MS_TO_ENDPOINT: Double = 600   // pause this long → finalize + rotate
let VAD_SILENCE_MS: Double = 350           // pause this long → "not voicing" (coasting signal)
let FLOOR_FALL: Float = 0.3                // noise floor tracks a new minimum quickly…
let FLOOR_RISE: Float = 0.0008             // …and rises very slowly (speech can't drag it up)
let THRESH_MARGIN_MULT: Float = 3.0        // threshold = floor * mult + add, clamped
let THRESH_MARGIN_ADD: Float = 0.0015
let THRESH_MIN: Float = 0.004
// Upper clamp. It only engages once the noise floor exceeds ~0.02 RMS (a
// genuinely noisy room, ≈ −34 dBFS); below that the threshold is set by the
// floor×margin or THRESH_MIN and this bound is inert. It sits above the
// per-buffer peaks of ~−30 dBFS pink noise (measured max ≈ 0.053) so short
// inter-sentence pauses still register as silence under that noise, and well
// below normal speech (RMS ≈ 0.10–0.22) so voicing is never misread as
// silence. See the "noisy" fixture family (docs/ARCHITECTURE.md §3.3).
let THRESH_MAX: Float = 0.060

final class Pipeline: NSObject {
    let recognizer: SFSpeechRecognizer
    let engine = AVAudioEngine()
    let lock = NSLock()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var session = 1
    var sessionStart = Date()
    var quickFailures = 0

    // Endpointing state (guarded by `lock`).
    var hasTranscript = false      // this session emitted at least one partial
    var awaitingSpeech = false     // rotated on silence; wait for speech to resume
    var silentSeconds = 0.0        // running silent-audio duration

    // Adaptive noise floor (guarded by `lock`). A fixed RMS threshold can't
    // serve a silent room and a noisy one, and live mic levels straddle any
    // constant. The floor tracks the quietest recent audio: it snaps down fast
    // toward a new minimum and creeps up slowly, so speech energy never drags
    // it up. The silence threshold is derived from it each buffer, clamped.
    var noiseFloor: Float = THRESH_MIN / THRESH_MARGIN_MULT   // seed near the min threshold
    var floorSeeded = false

    // VAD edge tracking (guarded by `lock`). Voicing = RMS above threshold;
    // we emit a {"type":"vad"} only when the debounced state flips, so the
    // frontend has one authoritative coasting signal without a second mic.
    var vadSpeaking = false
    var vadSilentSeconds = 0.0     // running sub-threshold time while "speaking"

    // Zero-gap rotation (guarded by `lock`): between endAudio() on the old
    // request and the new session's request going live, incoming audio has
    // nowhere to go. Rather than drop it — which loses the first words of the
    // resumed line — buffer it and replay it, in order, into the next
    // request. Bounded so a recognizer that never finalizes can't grow it
    // unboundedly; the watchdog rotates before that anyway.
    var pendingBuffers: [AVAudioPCMBuffer] = []
    var pendingSeconds = 0.0
    let maxPendingSeconds = 3.0

    // Debug RMS accumulation (SIDECAR_DEBUG only)
    var dbgBufCount = 0
    var dbgRmsMax: Float = 0
    var dbgRmsSum: Float = 0
    var dbgLastLog = Date()

    init(recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
        super.init()
    }

    // Single append path for both input sources: measures buffer energy, runs
    // the silence endpointer, then appends to the current request.
    func appendBuffer(_ buffer: AVAudioPCMBuffer) {
        let rms = Pipeline.bufferRMS(buffer)
        let seconds = Double(buffer.frameLength) / buffer.format.sampleRate

        lock.lock()
        var shouldEndpoint = false

        // Update the adaptive noise floor, then derive this buffer's silence
        // threshold. Snap down fast toward a quieter minimum; creep up slowly.
        if !floorSeeded {
            noiseFloor = rms
            floorSeeded = true
        } else if rms < noiseFloor {
            noiseFloor += (rms - noiseFloor) * FLOOR_FALL
        } else {
            noiseFloor += (rms - noiseFloor) * FLOOR_RISE
        }
        let threshold = min(THRESH_MAX, max(THRESH_MIN, noiseFloor * THRESH_MARGIN_MULT + THRESH_MARGIN_ADD))

        if rms >= threshold {
            // Speech: reset the silence run; re-arm the endpointer.
            silentSeconds = 0
            awaitingSpeech = false
        } else {
            // Silence: once a pause exceeds the threshold and this session has
            // produced transcript, finalize it (once) and wait for speech.
            silentSeconds += seconds
            if hasTranscript && !awaitingSpeech && silentSeconds * 1000 >= SILENCE_MS_TO_ENDPOINT {
                shouldEndpoint = true
                awaitingSpeech = true
            }
        }

        // VAD edge detection (drives frontend coasting). Rising edge fires the
        // instant RMS clears the threshold; falling edge waits VAD_SILENCE_MS
        // of sub-threshold audio so a brief inter-word dip doesn't flap it.
        var vadEdge: Bool? = nil
        if rms >= threshold {
            vadSilentSeconds = 0
            if !vadSpeaking { vadSpeaking = true; vadEdge = true }
        } else if vadSpeaking {
            vadSilentSeconds += seconds
            if vadSilentSeconds * 1000 >= VAD_SILENCE_MS { vadSpeaking = false; vadEdge = false }
        }
        let vadFloor = noiseFloor
        // Route the buffer: to the live request, or — when none is live (mid
        // rotation) — into the bounded replay queue so nothing is lost.
        let liveReq = self.request
        if liveReq == nil {
            pendingBuffers.append(buffer)
            pendingSeconds += seconds
            while pendingSeconds > maxPendingSeconds && !pendingBuffers.isEmpty {
                let dropped = pendingBuffers.removeFirst()
                pendingSeconds -= Double(dropped.frameLength) / dropped.format.sampleRate
            }
        }
        let dbgHas = hasTranscript, dbgAwait = awaitingSpeech, dbgSilent = silentSeconds, dbgSess = session
        let dbgThr = threshold
        lock.unlock()

        // Emit the voicing edge (outside the lock — emit() takes stdout).
        if let speaking = vadEdge {
            emit(["type": "vad", "speaking": speaking, "floor": Double(vadFloor)])
        }

        if sidecarDebug {
            dbgBufCount += 1
            dbgRmsMax = max(dbgRmsMax, rms)
            dbgRmsSum += rms
            if Date().timeIntervalSince(dbgLastLog) >= 0.3 {
                let mean = dbgBufCount > 0 ? dbgRmsSum / Float(dbgBufCount) : 0
                dbg(String(format: "rms mean=%.5f max=%.5f thr=%.5f floor=%.5f | silent=%.2fs hasTx=%@ awaiting=%@ spk=%@ sess=%d buffers=%d",
                    mean, dbgRmsMax, dbgThr, vadFloor, dbgSilent,
                    dbgHas ? "Y":"N", dbgAwait ? "Y":"N", vadSpeaking ? "Y":"N", dbgSess, dbgBufCount))
                dbgBufCount = 0; dbgRmsMax = 0; dbgRmsSum = 0; dbgLastLog = Date()
            }
        }

        liveReq?.append(buffer)
        if shouldEndpoint { dbg("→ endpoint (silence \(String(format: "%.2f", dbgSilent))s, sess \(dbgSess))"); endpoint() }
    }

    // Silence endpoint: close the audio so the recognizer delivers its real
    // final (with real segment timestamps); the isFinal callback then emits
    // it and advances to a fresh session. A watchdog forces a hard rotate if
    // no final arrives, so a stuck recognizer can't strand the pipeline.
    func endpoint() {
        lock.lock()
        request?.endAudio()
        request = nil
        let endedSession = session
        lock.unlock()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let stuck = (self.session == endedSession && self.request == nil)
            self.lock.unlock()
            if stuck { self.hardRotate() }
        }
    }

    static func bufferRMS(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData else { return 0 }
        let n = Int(buffer.frameLength)
        if n == 0 { return 0 }
        var sum: Float = 0
        let ch = data[0]
        for i in 0..<n { let s = ch[i]; sum += s * s }
        return (sum / Float(n)).squareRoot()
    }

    func startAudio() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        dbg("input format: \(format.sampleRate) Hz, \(format.channelCount) ch, commonFormat=\(format.commonFormat.rawValue)")
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.appendBuffer(buffer)
        }
        engine.prepare()
        try engine.start()
        dbg("AVAudioEngine started (running=\(engine.isRunning))")
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
                self.appendBuffer(buf)
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
        // Hard-rotate so the next session picks up the biased model
        hardRotate()
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
        // Go live and replay any audio buffered during the rotation gap, in
        // order, BEFORE any new live buffer can append — done under one lock
        // so the queued (older) and live (newer) audio can't interleave.
        lock.lock()
        for b in pendingBuffers { req.append(b) }
        let replayed = pendingBuffers.count
        pendingBuffers.removeAll()
        pendingSeconds = 0
        request = req
        lock.unlock()
        if replayed > 0 { dbg("startSession: replayed \(replayed) buffered audio buffers") }
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
                    self.advance()
                } else {
                    self.lock.lock(); self.hasTranscript = true; self.lock.unlock()
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
                self.hardRotate()
            }
        }
    }

    // Advance to the next session after the recognizer delivered a final of
    // its own accord (the isFinal callback). The task has already completed —
    // do not cancel it (cancel would discard the just-delivered final).
    func advance() {
        lock.lock()
        hasTranscript = false
        silentSeconds = 0
        let s = session
        lock.unlock()
        dbg("advance: session \(s) → \(s + 1)")
        task = nil
        session += 1
        // Start the next session immediately (no artificial delay) so the
        // audio buffered during the gap is replayed at once — the old task has
        // already delivered its final, so only one task is ever live.
        DispatchQueue.main.async { [weak self] in
            self?.startSession()
        }
    }

    // Hard rotate: abandon the current session outright (custom-LM adoption,
    // recoverable errors, or the endpoint watchdog). Cancels the in-flight
    // task, discarding any pending result, and starts fresh.
    func hardRotate() {
        lock.lock()
        request?.endAudio()
        request = nil
        hasTranscript = false
        silentSeconds = 0
        let s = session
        lock.unlock()
        dbg("hardRotate: session \(s) → \(s + 1)")
        task?.cancel()
        task = nil
        session += 1
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
