// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
/**
 * track-replay.mjs — replays a recorded tracking session (script text plus
 * the raw sidecar message stream, captured with ?trackrecord=1 or written by
 * hand) through the cursor matcher, deterministically, and reports alignment
 * metrics:
 *
 *   cross-sentence jumps   committed-path jumps whose landing position is in
 *                          a different sentence than the position jumped from
 *   max forward skip       largest number of script words skipped by a
 *                          single committed advance
 *   backtracks             committed-cursor corrections (new matcher only)
 *   final cursor error     |final committed position − expectedFinal|
 *                          (expectedFinal defaults to the whole script)
 *   per-sentence alignment fraction of each sentence's words confirmed by an
 *                          actual match (not skipped over)
 *
 * Usage:
 *   node scripts/track-replay.mjs tests/fixtures/tracking/<fixture>.json
 *   node scripts/track-replay.mjs <fixture> --legacy   # pre-2.1 greedy
 *                                                      # matcher, for
 *                                                      # before/after numbers
 */

import { readFileSync } from 'fs'
import { tokenizeDoc } from '../src/lib/tokenizer.js'
import { createCursorMatcher, normalizeWord } from '../src/lib/matcher.js'

const args = process.argv.slice(2)
const legacy = args.includes('--legacy')
const fixturePath = args.find(a => !a.startsWith('--'))
if (!fixturePath) {
  console.error('usage: node scripts/track-replay.mjs <fixture.json> [--legacy]')
  process.exit(1)
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const doc = {
  type: 'doc',
  content: String(fixture.script || '').split('\n').map(line => {
    const trimmed = line.trim()
    return trimmed
      ? { type: 'paragraph', content: [{ type: 'text', text: trimmed }] }
      : { type: 'paragraph' }
  }),
}
const tokens = tokenizeDoc(doc)

// Sentence id per token index: a sentence ends at a word token whose text
// ends with terminal punctuation.
const tokenSentence = []
{
  let s = 0
  for (const tok of tokens) {
    tokenSentence.push(s)
    if (tok.type === 'word' && /[.!?]["')\]]*$/.test(tok.text)) s++
  }
}

// ── The pre-2.1 matcher, verbatim algorithm, instrumented ──
// Greedy first-match within a 12-word lookahead, committed immediately from
// every partial, no stopword rule, no anchors, no backtracking. Kept here
// only so before/after metrics can be produced against the same fixtures.
function createLegacyMatcher(scriptTokens, lookahead = 12) {
  const matchable = []
  scriptTokens.forEach((tok, tokenIndex) => {
    if (tok.type !== 'word') return
    const norm = normalizeWord(tok.text)
    if (norm) matchable.push({ tokenIndex, norm })
  })
  let cursor = 0
  let session = null
  let prevWords = []
  const jumps = []
  const confirmed = new Set()

  function position() {
    return {
      matchedCount: cursor,
      provisionalCount: cursor,
      total: matchable.length,
      cursorTokenIndex: cursor < matchable.length ? matchable[cursor].tokenIndex : -1,
      provisionalTokenIndex: cursor < matchable.length ? matchable[cursor].tokenIndex : -1,
      done: cursor >= matchable.length,
    }
  }
  function feed(newSession, input) {
    if (newSession !== session) { session = newSession; prevWords = [] }
    const text = typeof input === 'string' ? input : input?.text || ''
    const words = []
    for (const chunk of text.split(/\s+/)) {
      const norm = normalizeWord(chunk)
      if (norm) words.push(norm)
    }
    let prefix = 0
    while (prefix < prevWords.length && prefix < words.length && prevWords[prefix] === words[prefix]) prefix++
    const newWords = words.slice(prefix)
    prevWords = words
    for (const w of newWords) {
      const end = Math.min(cursor + lookahead, matchable.length)
      for (let k = cursor; k < end; k++) {
        if (matchable[k].norm === w) {
          if (k > cursor) jumps.push({ from: cursor, to: k })
          confirmed.add(k)
          cursor = k + 1
          break
        }
      }
    }
    return position()
  }
  function stats() {
    return {
      jumps,
      backtracks: 0,
      confirmedEntries: confirmed,
      entryTokenIndex: matchable.map(m => m.tokenIndex),
    }
  }
  return { feed, reset: () => {}, position, stats }
}

// ── Replay ─────────────────────────────────────────────────
const matcher = legacy ? createLegacyMatcher(tokens) : createCursorMatcher(tokens)
for (const msg of fixture.messages || []) {
  if (msg.type === 'partial' || msg.type === 'final') matcher.feed(msg.session, msg)
}

const pos = matcher.position()
const { jumps, backtracks, confirmedEntries, entryTokenIndex } = matcher.stats()
const entrySentence = entryTokenIndex.map(ti => tokenSentence[ti])
const sentenceCount = entrySentence.length ? entrySentence[entrySentence.length - 1] + 1 : 0

const crossSentenceJumps = jumps.filter(j => entrySentence[j.to] !== entrySentence[Math.min(j.from, entrySentence.length - 1)])
const maxForwardSkip = jumps.reduce((m, j) => Math.max(m, j.to - j.from), 0)
const expectedFinal = fixture.expectedFinal ?? pos.total
const finalError = Math.abs(pos.matchedCount - expectedFinal)

const perSentence = []
for (let s = 0; s < sentenceCount; s++) {
  const idxs = entrySentence.map((v, i) => (v === s ? i : -1)).filter(i => i >= 0)
  const hit = idxs.filter(i => confirmedEntries.has(i)).length
  perSentence.push({ sentence: s + 1, confirmed: hit, total: idxs.length })
}
const overall = perSentence.reduce((a, p) => a + p.confirmed, 0)

console.log(`fixture:  ${fixture.name || fixturePath}`)
console.log(`matcher:  ${legacy ? 'legacy (greedy first-match, pre-2.1)' : 'current (sequence-coherent)'}`)
console.log(`script:   ${pos.total} words in ${sentenceCount} sentences\n`)
console.log(`cross-sentence jumps:  ${crossSentenceJumps.length}`)
console.log(`max forward skip:      ${maxForwardSkip} words`)
console.log(`backtracks:            ${backtracks}`)
console.log(`final cursor:          ${pos.matchedCount}/${expectedFinal} (error ${finalError})`)
console.log(`per-sentence alignment:`)
for (const p of perSentence) {
  const pct = p.total ? Math.round((p.confirmed / p.total) * 100) : 100
  console.log(`  sentence ${p.sentence}: ${p.confirmed}/${p.total} (${pct}%)`)
}
console.log(`overall alignment:     ${overall}/${pos.total} (${Math.round((overall / Math.max(1, pos.total)) * 100)}%)`)
