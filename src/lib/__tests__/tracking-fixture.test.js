// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// Replays the recorded synthetic-teleport fixture (the sentence-3-to-4
// teleport that motivated the sequence-coherent matcher) end to end. The
// legacy greedy matcher jumps to sentence 4 on the stray "I" and loses half
// of sentence 3; the current matcher must align every sentence completely
// with no jumps. scripts/track-replay.mjs prints the same numbers.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tokenizeDoc } from '../tokenizer'
import { createCursorMatcher } from '../matcher'

const fixture = JSON.parse(readFileSync(
  new URL('../../../tests/fixtures/tracking/synthetic-teleport.json', import.meta.url), 'utf8'))

function fixtureTokens() {
  return tokenizeDoc({
    type: 'doc',
    content: fixture.script.split('\n').map(line => ({
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    })),
  })
}

describe('synthetic-teleport fixture', () => {
  it('replays with no jumps and full committed alignment', () => {
    const tokens = fixtureTokens()
    const m = createCursorMatcher(tokens)
    for (const msg of fixture.messages) {
      if (msg.type === 'partial' || msg.type === 'final') m.feed(msg.session, msg)
    }
    const pos = m.position()
    const { jumps, backtracks, confirmedEntries } = m.stats()

    expect(jumps).toHaveLength(0)          // the stray "I" never causes a jump
    expect(backtracks).toBe(0)
    expect(pos.matchedCount).toBe(fixture.expectedFinal)
    expect(pos.done).toBe(true)
    expect(confirmedEntries.size).toBe(fixture.expectedFinal) // every word confirmed, none skipped
  })
})
