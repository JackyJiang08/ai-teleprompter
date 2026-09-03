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
// onUpdate({ cursorTokenIndex, matchedCount, total, done, confidence, speaking })
// onStatus(status, message) — 'starting' | 'listening' | 'error'
// onFallback(message) — unrecoverable: caller should switch to the
//                       frequency-based VAD engine.
// onDebug(msg) — every raw sidecar message (dev tracking-quality overlay)

import { API } from './api'
import { createCursorMatcher } from './matcher'

// Script language vs recognition locale sanity check. Returns a warning
// string for a clear mismatch (tracking would stall silently), '' otherwise.
// Mixed-language scripts (both ratios in range) are fine — the tokenizer and
// matcher handle them per-word/per-character.
export function languageMismatchMessage(scriptText, locale) {
  const text = scriptText || ''
  let cjk = 0
  let total = 0
  for (const ch of text) {
    if (/\s/.test(ch)) continue
    total++
    if (/[㐀-䶿一-鿿豈-﫿]/.test(ch)) cjk++
  }
  if (total < 10) return ''
  const ratio = cjk / total
  if (locale === 'zh-CN' && ratio < 0.05) {
    return 'The script looks English but word tracking is set to 中文 — tracking will not advance. Switch the language in Settings.'
  }
  if (locale === 'en-US' && ratio > 0.7) {
    return 'The script is mostly Chinese but word tracking is set to English — tracking will not advance. Switch the language in Settings (中文).'
  }
  return ''
}

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

export function createSpeechTracker({ locale, tokens, scriptText, onUpdate, onStatus, onFallback, onDebug }) {
  const matcher = createCursorMatcher(tokens)
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
        emitUpdate(matcher.feed(msg.session, msg.text), msg.confidence)
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
          API.startSpeech(locale, scriptText)
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
      await API.startSpeech(locale, scriptText)
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
