// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
import { describe, expect, it } from 'vitest'
import { tokenizeDoc } from '../tokenizer'
import {
  buildContextualStrings,
  createCursorMatcher,
  expandWordForms,
  normalizeWord,
  tokenizeTranscript,
} from '../matcher'

function scriptTokens(...paragraphs) {
  return tokenizeDoc({
    type: 'doc',
    content: paragraphs.map(text => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    })),
  })
}

// A plain string feeds as a partial (its last TAIL_TENTATIVE=2 words stay
// tentative). A final commits the whole transcript. `commit()` feeds a final,
// so alignment tests see the words of interest fully committed.
const P = (text) => ({ text })
const F = (text) => ({ text, type: 'final' })
function commit(m, session, text) {
  return m.feed(session, F(text))
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

describe('expandWordForms — spoken-form normalization', () => {
  it('expands plain numbers', () => {
    expect(expandWordForms('23').primary).toEqual(['twenty', 'three'])
    expect(expandWordForms('7').primary).toEqual(['seven'])
  })

  it('expands percentages', () => {
    expect(expandWordForms('23%').primary).toEqual(['twenty', 'three', 'percent'])
  })

  it('expands years pairwise with the long reading as an alternate', () => {
    const f = expandWordForms('2027')
    expect(f.primary).toEqual(['twenty', 'twenty', 'seven'])
    expect(f.alts).toContainEqual(['two', 'thousand', 'twenty', 'seven'])
  })

  it('expands all-caps acronyms to letter sequences', () => {
    const f = expandWordForms('UIUC')
    expect(f.primary).toEqual(['u', 'i', 'u', 'c'])
    expect(f.alts).toContainEqual(['uiuc'])
  })

  it('splits hyphenated compounds with the joined form as an alternate', () => {
    const f = expandWordForms('voice-activated')
    expect(f.primary).toEqual(['voice', 'activated'])
    expect(f.alts).toContainEqual(['voiceactivated'])
  })

  it('accepts possessives with and without the s', () => {
    const f = expandWordForms("world's")
    expect(f.primary).toEqual(['worlds'])
    expect(f.alts).toContainEqual(['world'])
  })
})

describe('tokenizeTranscript', () => {
  it('splits on whitespace, normalized', () => {
    expect(tokenizeTranscript('Hello brave New World.')).toEqual(['hello', 'brave', 'new', 'world'])
  })

  it('expands formatted numbers into spoken words', () => {
    expect(tokenizeTranscript('growth hit 23%')).toEqual(['growth', 'hit', 'twenty', 'three', 'percent'])
  })
})

describe('buildContextualStrings', () => {
  it('keeps original casing, drops stopwords, deduplicates, and caps', () => {
    const out = buildContextualStrings('The Merton model and the KMV model at UIUC')
    expect(out).toEqual(['Merton', 'model', 'KMV', 'UIUC'])
    const many = buildContextualStrings(
      Array.from({ length: 300 }, (_, i) => `word${i}`).join(' '))
    expect(many).toHaveLength(100)
  })
})

describe('stability gating', () => {
  const tokens = scriptTokens('The quick brown fox jumps over the lazy dog')

  it('a partial holds its last two words tentative — they show but do not commit', () => {
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, P('the quick brown fox'))
    expect(pos.matchedCount).toBe(2)     // "the quick" committed
    expect(pos.provisionalCount).toBe(4) // "brown fox" tentative, shown only
  })

  it('a very short partial commits nothing yet', () => {
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, P('the quick'))
    expect(pos.matchedCount).toBe(0)
    expect(pos.provisionalCount).toBe(2)
  })

  it('a final result commits everything at once', () => {
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, F('the quick brown fox'))
    expect(pos.matchedCount).toBe(4)
    expect(pos.done).toBe(false)
  })

  it('older words commit as newer tentative words arrive', () => {
    const m = createCursorMatcher(tokens)
    m.feed(1, P('the quick brown'))
    const pos = m.feed(1, P('the quick brown fox jumps'))
    expect(pos.matchedCount).toBe(3)     // "the quick brown" now behind the tail
    expect(pos.provisionalCount).toBe(5)
  })

  it('trustworthy segment timestamps let old words commit past the tail', () => {
    // With a realistic time span the age rule applies: words older than
    // ~600 ms commit even inside the last-two-words tentative window, so four
    // of the five commit (only the newest is still tentative) — versus three
    // under the position rule alone.
    const words = 'the quick brown fox jumps'.split(' ').map((w, i) => ({ w, t: i * 0.6, d: 0.3 }))
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, { text: 'the quick brown fox jumps', words })
    expect(pos.matchedCount).toBe(4)
  })

  it('the provisional cursor never falls behind the committed one', () => {
    const m = createCursorMatcher(tokens)
    m.feed(1, P('the quick brown fox jumps'))
    const pos = m.feed(1, P('the quick brown'))
    expect(pos.provisionalCount).toBeGreaterThanOrEqual(pos.matchedCount)
  })
})

