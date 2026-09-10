// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
//
// Detects the "voicing but no recognition" condition: the sidecar's VAD
// reports the reader is speaking (the microphone tap has energy) yet no
// recognition partial arrives and the committed cursor does not move for a
// sustained stretch. That is the signature of Microphone granted while Speech
// Recognition is denied, or the on-device English model being unavailable —
// the mic delivers audio, but SFSpeechRecognizer emits nothing. It is NOT the
// same as the recognizer merely lagging on a hard phrase: there, partials keep
// arriving (revisions) even while the cursor waits, so `partial()` fires and
// the detector stays clear.
//
// Pure and event-driven so it can be unit-tested with a synthetic stream:
// feed vad()/partial()/commit() events with timestamps, then poll(now).

export const STUCK_MS = 3000

export function createStuckDetector({ thresholdMs = STUCK_MS } = {}) {
  let speakingSince = null       // ms the current continuous voicing began (null = not voicing)
  let lastPartialAt = null       // ms of the most recent recognition partial/final
  let committed = 0              // latest committed word count
  let committedAtSpeakStart = 0  // committed count when the current voicing began
  let stuck = false

  return {
    // VAD voicing edge from the sidecar `vad` message.
    vad(speaking, t) {
      if (speaking) {
        if (speakingSince === null) { speakingSince = t; committedAtSpeakStart = committed }
      } else {
        speakingSince = null
        stuck = false
      }
    },
    // A real recognition partial/final arrived — recognition is alive.
    partial(t) { lastPartialAt = t; stuck = false },
    // The committed cursor moved to `count`.
    commit(count) {
      committed = count
      if (count > committedAtSpeakStart) stuck = false
    },
    // Evaluate at time `now`; returns whether the stuck hint should show.
    poll(now) {
      if (speakingSince === null || now - speakingSince < thresholdMs) return stuck
      const noPartialSinceSpeaking = lastPartialAt === null || lastPartialAt < speakingSince
      const committedNotMoved = committed <= committedAtSpeakStart
      stuck = noPartialSinceSpeaking && committedNotMoved
      return stuck
    },
    get isStuck() { return stuck },
    reset() {
      speakingSince = null; lastPartialAt = null
      committed = 0; committedAtSpeakStart = 0; stuck = false
    },
  }
}
