// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// Display coasting: keep the highlighted (display) word moving while the
// recognizer catches up. When the frequency-based voice-activity signal says
// the reader is still speaking but no new recognizer partial has arrived for
// a gap, the display cursor advances at the reader's recently measured rate,
// capped a few words past the confirmed position. It is DISPLAY ONLY — the
// committed cursor, and therefore every accuracy metric, is untouched — and
// eases back to the truth the moment a real match arrives.
//
// Everything here is pure and unit-tested; ReadView owns the timers, the
// VAD engine, and the word↔token mapping.

export const COAST_GAP_MS = 800     // no partial for this long → start coasting
export const COAST_CAP_WORDS = 8    // never coast more than this past committed
export const RATE_WINDOW_MS = 6000  // rolling window for the rate estimate
export const FALLBACK_WPS = 2.5     // ~150 wpm until we have a measurement

// Rolling reading-rate estimate (words per second) from committed advances.
// record() is called with the running committed-word count and a timestamp;
// only increases count. wordsPerSecond() fits a rate over the recent window.
export function createReadingRate({ windowMs = RATE_WINDOW_MS, fallbackWps = FALLBACK_WPS } = {}) {
  const samples = [] // { t, words }, monotonically increasing in both
  return {
    record(words, t) {
      const last = samples[samples.length - 1]
      if (last && words <= last.words) return   // no new committed word
      samples.push({ t, words })
      while (samples.length > 2 && t - samples[0].t > windowMs) samples.shift()
    },
    wordsPerSecond() {
      if (samples.length < 2) return fallbackWps
      const first = samples[0]
      const last = samples[samples.length - 1]
      const dt = (last.t - first.t) / 1000
      if (dt <= 0) return fallbackWps
      const wps = (last.words - first.words) / dt
      // Ignore an implausibly slow/degenerate estimate.
      return wps >= 0.3 ? wps : fallbackWps
    },
    reset() { samples.length = 0 },
  }
}

// Compute the display word position for this frame. Returns a fractional word
// index (>= provisionalWords). When not coasting it equals provisionalWords,
// so the caller can tell "coasting" from displayWords > provisionalWords.
//
//   committedWords    confirmed cursor (words) — the coast cap anchors here
//   provisionalWords  matcher display cursor (words) — the coast base
//   lastMatchMs       when provisionalWords last advanced
//   nowMs             current time
//   wps               reading-rate estimate (words/second)
//   speaking          frequency-VAD says the reader is voicing
//   enabled           the Settings toggle
export function coastDisplayWords({
  committedWords, provisionalWords, lastMatchMs, nowMs, wps,
  speaking, enabled = true, gapMs = COAST_GAP_MS, capWords = COAST_CAP_WORDS,
}) {
  const base = provisionalWords
  if (!enabled || !speaking || lastMatchMs == null) return base
  const gap = nowMs - lastMatchMs
  if (gap <= gapMs) return base
  const coastSecs = (gap - gapMs) / 1000
  const advanced = base + Math.max(0, wps) * coastSecs
  const cap = committedWords + capWords
  return Math.min(Math.max(base, advanced), Math.max(base, cap))
}