describe('stopword rule', () => {
  // Sentence 4 starts with "I" — the classic teleport bait.
  const tokens = scriptTokens(
    'We built the tracking engine over the summer.',
    'I think the results speak for themselves.',
  )

  it('a stray stopword never justifies a jump', () => {
    // Mid-line reading (no pause yet) is a partial, not a final.
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, P('we built the i'))
    // the provisional cursor is still inside sentence 1, not teleported to
    // the "I" that begins sentence 2
    expect(tokens[pos.provisionalTokenIndex].text).not.toBe('I')
    expect(pos.provisionalCount).toBeLessThanOrEqual(4)
    expect(m.stats().jumps).toHaveLength(0)
  })

  it('a stopword still confirms the next expected word', () => {
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, P('we built the tracking engine')) // "the" (stopword) confirmed word 3
    expect(pos.provisionalCount).toBe(5) // we built the tracking engine
    expect(m.stats().jumps).toHaveLength(0)
  })

  it('regression: the stray-I mid-sentence does not teleport to the next sentence', () => {
    const m = createCursorMatcher(tokens)
    m.feed(1, P('we built the i'))
    const pos = commit(m, 1, 'we built the tracking engine over the summer')
    expect(pos.matchedCount).toBe(8) // whole first sentence, in order
    expect(m.stats().jumps).toHaveLength(0)
  })
})

describe('jump rule (bigram anchor)', () => {
  const tokens = scriptTokens('alpha beta gamma delta epsilon zeta')

  it('two consecutive matching words justify a nearest jump', () => {
    const m = createCursorMatcher(tokens)
    const pos = commit(m, 1, 'alpha delta epsilon')
    expect(pos.matchedCount).toBe(5) // beta+gamma absorbed, cursor after epsilon
    expect(m.stats().jumps).toEqual([{ from: 1, to: 3 }])
  })

  it('a single distant word — even a rare one — does not jump', () => {
    const m = createCursorMatcher(tokens)
    const pos = commit(m, 1, 'alpha epsilon')
    expect(pos.matchedCount).toBe(1)
    expect(m.stats().jumps).toHaveLength(0)
  })

  it('prefers the nearest candidate position', () => {
    const t2 = scriptTokens('x q delta echo y delta echo z')
    const m = createCursorMatcher(t2)
    commit(m, 1, 'x delta echo')
    const pos = m.position()
    // lands after the FIRST "delta echo", expecting "y"
    expect(t2[pos.cursorTokenIndex].text).toBe('y')
  })

  it('caps a single advance at 6 words', () => {
    const t2 = scriptTokens('one two three four five six seven eight nine ten')
    const m = createCursorMatcher(t2)
    const pos = commit(m, 1, 'one nine ten') // 7 words ahead — too far
    expect(pos.matchedCount).toBe(1)
    expect(m.stats().jumps).toHaveLength(0)
  })
})

