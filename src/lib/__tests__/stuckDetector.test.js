// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
import { describe, expect, it } from 'vitest'
import { createStuckDetector, STUCK_MS } from '../stuckDetector.js'

describe('createStuckDetector', () => {
  it('flags after sustained voicing with no partial and no cursor movement', () => {
    const d = createStuckDetector()
    d.vad(true, 0)
    expect(d.poll(1000)).toBe(false)          // < 3 s
    expect(d.poll(STUCK_MS - 1)).toBe(false)  // just under
    expect(d.poll(STUCK_MS + 1)).toBe(true)   // past the threshold
    expect(d.isStuck).toBe(true)
  })

  it('does not flag before the threshold', () => {
    const d = createStuckDetector()
    d.vad(true, 0)
    expect(d.poll(2999)).toBe(false)
  })

  it('clears immediately when a partial arrives', () => {
    const d = createStuckDetector()
    d.vad(true, 0)
    expect(d.poll(3100)).toBe(true)
    d.partial(3200)
    expect(d.isStuck).toBe(false)
    expect(d.poll(3300)).toBe(false)          // stays clear: partial is within this voicing run
  })

  it('never flags while partials keep arriving (recognizer lag, not stuck)', () => {
    const d = createStuckDetector()
    d.vad(true, 0)
    // A hard phrase: partials arrive every 250 ms but the cursor does not move.
    for (let t = 250; t <= 6000; t += 250) {
      d.partial(t)
      expect(d.poll(t)).toBe(false)
    }
  })

  it('clears when voicing stops', () => {
    const d = createStuckDetector()
    d.vad(true, 0)
    expect(d.poll(3100)).toBe(true)
    d.vad(false, 3200)
    expect(d.isStuck).toBe(false)
    expect(d.poll(3300)).toBe(false)
  })

  it('does not flag if the committed cursor advanced during voicing', () => {
    const d = createStuckDetector()
    d.commit(4)          // cursor at 4 before this voicing run
    d.vad(true, 0)
    d.commit(5)          // advanced while voicing
    expect(d.poll(3100)).toBe(false)
  })

  it('re-arms after voicing stops and restarts', () => {
    const d = createStuckDetector()
    d.vad(true, 0)
    d.partial(500)       // recognition worked in the first run
    expect(d.poll(4000)).toBe(false)
    d.vad(false, 4500)
    d.vad(true, 5000)    // new voicing run; the old partial predates it
    expect(d.poll(8100)).toBe(true)
  })

  it('reset() returns to the initial state', () => {
    const d = createStuckDetector()
    d.vad(true, 0)
    expect(d.poll(3100)).toBe(true)
    d.reset()
    expect(d.isStuck).toBe(false)
    expect(d.poll(9999)).toBe(false)
  })
})
