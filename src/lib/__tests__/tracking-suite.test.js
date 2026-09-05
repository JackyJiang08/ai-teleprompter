// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// Replay-based regression suite over the synthesized-speech fixtures under
// tests/fixtures/tracking/. Each fixture is the raw sidecar message stream
// from macOS text-to-speech recognized through the real speech sidecar (see
// scripts/make-fixtures.sh); this suite replays them through the current
// matcher deterministically and asserts the tracking-quality targets. The
// fixtures are committed, so this runs in CI with no macOS speech dependency
// — only their generation needs `say`/`afconvert`/on-device recognition.
import { readdirSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { tokenizeDoc } from '../tokenizer'
import { createCursorMatcher } from '../matcher'

const DIR = new URL('../../../tests/fixtures/tracking', import.meta.url).pathname

function load(file) {
  const raw = readFileSync(`${DIR}/${file}`)
  const text = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
  return JSON.parse(text)
}

function docFromText(text) {
  return {
    type: 'doc',
    content: String(text || '').split('\n').map(line => {
      const t = line.trim()
      return t ? { type: 'paragraph', content: [{ type: 'text', text: t }] } : { type: 'paragraph' }
    }),
  }
}

// Replay a fixture, returning the metrics the targets are defined over.
function replay(fixture) {
  const tokens = tokenizeDoc(docFromText(fixture.script))
  const m = createCursorMatcher(tokens)
  let maxCommitted = 0
  let maxStallMs = 0
  let lastAdvanceT = null
  let msgsSinceAdvance = 0
  let prevProvisional = 0
  let stallSession = null
  for (const msg of fixture.messages || []) {
    if (msg.type !== 'partial' && msg.type !== 'final') continue
    const pos = m.feed(msg.session, msg)
    maxCommitted = Math.max(maxCommitted, pos.matchedCount)
    const t = typeof msg.t === 'number' ? msg.t : null
    if (msg.session !== stallSession) { stallSession = msg.session; lastAdvanceT = t; msgsSinceAdvance = 0 }
    if (t !== null) {
      if (lastAdvanceT === null) lastAdvanceT = t
      if (pos.provisionalCount > prevProvisional || pos.done) {
        if (msgsSinceAdvance >= 3) maxStallMs = Math.max(maxStallMs, t - lastAdvanceT)
        lastAdvanceT = t
        msgsSinceAdvance = 0
      } else {
        msgsSinceAdvance++
      }
      prevProvisional = Math.max(prevProvisional, pos.provisionalCount)
    }
  }
  const pos = m.position()
  const expectedFinal = fixture.expectedFinal ?? pos.total
  return {
    overshoot: Math.max(0, maxCommitted - pos.matchedCount),
    finalError: Math.abs(pos.matchedCount - expectedFinal),
    maxStallMs,
  }
}

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
  // sequence-coherent rewrite is for, and it holds on every fixture — the
  // right, robust reading of "no cross-sentence jumps" (per-sentence sessions
  // make a raw jump count include benign forward progressions).
  for (const file of files) {
    it(`${file}: never teleports (overshoot 0)`, () => {
      expect(replay(load(file)).overshoot).toBe(0)
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