describe('bounded backtrack', () => {
  const tokens = scriptTokens('alpha beta gamma delta epsilon zeta eta')

  it('a stable bigram up to 3 words behind corrects a wrong jump', () => {
    const m = createCursorMatcher(tokens)
    m.feed(1, F('alpha delta epsilon')) // jumps over beta+gamma, committed = 5
    expect(m.position().matchedCount).toBe(5)
    const pos = m.feed(2, F('gamma delta'))
    expect(pos.matchedCount).toBe(4) // moved back behind zeta
    expect(m.stats().backtracks).toBeGreaterThanOrEqual(1)
  })

  it('never moves back more than 3 words', () => {
    const m = createCursorMatcher(tokens)
    m.feed(1, F('alpha beta gamma delta epsilon')) // committed = 5
    const pos = m.feed(2, F('alpha beta')) // 5 words back — out of range
    expect(pos.matchedCount).toBe(5)
  })
})

describe('long resync (trigram anchor)', () => {
  // A twelve-word script; the recognizer drops the first eight words and only
  // catches the tail — far beyond the six-word bigram jump cap.
  const tokens = scriptTokens('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu')

  it('recovers from a dropped sentence via three consecutive matches', () => {
    const m = createCursorMatcher(tokens)
    const pos = commit(m, 1, 'iota kappa lambda mu') // 8 words ahead
    expect(pos.matchedCount).toBe(12)
    expect(m.stats().jumps).toEqual([{ from: 0, to: 8 }])
  })

  it('a two-word match alone does not resync over a long gap', () => {
    const m = createCursorMatcher(tokens)
    const pos = commit(m, 1, 'kappa lambda') // only a bigram, 9 words ahead
    expect(pos.matchedCount).toBe(0)
    expect(m.stats().jumps).toHaveLength(0)
  })
})

describe('a final is authoritative', () => {
  // Finals replace the stable prefix outright, even when they revise a word
  // more than the backtrack window behind — a partial's mishearing must not
  // outweigh the recognizer's final answer.
  const tokens = scriptTokens('one two three four five six seven eight nine')

  it('a final overrides a deep revision a partial locked in', () => {
    const m = createCursorMatcher(tokens)
    m.feed(1, P('one two three four five six seven')) // commits ~five
    const pos = m.feed(1, F('one XX three four five six seven eight nine'))
    // "two" misheard as XX in the final, but everything after realigns
    expect(pos.matchedCount).toBe(9)
    expect(pos.done).toBe(true)
  })
})

describe('line completion on a final', () => {
  // A final is delivered at the pause after a line, so its last few dropped
  // words are committed — the next line's session then aligns from the true
  // boundary instead of jumping to catch up.
  const tokens = scriptTokens(
    'Alpha bravo charlie delta echo foxtrot.',   // line 1, entries 0-5
    'Golf hotel india juliet kilo lima.',         // line 2, entries 6-11
  )

  it("completes a non-final line whose last words the recognizer dropped", () => {
    const m = createCursorMatcher(tokens)
    // recognizer got only the first four words of line 1, then the pause
    const pos = m.feed(1, F('alpha bravo charlie delta'))
    expect(pos.matchedCount).toBe(6) // echo + foxtrot completed to the line end
    expect(tokens[pos.cursorTokenIndex].text).toBe('Golf')
  })

  it('does not complete past LINE_COMPLETE_SLACK (a genuine mid-line pause)', () => {
    const midTokens = scriptTokens(
      'One two three four five six seven eight nine ten eleven.', // 11-word line
      'Next line here to make the first one non-final.',
    )
    const m = createCursorMatcher(midTokens)
    const pos = m.feed(1, F('one two three')) // 8 words still to come — far from end
    expect(pos.matchedCount).toBe(3) // not completed
  })

  it('never completes the last line (nothing follows to catch up)', () => {
    const single = scriptTokens('alpha bravo charlie delta echo foxtrot')
    const m = createCursorMatcher(single)
    const pos = m.feed(1, F('alpha bravo charlie delta')) // within slack of the end
    expect(pos.matchedCount).toBe(4) // left where the recognizer put it
    expect(pos.done).toBe(false)
  })
})

