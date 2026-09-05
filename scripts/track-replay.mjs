// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
/**
 * track-replay.mjs — replays recorded tracking sessions (script text plus
 * the raw sidecar message stream, captured with ?trackrecord=1 or
 * synthesized by scripts/make-fixtures.sh) through the cursor matcher,
 * deterministically, and reports alignment metrics:
 *
 *   cross-sentence jumps   committed-path jumps whose landing position is in
 *                          a different sentence than the position jumped from
 *   max forward skip       largest number of script words skipped by a
 *                          single committed advance
 *   backtracks             committed-cursor corrections (new matcher only)
 *   final cursor error     |final committed position − expectedFinal|
 *                          (expectedFinal defaults to the whole script)
 *   max stall              longest span in which the recognizer kept
 *                          producing partials (≥3 messages) but the display
 *                          cursor did not advance — deliberate silences,
 *                          where no partials arrive, do not count
 *   per-sentence alignment fraction of each sentence's words confirmed by an
 *                          actual match (not skipped over)
 *
 * Usage:
 *   node scripts/track-replay.mjs <fixture.json[.gz]> [--legacy]
 *   node scripts/track-replay.mjs --all [--legacy]   # table over all
 *                                                    # committed fixtures
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import { tokenizeDoc } from '../src/lib/tokenizer.js'
import { createCursorMatcher, normalizeWord } from '../src/lib/matcher.js'

const FIXTURE_DIR = new URL('../tests/fixtures/tracking', import.meta.url).pathname

// Only parse argv / run the CLI when executed directly, not when the
// exported helpers (loadFixture, replayFixture, listFixtures) are imported by
// the CI test suite.
const RUN_CLI = process.argv[1] && process.argv[1].endsWith('track-replay.mjs')
const args = process.argv.slice(2)
const legacy = args.includes('--legacy')
const all = args.includes('--all')
const fixturePath = args.find(a => !a.startsWith('--'))

export function listFixtures() {
  return fixtureFiles()
}

export function loadFixture(path) {
  const raw = readFileSync(path)
  const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
  return JSON.parse(text)
}

function docFromText(text) {
  return {
    type: 'doc',
    content: String(text || '').split('\n').map(line => {
      const trimmed = line.trim()
      return trimmed
        ? { type: 'paragraph', content: [{ type: 'text', text: trimmed }] }
        : { type: 'paragraph' }
    }),
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

// ── Replay one fixture and compute metrics ─────────────────
export function replayFixture(fixture, { legacy = false } = {}) {
  const tokens = tokenizeDoc(docFromText(fixture.script))

  const tokenSentence = []
  {
    let s = 0
    for (const tok of tokens) {
      tokenSentence.push(s)
      if (tok.type === 'word' && /[.!?]["')\]]*$/.test(tok.text)) s++
    }
  }

  const matcher = legacy ? createLegacyMatcher(tokens) : createCursorMatcher(tokens)

  // Stall tracking: gaps between provisional-cursor advances that contain
  // ≥3 recognition messages (the recognizer was producing, the cursor wasn't
  // moving). Silence produces no partials, so it never counts as a stall.
  let lastAdvanceT = null
  let msgsSinceAdvance = 0
  let prevProvisional = 0
  let maxStallMs = 0
  let stallSession = null
  // Overshoot: the committed cursor is meant to advance monotonically through
  // a linear read. The only true sign of a WRONG teleport is the committed
  // cursor reaching a position it must later retreat from — max committed
  // ever seen minus where it finishes. (The benign forward sentence-to-
  // sentence progression of per-sentence sessions is not overshoot.)
  let maxCommitted = 0

  for (const msg of fixture.messages || []) {
    if (msg.type !== 'partial' && msg.type !== 'final') continue
    const pos = matcher.feed(msg.session, msg)
    maxCommitted = Math.max(maxCommitted, pos.matchedCount)
    const t = typeof msg.t === 'number' ? msg.t : null
    // Stalls are measured only WITHIN a recognition session. A session change
    // is a sentence boundary — the reader's natural pause there, and (in the
    // synthesized fixtures) the gap between per-sentence sidecar runs, are not
    // tracking stalls, so the accumulator resets.
    if (msg.session !== stallSession) {
      stallSession = msg.session
      lastAdvanceT = t
      msgsSinceAdvance = 0
    }
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

  const pos = matcher.position()
  const overshoot = Math.max(0, maxCommitted - pos.matchedCount)
  const { jumps, backtracks, confirmedEntries, entryTokenIndex } = matcher.stats()
  const entrySentence = entryTokenIndex.map(ti => tokenSentence[ti])
  const sentenceCount = entrySentence.length ? entrySentence[entrySentence.length - 1] + 1 : 0

  const crossSentenceJumps = jumps.filter(
    j => entrySentence[j.to] !== entrySentence[Math.min(j.from, entrySentence.length - 1)])
  const maxForwardSkip = jumps.reduce((m, j) => Math.max(m, j.to - j.from), 0)
  const expectedFinal = fixture.expectedFinal ?? pos.total
  const finalError = Math.abs(pos.matchedCount - expectedFinal)

  const perSentence = []
  for (let s = 0; s < sentenceCount; s++) {
    const idxs = entrySentence.map((v, i) => (v === s ? i : -1)).filter(i => i >= 0)
    const hit = idxs.filter(i => confirmedEntries.has(i)).length
    perSentence.push({ sentence: s + 1, confirmed: hit, total: idxs.length })
  }
  const confirmedTotal = perSentence.reduce((a, p) => a + p.confirmed, 0)

  return {
    total: pos.total,
    sentenceCount,
    crossSentenceJumps: crossSentenceJumps.length,
    maxForwardSkip,
    backtracks,
    finalCommitted: pos.matchedCount,
    expectedFinal,
    finalError,
    maxStallMs,
    overshoot,
    perSentence,
    alignPct: pos.total ? Math.round((confirmedTotal / pos.total) * 100) : 100,
  }
}

// ── CLI ────────────────────────────────────────────────────
function fixtureFiles() {
  return readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith('.json') || f.endsWith('.json.gz'))
    .sort()
    .map(f => join(FIXTURE_DIR, f))
}

if (RUN_CLI && !fixturePath && !all) {
  console.error('usage: node scripts/track-replay.mjs <fixture.json[.gz]> [--legacy]  |  --all [--legacy]')
  process.exit(1)
} else if (RUN_CLI && all) {
  const files = fixtureFiles()
  const rows = []
  for (const file of files) {
    const fixture = loadFixture(file)
    const m = replayFixture(fixture, { legacy })
    rows.push({ name: fixture.name || file.split('/').pop(), kind: fixture.kind || '?', ...m })
  }
  console.log(`matcher: ${legacy ? 'LEGACY (greedy pre-2.1)' : 'current (sequence-coherent)'} — ${rows.length} fixtures\n`)
  const header = ['fixture', 'kind', 'xjumps', 'maxskip', 'over', 'backtr', 'final', 'err', 'stall(s)', 'align%']
  const table = rows.map(r => [
    r.name, r.kind, r.crossSentenceJumps, r.maxForwardSkip, r.overshoot, r.backtracks,
    `${r.finalCommitted}/${r.expectedFinal}`, r.finalError,
    (r.maxStallMs / 1000).toFixed(1), r.alignPct,
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...table.map(row => String(row[i]).length)))
  const fmt = row => row.map((c, i) => String(c).padEnd(widths[i])).join('  ')
  console.log(fmt(header))
  console.log(widths.map(w => '-'.repeat(w)).join('  '))
  for (const row of table) console.log(fmt(row))
  const agg = {
    xjumps: rows.reduce((a, r) => a + r.crossSentenceJumps, 0),
    maxskip: Math.max(0, ...rows.map(r => r.maxForwardSkip)),
    err: rows.reduce((a, r) => a + r.finalError, 0),
    over: Math.max(0, ...rows.map(r => r.overshoot)),
    stall: Math.max(0, ...rows.map(r => r.maxStallMs)),
    align: Math.round(rows.reduce((a, r) => a + r.alignPct, 0) / Math.max(1, rows.length)),
  }
  console.log(`\naggregate: cross-sentence jumps ${agg.xjumps} · max skip ${agg.maxskip} · Σ final error ${agg.err} · worst stall ${(agg.stall / 1000).toFixed(1)}s · mean alignment ${agg.align}%`)
} else if (RUN_CLI && fixturePath) {
  const fixture = loadFixture(fixturePath)
  const m = replayFixture(fixture, { legacy })
  console.log(`fixture:  ${fixture.name || fixturePath}`)
  console.log(`matcher:  ${legacy ? 'legacy (greedy first-match, pre-2.1)' : 'current (sequence-coherent)'}`)
  console.log(`script:   ${m.total} words in ${m.sentenceCount} sentences\n`)
  console.log(`cross-sentence jumps:  ${m.crossSentenceJumps}`)
  console.log(`max forward skip:      ${m.maxForwardSkip} words`)
  console.log(`backtracks:            ${m.backtracks}`)
  console.log(`final cursor:          ${m.finalCommitted}/${m.expectedFinal} (error ${m.finalError})`)
  console.log(`max stall:             ${(m.maxStallMs / 1000).toFixed(1)}s`)
  console.log(`overshoot:             ${m.overshoot} words`)
  console.log(`per-sentence alignment:`)
  for (const p of m.perSentence) {
    const pct = p.total ? Math.round((p.confirmed / p.total) * 100) : 100
    console.log(`  sentence ${p.sentence}: ${p.confirmed}/${p.total} (${pct}%)`)
  }
  console.log(`overall alignment:     ${m.alignPct}%`)
}
