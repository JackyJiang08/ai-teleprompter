// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
import { describe, expect, it } from 'vitest'
import { tokenizeDoc } from '../tokenizer'
import { createCursorMatcher, normalizeWord, tokenizeTranscript } from '../matcher'

function scriptTokens(textContent) {
  return tokenizeDoc({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: textContent }] }],
  })
}

describe('normalizeWord', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeWord('Hello,')).toBe('hello')
    expect(normalizeWord("don't")).toBe('dont')
  })

  it('folds full-width characters to half-width', () => {
    expect(normalizeWord('Ｒｅａｃｔ')).toBe('react')
  })
})

describe('tokenizeTranscript', () => {
  it('splits on whitespace, normalized', () => {
    expect(tokenizeTranscript('Hello brave New World.')).toEqual(['hello', 'brave', 'new', 'world'])
  })

  it('drops pure-punctuation pieces', () => {
    expect(tokenizeTranscript('well — the launch!')).toEqual(['well', 'the', 'launch'])
  })
})

describe('createCursorMatcher', () => {
  const tokens = scriptTokens('The quick brown fox jumps over the lazy dog')

  it('advances the cursor on an exact reading', () => {
    const m = createCursorMatcher(tokens)
    let pos = m.feed(1, 'the quick')
    expect(pos.matchedCount).toBe(2)
    pos = m.feed(1, 'the quick brown fox')
    expect(pos.matchedCount).toBe(4)
    expect(pos.done).toBe(false)
  })

  it('reports the token index of the next expected word', () => {
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, 'the quick')
    // next expected is 'brown', the third word token
    expect(tokens[pos.cursorTokenIndex].text).toBe('brown')
  })

  it('tolerates skipped script words within the lookahead window', () => {
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, 'the quick jumps') // skipped 'brown fox'
    expect(pos.matchedCount).toBe(5) // cursor lands after 'jumps'
    expect(tokens[pos.cursorTokenIndex].text).toBe('over')
  })

  it('ignores filler words without moving the cursor', () => {
    const m = createCursorMatcher(tokens)
    let pos = m.feed(1, 'the quick um uh')
    expect(pos.matchedCount).toBe(2)
    pos = m.feed(1, 'the quick um uh brown')
    expect(pos.matchedCount).toBe(3)
  })

  it('holds position on a misread, then recovers on the next correct word', () => {
    const m = createCursorMatcher(tokens)
    let pos = m.feed(1, 'the quick crown') // 'crown' matches nothing
    expect(pos.matchedCount).toBe(2)
    pos = m.feed(1, 'the quick crown brown fox')
    expect(pos.matchedCount).toBe(4)
  })

  it('never moves backward, even if earlier words are repeated', () => {
    const m = createCursorMatcher(tokens)
    m.feed(1, 'the quick brown fox jumps')
    const pos = m.feed(2, 'the quick') // new session re-says old words
    // 'the' matches the SECOND 'the' (within lookahead) — forward only
    expect(pos.matchedCount).toBeGreaterThanOrEqual(5)
  })

  it('does not teleport past the lookahead window on a stray common word', () => {
    const longScript = scriptTokens(
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi the end'
    )
    const m = createCursorMatcher(longScript, { lookahead: 12 })
    const pos = m.feed(1, 'the') // 'the' exists at position 17, beyond lookahead
    expect(pos.matchedCount).toBe(0)
  })

  it('handles partial-transcript revisions without reprocessing the prefix', () => {
    const m = createCursorMatcher(tokens)
    m.feed(1, 'the quick bro')     // partial: 'bro' matches nothing
    m.feed(1, 'the quick brown')   // revision of the tail
    const pos = m.position()
    expect(pos.matchedCount).toBe(3)
  })

  it('completes and reports done', () => {
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, 'the quick brown fox jumps over the lazy dog')
    expect(pos.done).toBe(true)
    expect(pos.cursorTokenIndex).toBe(-1)
  })
})

describe('createCursorMatcher — sessions and reset', () => {
  const tokens = scriptTokens('one two three four five six')

  it('keeps the cursor across sidecar session rotation', () => {
    const m = createCursorMatcher(tokens)
    m.feed(1, 'one two three')
    const pos = m.feed(2, 'four five') // new session, fresh transcript
    expect(pos.matchedCount).toBe(5)
  })

  it('reset() returns the cursor to the top', () => {
    const m = createCursorMatcher(tokens)
    m.feed(1, 'one two three')
    const pos = m.reset()
    expect(pos.matchedCount).toBe(0)
    expect(tokens[pos.cursorTokenIndex].text).toBe('one')
  })
})