describe('fuzzy matching', () => {
  it('accepts edit distance 1 on words of 5+ letters', () => {
    const m = createCursorMatcher(scriptTokens('the tracking engine'))
    const pos = commit(m, 1, 'the trackin engine')
    expect(pos.matchedCount).toBe(3)
  })

  it('requires exact matches for short words', () => {
    const m = createCursorMatcher(scriptTokens('the cat sat'))
    const pos = commit(m, 1, 'the cab')
    expect(pos.matchedCount).toBe(1) // "cab" ≠ "cat"
  })
})

describe('normalization end to end', () => {
  it('matches percentages spoken or formatted', () => {
    const t = scriptTokens('growth hit 23% this year')
    const spoken = createCursorMatcher(t)
    expect(commit(spoken, 1, 'growth hit twenty three percent').matchedCount).toBe(3)
    const formatted = createCursorMatcher(t)
    expect(commit(formatted, 1, 'growth hit 23%').matchedCount).toBe(3)
  })

  it('matches years in both readings', () => {
    const t = scriptTokens('shipping in 2027 worldwide')
    const a = createCursorMatcher(t)
    expect(commit(a, 1, 'shipping in twenty twenty seven').matchedCount).toBe(3)
    const b = createCursorMatcher(t)
    expect(commit(b, 1, 'shipping in two thousand twenty seven').matchedCount).toBe(3)
  })

  it('matches acronyms spelled out or merged', () => {
    const t = scriptTokens('I studied at UIUC in Illinois')
    const a = createCursorMatcher(t)
    expect(commit(a, 1, 'i studied at u i u c').matchedCount).toBe(4)
    const b = createCursorMatcher(t)
    expect(commit(b, 1, 'i studied at UIUC').matchedCount).toBe(4)
  })

  it('matches hyphenated compounds spoken as separate words', () => {
    const t = scriptTokens('a voice-activated teleprompter')
    const m = createCursorMatcher(t)
    expect(commit(m, 1, 'a voice activated teleprompter').matchedCount).toBe(3)
  })

  it('matches possessives with or without the s', () => {
    const t = scriptTokens("the world's fastest")
    const a = createCursorMatcher(t)
    expect(commit(a, 1, 'the worlds fastest').matchedCount).toBe(3)
    const b = createCursorMatcher(t)
    expect(commit(b, 1, 'the world fastest').matchedCount).toBe(3)
  })
})

describe('sessions, completion, and reset', () => {
  const tokens = scriptTokens('one two three four five six')

  it('keeps the cursor across sidecar session rotation', () => {
    const m = createCursorMatcher(tokens)
    m.feed(1, F('one two three'))
    const pos = m.feed(2, F('four five'))
    expect(pos.matchedCount).toBe(5)
  })

  it('completes and reports done with token indexes at -1', () => {
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, F('one two three four five six'))
    expect(pos.done).toBe(true)
    expect(pos.cursorTokenIndex).toBe(-1)
    expect(pos.provisionalTokenIndex).toBe(-1)
  })

  it('reports the token index of the next expected word', () => {
    const m = createCursorMatcher(tokens)
    const pos = m.feed(1, F('one two'))
    expect(tokens[pos.cursorTokenIndex].text).toBe('three')
  })

  it('reset() returns both cursors to the top', () => {
    const m = createCursorMatcher(tokens)
    m.feed(1, F('one two three'))
    const pos = m.reset()
    expect(pos.matchedCount).toBe(0)
    expect(pos.provisionalCount).toBe(0)
    expect(tokens[pos.cursorTokenIndex].text).toBe('one')
  })
})
