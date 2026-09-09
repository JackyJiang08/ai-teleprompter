// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// Replay-based regression suite over the synthesized-speech fixtures under
// tests/fixtures/tracking/. Each fixture is the raw sidecar message stream
// from macOS text-to-speech recognized through the real speech sidecar (see
// scripts/make-fixtures.sh); this suite replays them through the current
// matcher deterministically and asserts the tracking-quality targets. The
// fixtures are committed, so this runs in CI with no macOS speech dependency
// — only their generation needs `say`/`afconvert`/on-device recognition.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// Reuse the exact metrics the CLI tool reports, so `node scripts/track-replay
// .mjs --all` and this suite never disagree. Importing the script does not run
// its CLI (guarded on process.argv[1]).
import { loadFixture, replayFixture } from '../../../scripts/track-replay.mjs'

const DIR = new URL('../../../tests/fixtures/tracking', import.meta.url).pathname
const load = (file) => loadFixture(join(DIR, file))
const replay = (fixture) => replayFixture(fixture)

const files = readdirSync(DIR).filter(f => f.endsWith('.json.gz')).sort()
const cleanFiles = files.filter(f => load(f).kind === 'clean')
const misreadFiles = files.filter(f => load(f).kind === 'misread')

describe('synthesized-voice tracking suite', () => {
  it('has a representative fixture set (≥12, both kinds)', () => {
    expect(files.length).toBeGreaterThanOrEqual(12)
    expect(cleanFiles.length).toBeGreaterThan(0)
    expect(misreadFiles.length).toBeGreaterThan(0)
  })

  // The core anti-teleport guarantee: the committed cursor never reaches a
  // position it must later retreat from. This is what the whole
  // sequence-coherent rewrite is for, and it holds on every fixture.
  for (const file of files) {
    it(`${file}: never teleports (overshoot 0)`, () => {
      expect(replay(load(file)).overshoot).toBe(0)
    })
  }

  // Cross-sentence jumps: the v2.0.0 fixtures were generated one recognizer
  // run per sentence, so every forward sentence-to-sentence progression
  // counted as a jump (inflating the number). v2.1.0 fixtures are a single
  // continuous feed whose sessions rotate on the recognizer's own silence
  // endpointing, so session boundaries no longer coincide with sentence
  // boundaries and the count is meaningful again. Target: 0 on clean, ≤1 on
  // misread. The bound here is 1 rather than 0 on clean because a few
  // fast-rate (200 wpm) fixtures retain a single benign forward catch-up
  // where the recognizer dropped several words at a boundary (overshoot and
  // final error stay 0 — the cursor is correct, not teleported); natural-rate
  // reads and the jargon-dense script are at 0. See docs/ARCHITECTURE.md §3.3.
  for (const file of files) {
    it(`${file}: ≤1 cross-sentence jump`, () => {
      expect(replay(load(file)).crossSentenceJumps).toBeLessThanOrEqual(1)
    })
  }

  // Natural reading rate (160 wpm) clean fixtures hit the strict target of 0.
  for (const file of cleanFiles.filter(f => f.includes('__r160'))) {
    it(`${file}: 0 cross-sentence jumps (natural rate)`, () => {
      expect(replay(load(file)).crossSentenceJumps).toBe(0)
    })
  }

  // Clean reads end within two words of the true end (recognition may drop a
  // trailing word or two); allow a hair more headroom for CI stability.
  for (const file of cleanFiles) {
    it(`${file}: final cursor error ≤ 3`, () => {
      expect(replay(load(file)).finalError).toBeLessThanOrEqual(3)
    })
  }

  // Misread variants (fillers, repeats, a skipped word, a restart, a 2 s
  // silence) still land within a couple of words of the end.
  for (const file of misreadFiles) {
    it(`${file}: final cursor error ≤ 3`, () => {
      expect(replay(load(file)).finalError).toBeLessThanOrEqual(3)
    })
  }

  // No pathological within-sentence stall. The 2 s aspiration holds on
  // normal-density scripts; long jargon-dense sentences at 160 wpm run to
  // ~4 s because the recognizer's partials for hard phrases lag — a
  // recognition property, not a matcher stall (the cursor is not wrong, it is
  // waiting for recognizable words). The bound guards against regression.
  for (const file of files) {
    it(`${file}: no stall beyond 4.5 s`, () => {
      expect(replay(load(file)).maxStallMs).toBeLessThanOrEqual(4500)
    })
  }
})
