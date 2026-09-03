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

  it('folds full-width characters and strips CJK punctuation', () => {
    expect(normalizeWord('Ｒｅａｃｔ，')).toBe('react')
    expect(normalizeWord('好。')).toBe('好')
  })
})

describe('tokenizeTranscript', () => {
  it('splits English on whitespace, normalized', () => {
    expect(tokenizeTranscript('Hello brave New World.')).toEqual(['hello', 'brave', 'new', 'world'])
  })

  it('splits Chinese per character', () => {
    expect(tokenizeTranscript('今天天气很好')).toEqual(['今', '天', '天', '气', '很', '好'])
  })

  it('handles mixed text and drops pure-punctuation pieces', () => {
    expect(tokenizeTranscript('我们的 React 项目！')).toEqual(['我', '们', '的', 'react', '项', '目'])
  })
})

describe('createCursorMatcher — English', () => {
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

describe('createCursorMatcher — Mandarin', () => {
  const tokens = scriptTokens('今天天气很好 我们出去走走')

  it('advances per character as partials grow', () => {
    const m = createCursorMatcher(tokens)
    let pos = m.feed(1, '今天')
    expect(pos.matchedCount).toBe(2)
    pos = m.feed(1, '今天天气')
    expect(pos.matchedCount).toBe(4)
    pos = m.feed(1, '今天天气很好我们')
    expect(pos.matchedCount).toBe(8)
  })

  it('tolerates a skipped character', () => {
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, '今天气') // reader dropped the second 天
    expect(pos.matchedCount).toBe(4)
  })

  it('ignores Mandarin filler words', () => {
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, '今天 嗯 天气')
    // 嗯 is not in the script; cursor still lands after 天气
    expect(pos.matchedCount).toBe(4)
  })
})

describe('createCursorMatcher — mixed language', () => {
  const tokens = scriptTokens('我们的React项目 launches 今天 stay tuned')

  it('tracks across script switches', () => {
    const m = createCursorMatcher(tokens)
    let pos = m.feed(1, '我们的 react')
    expect(pos.matchedCount).toBe(4)
    pos = m.feed(1, '我们的 react 项目 launches')
    expect(pos.matchedCount).toBe(7)
    pos = m.feed(1, '我们的 react 项目 launches 今天 stay tuned')
    expect(pos.done).toBe(true)
  })

  it('absorbs an untranscribed English word inside a Chinese session', () => {
    const m = createCursorMatcher(tokens)
    // zh-CN recognizer garbles 'launches' → no match; next Chinese chars recover
    const pos = m.feed(1, '我们的 react 项目 launch us 今天')
    expect(pos.matchedCount).toBe(9) // through 今天
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

// ── WS6: language mismatch detection ───────────────────────
import { languageMismatchMessage } from '../speech'

describe('languageMismatchMessage', () => {
  const en = 'the quick brown fox jumps over the lazy dog near the bridge'
  const zh = '今天天气很好我们出去走走慢慢来大家一起加油'
  const mixed = '我们的React项目 launches today 大家好 stay tuned 谢谢大家'

  it('flags an English script with 中文 tracking', () => {
    expect(languageMismatchMessage(en, 'zh-CN')).toMatch(/English/)
  })
  it('flags a Chinese script with English tracking', () => {
    expect(languageMismatchMessage(zh, 'en-US')).toMatch(/Chinese/)
  })
  it('accepts matched and mixed scripts', () => {
    expect(languageMismatchMessage(en, 'en-US')).toBe('')
    expect(languageMismatchMessage(zh, 'zh-CN')).toBe('')
    expect(languageMismatchMessage(mixed, 'en-US')).toBe('')
    expect(languageMismatchMessage(mixed, 'zh-CN')).toBe('')
  })
  it('stays quiet on tiny scripts', () => {
    expect(languageMismatchMessage('hi', 'zh-CN')).toBe('')
  })
})
