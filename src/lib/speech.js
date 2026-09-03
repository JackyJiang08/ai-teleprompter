// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// Speech tracker — glues the on-device recognition sidecar to the cursor
// matcher. Owns restart/fallback policy; the Rust side only supervises the
// process (see start_speech in src-tauri/src/lib.rs).
//
// createSpeechTracker({ locale, tokens, scriptText, onUpdate, onStatus, onFallback, onDebug })
//   .start()  — begin listening + recognition
//   .stop()   — kill the sidecar and unlisten
//   .reset()  — return the cursor to the top of the script
//
// scriptText (optional) is forwarded to the sidecar, which builds a
// customized language model from it on macOS 14+ (recognition biased toward
// the exact words being read; silent fallback elsewhere).
//
// onUpdate({ cursorTokenIndex, provisionalTokenIndex, matchedCount,
//            provisionalCount, total, done, confidence, speaking })
//   cursorTokenIndex marks the committed position (dim everything before
//   it); provisionalTokenIndex is the display cursor to highlight.
// onStatus(status, message) — 'starting' | 'listening' | 'error'
// onFallback(message) — unrecoverable: caller should switch to the
//                       frequency-based VAD engine.
// onDebug(msg) — every raw sidecar message (dev tracking-quality overlay)

import { API } from './api'
import { buildContextualStrings, createCursorMatcher } from './matcher'

const MAX_RESTARTS = 2
const SPEAKING_HOLD_MS = 900

const FALLBACK_MESSAGES = {
  auth_denied: 'Speech recognition permission denied — using voice-level detection. Enable it in System Settings › Privacy & Security › Speech Recognition.',
  auth_restricted: 'Speech recognition is restricted on this Mac — using voice-level detection.',
  locale_unavailable: 'No speech recognizer for the selected language — using voice-level detection.',
  ondevice_unsupported: 'On-device model for the selected language is not installed — using voice-level detection. Add the language in System Settings › Keyboard › Dictation.',
  audio_error: 'Speech engine could not access the microphone — using voice-level detection.',
  recognizer_storm: 'Speech recognition keeps failing — using voice-level detection.',
}

export function fallbackMessageFor(code, detail) {
  return FALLBACK_MESSAGES[code] || detail || 'Speech recognition unavailable — using voice-level detection.'
}

export function createSpeechTracker({ locale, tokens, scriptText, trickyWords, onUpdate, onStatus, onFallback, onDebug }) {
  const matcher = createCursorMatcher(tokens)
  // Recognition bias inputs: the script's non-stopword vocabulary
  // (contextualStrings on every request) and the user's tricky-words list
  // from Settings (contextual boost + custom-LM pronunciations).
  const contextual = buildContextualStrings(scriptText)
  const tricky = (trickyWords || '').trim()
  let unlisten = null
  let stopped = false
  let restarts = 0
  let speakingTimer = null

  function emitUpdate(pos, confidence) {
    if (speakingTimer) clearTimeout(speakingTimer)
    speakingTimer = setTimeout(() => {
      if (!stopped) onUpdate?.({ ...matcher.position(), confidence: 0, speaking: false })
    }, SPEAKING_HOLD_MS)
    onUpdate?.({ ...pos, confidence: confidence ?? 0, speaking: true })
  }

  function fail(message) {
    const wasStopped = stopped
    cleanup()
    if (!wasStopped) onFallback?.(message)
  }

  function handleMsg(msg) {
    if (stopped || !msg || typeof msg !== 'object') return
    onDebug?.(msg)
    switch (msg.type) {
      case 'ready':
        restarts = 0
        onStatus?.('listening', 'On-device recognition active')
        break
      case 'partial':
      case 'final':
        // Pass the whole message: the matcher uses per-word timestamps for
        // stability gating and falls back to the flat text when absent.
        emitUpdate(matcher.feed(msg.session, msg), msg.confidence)
        break
      case 'error':
        if (msg.fatal) {
          onStatus?.('error', msg.message || msg.code)
          fail(fallbackMessageFor(msg.code, msg.message))
        }
        // Non-fatal errors rotate the session inside the sidecar; nothing to do.
        break
      case 'terminated':
        // Unexpected exit (fatal errors already handled above via their own
        // message). Try a couple of restarts, then fall back.
        if (restarts < MAX_RESTARTS) {
          restarts++
          onStatus?.('starting', 'Speech engine restarting…')
          API.startSpeech(locale, scriptText, contextual, tricky)
        } else {
          fail(fallbackMessageFor('recognizer_storm'))
        }
        break
      default:
        break
    }
  }

  async function start() {
    stopped = false
    onStatus?.('starting', 'Starting speech recognition…')
    unlisten = await API.onSpeechMsg(handleMsg)
    try {
      await API.startSpeech(locale, scriptText, contextual, tricky)
    } catch (e) {
      fail(fallbackMessageFor('audio_error', String(e)))
    }
  }

  function cleanup() {
    stopped = true
    if (speakingTimer) { clearTimeout(speakingTimer); speakingTimer = null }
    if (unlisten) { unlisten(); unlisten = null }
    API.stopSpeech()
  }

  function stop() {
    cleanup()
  }

  function reset() {
    const pos = matcher.reset()
    onUpdate?.({ ...pos, confidence: 0, speaking: false })
  }

  return { start, stop, reset }
}
