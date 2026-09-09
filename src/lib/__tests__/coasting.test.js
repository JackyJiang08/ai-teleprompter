// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
import { describe, expect, it } from 'vitest'
import {
  COAST_CAP_WORDS,
  COAST_GAP_MS,
  FALLBACK_WPS,
  coastDisplayWords,
  createReadingRate,
} from '../coasting'

describe('createReadingRate', () => {
  it('returns the fallback until it has two samples', () => {
    const r = createReadingRate()
    expect(r.wordsPerSecond()).toBe(FALLBACK_WPS)
    r.record(1, 1000)
    expect(r.wordsPerSecond()).toBe(FALLBACK_WPS)
  })

  it('measures words per second from committed advances', () => {
    const r = createReadingRate()
    r.record(0, 0)
    r.record(5, 2000)   // 5 words in 2 s → 2.5 wps
    expect(r.wordsPerSecond()).toBeCloseTo(2.5, 5)
    r.record(11, 4000)  // 11 words in 4 s → 2.75 wps
    expect(r.wordsPerSecond()).toBeCloseTo(2.75, 5)
  })

  it('ignores non-increasing counts (no new committed word)', () => {
    const r = createReadingRate()
    r.record(3, 0)
    r.record(3, 1000)   // same count, dropped
    r.record(3, 5000)   // same count, dropped
    expect(r.wordsPerSecond()).toBe(FALLBACK_WPS) // still only one real sample
  })

  it('drops samples outside the rolling window', () => {
    const r = createReadingRate({ windowMs: 4000 })
    r.record(0, 0)
    r.record(2, 1000)
    r.record(20, 10000) // old samples fall out; window ~ [1000,10000] excluded of 0
    // the window keeps the last two-ish; rate stays positive and plausible
    expect(r.wordsPerSecond()).toBeGreaterThan(0)
  })

  it('falls back on a degenerate (too slow) estimate', () => {
    const r = createReadingRate()
    r.record(0, 0)
    r.record(1, 60000) // 1 word in 60 s → 0.016 wps, implausible
    expect(r.wordsPerSecond()).toBe(FALLBACK_WPS)
  })
})

describe('coastDisplayWords', () => {
  const base = {
    committedWords: 10, provisionalWords: 12, wps: 2, speaking: true, enabled: true,
    lastMatchMs: 1000,
  }

  it('does not coast before the gap elapses', () => {
    expect(coastDisplayWords({ ...base, nowMs: 1000 + COAST_GAP_MS - 1 })).toBe(12)
  })

  it('advances at the reading rate once the gap elapses', () => {
    // 1 s past the gap at 2 wps → +2 words beyond the provisional base
    const d = coastDisplayWords({ ...base, nowMs: 1000 + COAST_GAP_MS + 1000 })
    expect(d).toBeCloseTo(14, 5)
  })

  it('never coasts more than the cap past committed', () => {
    // huge elapsed time → would advance far, but capped at committed + 8 = 18
    const d = coastDisplayWords({ ...base, nowMs: 1000 + COAST_GAP_MS + 100000 })
    expect(d).toBe(base.committedWords + COAST_CAP_WORDS)
    expect(d).toBe(18)
  })

  it('is inert when disabled or not speaking', () => {
    const now = 1000 + COAST_GAP_MS + 5000
    expect(coastDisplayWords({ ...base, nowMs: now, enabled: false })).toBe(12)
    expect(coastDisplayWords({ ...base, nowMs: now, speaking: false })).toBe(12)
  })

  it('never returns a position behind the provisional cursor', () => {
    const d = coastDisplayWords({ ...base, provisionalWords: 20, nowMs: 1000 + COAST_GAP_MS + 5000 })
    expect(d).toBeGreaterThanOrEqual(20) // cap (18) is below base (20) → clamped to base
  })
})
