// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// Sequence-coherent cursor matcher: aligns the live speech transcript against
// the tokenized script and reports the reader's position.
//
// The previous algorithm (greedy first-match within a 12-word lookahead,
// committed immediately from partial hypotheses) let a single stray common
// word teleport the cursor into the wrong sentence permanently. This one is
// built around five rules (docs/ARCHITECTURE.md §3.3):
//
//   1. Normalization — numbers/percentages expand to spoken form, all-caps
//      acronyms to letter sequences, possessives and hyphens normalized;
//      each script word carries multiple accepted forms.
//   2. Stopword rule — a stopword can only confirm the next expected word
//      (advance by 1); it can never justify a jump.
//   3. Jump rule — advancing by more than one word requires a bigram anchor
//      (two consecutive transcript words matching two consecutive script
//      words at the target), nearest candidate first, at most 6 words ahead.
//   4. Stability gating — the tail of a partial is tentative: it drives a
//      provisional display cursor but commits only once stable. A word is
//      stable when it is one of: part of a final result; more than
//      TAIL_TENTATIVE words behind the growing end of the transcript (the
//      recognizer revises only the last word or two, not words already deep
//      in the utterance); or old by segment timestamp when those timestamps
//      are trustworthy (they are not in the sidecar's file-feed mode, so the
//      position rule is the workhorse). The stable prefix is tracked
//      monotonically per session, so a momentarily bad partial can't drop it.
//   5. Bounded backtrack — a stable bigram anchor up to 3 words behind the
//      committed cursor corrects a wrong jump.
//
// Fuzzy matching: words of 5+ letters accept edit distance ≤ 1; shorter
// words must match exactly.

// A single advance may skip at most this many script words (jump rule) on a
// two-word (bigram) anchor.
export const MAX_JUMP = 6
// Line completion: when a recognizer FINAL arrives (delivered at the pause
// after a line) and at most this many words of the current line remain
// uncommitted, commit them — the recognizer dropped the line's last word or
// two at the pause. Kept small so a final delivered at a MID-line pause
// (many words still to come) can never over-advance the committed cursor.
export const LINE_COMPLETE_SLACK = 4
// A three-word (trigram) anchor is strong enough to justify a much longer
// forward resync — this recovers when the recognizer drops a whole clause or
// sentence (a live hiccup, or a low-fidelity stretch of audio) and the reader
// is really that far ahead. The trigram makes a coincidental long jump
// vanishingly unlikely.
export const MAX_RESYNC = 40
// The committed cursor may move back at most this many words (backtrack rule).
export const MAX_BACKTRACK = 3
// The trailing words of a partial the recognizer may still revise — held
// tentative (provisional only), not committed.
export const TAIL_TENTATIVE = 2
// A word older than this (by segment timestamp, relative to the newest
// segment) is also treated as stable — but only when the segment timestamps
// span a realistic duration (file-feed mode reports a degenerate ~0 span).
export const STABLE_AGE_S = 0.6

// English stopwords: the highest-frequency function words, too common to
// carry alignment evidence on their own. A stopword can confirm the next
// expected word but never justify a jump, and stopwords are excluded from
// the recognizer's contextual vocabulary. Deliberately narrow — the jump
// rule already requires a two-word (bigram) anchor, so this is a second line
// of defence against teleporting, not the only one. Kept to articles,
// conjunctions, core prepositions, pronouns, and be/do/have auxiliaries;
// content-ish words a reader leans on ("just", "no", "up", "out", "here")
// stay matchable so an end-of-utterance phrase like "just open" can still
// anchor. (Tunable — see docs/ARCHITECTURE.md §3.3.)
export const STOPWORDS = new Set([
  'i', 'a', 'an', 'the', 'and', 'to', 'of', 'in', 'that', 'it', 'is', 'was',
  'for', 'with', 'on', 'at', 'as', 'my', 'this', 'be', 'are', 'or', 'but',
  'we', 'so', 'if', 'by', 'from', 'our', 'your', 'their', 'its', 'he', 'she',
  'they', 'you', 'me', 'us', 'him', 'her', 'them', 'do', 'does', 'have', 'has',
])

// Lowercase, fold full-width forms to half-width (NFKC), drop everything
// that isn't a letter or digit. "Ｒｅａｃｔ，" → "react".
export function normalizeWord(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

// ── Spoken-form expansion ──────────────────────────────────
// Deterministic on both sides: the same raw string always produces the same
// primary sequence, so a formatted transcript token ("23%") meets the
// script's expansion of the same token in expanded space.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty',
  'seventy', 'eighty', 'ninety']

function twoDigitWords(n) {
  if (n < 20) return [ONES[n]]
  const out = [TENS[Math.floor(n / 10)]]
  if (n % 10) out.push(ONES[n % 10])
  return out
}

// Standard reading, 0..9999 ("2027" → two thousand twenty seven).
function numberWords(n) {
  if (n < 100) return twoDigitWords(n)
  if (n < 1000) {
    const out = [ONES[Math.floor(n / 100)], 'hundred']
    if (n % 100) out.push(...twoDigitWords(n % 100))
    return out
  }
  const out = [ONES[Math.floor(n / 1000)], 'thousand']
  const r = n % 1000
  if (r) {
    if (r < 100) out.push(...twoDigitWords(r))
    else {
      out.push(ONES[Math.floor(r / 100)], 'hundred')
      if (r % 100) out.push(...twoDigitWords(r % 100))
    }
  }
  return out
}

// Pairwise year reading for 1000..2099 ("2027" → twenty twenty seven,
// "2005" → twenty oh five, "1900" → nineteen hundred).
function yearWords(n) {
  const hi = Math.floor(n / 100)
  const lo = n % 100
  const out = [...twoDigitWords(hi)]
  if (lo === 0) out.push('hundred')
  else if (lo < 10) out.push('oh', ONES[lo])
  else out.push(...twoDigitWords(lo))
  return out
}

function integerForms(n) {
  if (n > 9999) return { primary: [...String(n)].map(d => ONES[Number(d)]), alts: [] }
  if (n >= 1000 && n <= 2099) return { primary: yearWords(n), alts: [numberWords(n)] }
  return { primary: numberWords(n), alts: [] }
}

const stripPunct = raw =>
  raw.replace(/^[^\p{L}\p{N}]+/gu, '').replace(/[^\p{L}\p{N}%]+$/gu, '')

// Expand one raw token into { primary, alts }: primary is the canonical
// spoken sequence (shared by script and transcript), alts are extra forms
// the SCRIPT side additionally accepts.
export function expandWordForms(raw) {
  const core = stripPunct(String(raw || ''))
  if (!core) return { primary: [], alts: [] }

  let m
  if ((m = core.match(/^(\d+)%$/))) {
    const f = integerForms(Number(m[1]))
    return { primary: [...f.primary, 'percent'], alts: f.alts.map(a => [...a, 'percent']) }
  }
  if (/^\d+$/.test(core)) {
    const f = integerForms(Number(core))
    return { primary: f.primary, alts: [...f.alts, [core]] }
  }
  if ((m = core.match(/^(\d+)\.(\d+)$/))) {
    const f = integerForms(Number(m[1]))
    const digits = [...m[2]].map(d => ONES[Number(d)])
    return { primary: [...f.primary, 'point', ...digits], alts: [] }
  }
  if (/^[A-Z]{2,6}$/.test(core)) {
    // All-caps acronym: spelled out letter by letter; also accepted merged.
    return { primary: [...core.toLowerCase()], alts: [[core.toLowerCase()]] }
  }
  if (/[\p{L}\p{N}][-–—/][\p{L}\p{N}]/u.test(core)) {
    const parts = core.split(/[-–—/]+/u).map(normalizeWord).filter(Boolean)
    if (parts.length >= 2) return { primary: parts, alts: [[parts.join('')]] }
  }
  if ((m = core.match(/^(.+)[''’]s$/u))) {
    const base = normalizeWord(m[1])
    const full = normalizeWord(core)
    if (base && full) return { primary: [full], alts: base !== full ? [[base]] : [] }
  }
  const norm = normalizeWord(core)
  return { primary: norm ? [norm] : [], alts: [] }
}

// Transcript words expand to their primary spoken sequence only.
export function expandTranscriptWord(raw) {
  return expandWordForms(raw).primary
}

// Flatten transcript text into the normalized expanded word stream (kept for
// tests and tooling; live feeding passes per-word sidecar data to feed()).
export function tokenizeTranscript(text) {
  const out = []
  for (const chunk of String(text || '').split(/\s+/)) {
    if (!chunk) continue
    out.push(...expandTranscriptWord(chunk))
  }
  return out
}

// The script's non-stopword vocabulary for the recognizer's
// contextualStrings bias: original casing kept (helps proper nouns and
// acronyms), deduplicated case-insensitively, capped at the API guidance
// limit of 100 entries.
export function buildContextualStrings(scriptText, cap = 100) {
  const out = []
  const seen = new Set()
  for (const chunk of String(scriptText || '').split(/\s+/)) {
    const word = chunk.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (word.length < 3) continue
    const norm = normalizeWord(word)
    if (!norm || STOPWORDS.has(norm)) continue
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(word)
    if (out.length >= cap) break
  }
  return out
}

// Edit distance ≤ 1 (substitution, insertion, or deletion), tried only when
// the script word has 5+ letters; shorter words require exact equality.
function fuzzyEquals(scriptWord, spoken) {
  if (scriptWord === spoken) return true
  if (scriptWord.length < 5) return false
  const la = scriptWord.length
  const lb = spoken.length
  if (Math.abs(la - lb) > 1) return false
  let i = 0
  while (i < la && i < lb && scriptWord[i] === spoken[i]) i++
  if (la === lb) return scriptWord.slice(i + 1) === spoken.slice(i + 1)
  const [long, short] = la > lb ? [scriptWord, spoken] : [spoken, scriptWord]
  return long.slice(0, i) + long.slice(i + 1) === short
}

// ── Matcher ────────────────────────────────────────────────
// scriptTokens: output of tokenizeDoc(). Only type==='word' tokens take part
// in matching; markers/newlines are display-only.
//
// Returns { feed, reset, position, stats }:
//   feed(session, msg) → position object. msg is a sidecar partial/final
//     ({ text, words?, type? }) or a plain string (treated as a partial).
//   position() → {
//     matchedCount        — committed cursor (script words consumed for sure)
//     provisionalCount    — display cursor (includes the tentative tail)
//     total               — total matchable script words
//     cursorTokenIndex    — token index of the next expected word (committed),
//                           -1 once the whole script has been read
//     provisionalTokenIndex — token index of the display cursor, -1 at end
//     done                — committed cursor reached the end
//   }
//   stats() → { jumps: [{from, to}], backtracks } — committed-path events,
//     for the replay tooling and tests (dev-only, not a stable API).
export function createCursorMatcher(scriptTokens) {
  const entries = []
  // lineEndEntry[i] = index of the last matchable word on entry i's line
  // (before the next newline token). Used by the line-completion rule below.
  const lineEndEntry = []
  let lineStart = 0
  scriptTokens.forEach((tok, tokenIndex) => {
    if (tok.type === 'newline') {
      const lineEnd = entries.length - 1
      for (let k = lineStart; k < entries.length; k++) lineEndEntry[k] = lineEnd
      lineStart = entries.length
      return
    }
    if (tok.type !== 'word') return
    const { primary, alts } = expandWordForms(tok.text)
    if (!primary.length) return
    const forms = [primary, ...alts]
    const rawNorm = normalizeWord(tok.text)
    if (rawNorm && !forms.some(f => f.length === 1 && f[0] === rawNorm)) forms.push([rawNorm])
    // Longest forms first so multi-word expansions consume their whole span.
    forms.sort((a, b) => b.length - a.length)
    entries.push({
      tokenIndex,
      forms,
      isStop: primary.length === 1 && STOPWORDS.has(primary[0]),
    })
  })
  const total = entries.length
  // Any trailing entries with no closing newline form a final line.
  for (let k = lineStart; k < total; k++) lineEndEntry[k] = total - 1

  let committed = 0        // entries consumed for sure
  let provisional = 0      // display cursor (committed + tentative tail)
  let committedBase = 0    // committed cursor when the current session began
  let session = null       // sidecar recognition session currently being fed
  let sessionStable = []   // monotonic stable-word prefix locked this session
  let confirmedInSession = new Set()
  const confirmedArchive = new Set()
  const jumpLog = []       // deduped committed-path jumps, for stats()
  const seenJumpTargets = new Set()
  let backtracks = 0

  // Does entry `idx` match the stream at position i? Returns the number of
  // stream words consumed (longest matching form), or 0.
  function matchEntryAt(idx, stream, i) {
    const entry = entries[idx]
    if (!entry) return 0
    outer: for (const form of entry.forms) {
      if (i + form.length > stream.length) continue
      for (let k = 0; k < form.length; k++) {
        if (!fuzzyEquals(form[k], stream[i + k].w)) continue outer
      }
      return form.length
    }
    return 0
  }

  // Sequential alignment of a stream slice. Advance-by-one is always tried
  // first; anything more needs a non-stopword trigger plus a bigram anchor,
  // searched nearest-first, at most MAX_JUMP ahead and MAX_BACKTRACK behind
  // (never below minCursor). Unmatched words are dropped (fillers, misreads).
  function align(stream, startCursor, minCursor, events) {
    let cursor = startCursor
    let i = 0
    while (i < stream.length && cursor <= total) {
      const consumed = cursor < total ? matchEntryAt(cursor, stream, i) : 0
      if (consumed) {
        events?.push({ type: 'confirm', entry: cursor })
        cursor++
        i += consumed
        continue
      }
      const sw = stream[i]
      if (!sw.isStop && cursor < total) {
        // Candidate targets, nearest first, forward preferred on ties.
        const targets = []
        for (let d = 1; d <= MAX_JUMP; d++) {
          if (cursor + d < total) targets.push(cursor + d)
          if (d <= MAX_BACKTRACK && cursor - d >= minCursor) targets.push(cursor - d)
        }
        let jumped = false
        for (const t of targets) {
          const m1 = matchEntryAt(t, stream, i)
          if (!m1) continue
          let m2 = 0
          if (t + 1 < total) {
            m2 = matchEntryAt(t + 1, stream, i + m1)
            if (!m2) continue // no bigram anchor — not enough evidence
          }
          // t is the last entry: accept the single non-stopword match.
          events?.push({ type: t > cursor ? 'jump' : 'backtrack', from: cursor, to: t })
          events?.push({ type: 'confirm', entry: t })
          if (m2) events?.push({ type: 'confirm', entry: t + 1 })
          cursor = t + (m2 ? 2 : 1)
          i += m1 + m2
          jumped = true
          break
        }
        if (jumped) continue

        // Long resync on a trigram anchor: the recognizer skipped a large
        // span (whole clause/sentence). Require three consecutive matches so
        // the long jump can't be coincidental; nearest match wins.
        for (let t = cursor + MAX_JUMP + 1; t + 2 < total && t <= cursor + MAX_RESYNC; t++) {
          const a = matchEntryAt(t, stream, i)
          if (!a) continue
          const b = matchEntryAt(t + 1, stream, i + a)
          if (!b) continue
          const c = matchEntryAt(t + 2, stream, i + a + b)
          if (!c) continue
          events?.push({ type: 'jump', from: cursor, to: t })
          events?.push({ type: 'confirm', entry: t })
          events?.push({ type: 'confirm', entry: t + 1 })
          events?.push({ type: 'confirm', entry: t + 2 })
          cursor = t + 3
          i += a + b + c
          jumped = true
          break
        }
        if (jumped) continue
      }
      i++ // filler or misread — dropped
    }
    return cursor
  }

  function position() {
    return {
      matchedCount: committed,
      provisionalCount: provisional,
      total,
      cursorTokenIndex: committed < total ? entries[committed].tokenIndex : -1,
      provisionalTokenIndex: provisional < total ? entries[provisional].tokenIndex : -1,
      done: committed >= total,
    }
  }

  function toStream(words) {
    const stream = []
    for (const w of words) {
      for (const ew of expandTranscriptWord(w)) {
        stream.push({ w: ew, isStop: STOPWORDS.has(ew) })
      }
    }
    return stream
  }

  function commonPrefixLen(a, b) {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i
  }

  function feed(newSession, input) {
    if (newSession !== session) {
      session = newSession
      committedBase = committed
      sessionStable = []
      for (const e of confirmedInSession) confirmedArchive.add(e)
      confirmedInSession = new Set()
    }

    const msg = typeof input === 'string' ? { text: input } : (input || {})
    const isFinal = msg.type === 'final' || msg.final === true
    const rawWords = Array.isArray(msg.words) && msg.words.length
      ? msg.words.map(w => ({ text: String(w.w ?? w.text ?? ''), t: w.t, d: w.d }))
      : String(msg.text || '').split(/\s+/).filter(Boolean).map(text => ({ text }))
    const rawText = rawWords.map(w => w.text)

    // How much of THIS partial is stable. Position rule: the recognizer only
    // revises the last TAIL_TENTATIVE words, so everything before them is
    // stable (a final makes the whole transcript stable). Age rule: when the
    // segment timestamps span a realistic duration (they don't in file-feed
    // mode), words older than STABLE_AGE_S can also be treated as stable.
    let stableLenNow = isFinal ? rawWords.length : Math.max(0, rawWords.length - TAIL_TENTATIVE)
    if (!isFinal && rawWords.length > 4) {
      const ts = rawWords.map(w => (typeof w.t === 'number' ? w.t : null)).filter(t => t !== null)
      if (ts.length === rawWords.length) {
        const span = Math.max(...ts) - Math.min(...ts)
        if (span > 1.0) {
          const latestEnd = Math.max(...rawWords.map(w => w.t + (w.d || 0)))
          let ageStable = 0
          while (ageStable < rawWords.length &&
                 rawWords[ageStable].t + (rawWords[ageStable].d || 0) <= latestEnd - STABLE_AGE_S) ageStable++
          stableLenNow = Math.max(stableLenNow, ageStable)
        }
      }
    }
    const candidateStable = rawText.slice(0, stableLenNow)

    // Merge into the session's monotonic stable prefix. A final is
    // authoritative — it replaces the stable prefix outright. For partials:
    // pure extensions grow it; a small revision within MAX_BACKTRACK of its
    // tail is accepted (the bounded backtrack); a deep divergence is treated
    // as a bad partial and ignored so the committed cursor can't be yanked
    // away by one noisy hypothesis.
    if (isFinal) {
      sessionStable = candidateStable
    } else {
      const lcp = commonPrefixLen(sessionStable, candidateStable)
      if (lcp === sessionStable.length) {
        if (candidateStable.length > sessionStable.length) sessionStable = candidateStable
      } else if (sessionStable.length - lcp <= MAX_BACKTRACK && candidateStable.length >= lcp) {
        sessionStable = candidateStable
      }
    }

    // Committed cursor: align the whole stable prefix from the session base.
    // Re-deriving each partial lets later stable evidence revise an earlier
    // wrong jump (via align's bounded backtrack).
    const events = []
    const prevCommitted = committed
    committed = align(toStream(sessionStable), committedBase, Math.max(0, committedBase - MAX_BACKTRACK), events)
    // Backtrack is bounded: the committed cursor never drops more than
    // MAX_BACKTRACK below its prior value. This holds even for a final — on a
    // very long single session the recognizer truncates the head of its
    // transcript, so a "final" can arrive as only the tail; that must not
    // erase committed progress (it is truncation, not a revision).
    committed = Math.max(committed, prevCommitted - MAX_BACKTRACK)

    confirmedInSession = new Set(events.filter(e => e.type === 'confirm').map(e => e.entry))
    for (const e of events) {
      if (e.type === 'jump' && e.to >= prevCommitted && !seenJumpTargets.has(e.to)) {
        seenJumpTargets.add(e.to)
        jumpLog.push({ from: e.from, to: e.to })
      }
    }
    if (committed < prevCommitted) backtracks++

    // Line completion: a final is delivered at the pause after a line, so if
    // only the line's last few words remain uncommitted, the recognizer
    // dropped them at the pause — commit them, so the next session doesn't
    // have to jump to catch up (which would otherwise register as a benign
    // cross-sentence jump). Two guards keep this from ever over-advancing:
    //   • LINE_COMPLETE_SLACK — a final at a MID-line pause, with many words
    //     of the line still to come, is far from the line end and untouched.
    //   • only a NON-final line is completed — the last line has no following
    //     session to catch up, so there is nothing to pre-empt, and this
    //     leaves a final that lands within a short single-line script (the
    //     common shape in isolation) exactly where the recognizer put it.
    if (isFinal && committed < total) {
      const lineEnd = lineEndEntry[committed]
      if (lineEnd >= committed && lineEnd + 1 < total &&
          lineEnd - committed <= LINE_COMPLETE_SLACK) {
        for (let e = committed; e <= lineEnd; e++) confirmedInSession.add(e)
        committed = lineEnd + 1
      }
    }

    // Provisional display cursor: align the full current transcript from the
    // session base; never behind the committed cursor.
    provisional = Math.max(committed, align(toStream(rawText), committedBase, Math.max(0, committedBase - MAX_BACKTRACK)))

    return position()
  }

  function reset() {
    committed = 0
    provisional = 0
    committedBase = 0
    session = null
    sessionStable = []
    confirmedInSession = new Set()
    confirmedArchive.clear()
    jumpLog.length = 0
    seenJumpTargets.clear()
    backtracks = 0
    return position()
  }

  function stats() {
    const confirmed = new Set(confirmedArchive)
    for (const e of confirmedInSession) confirmed.add(e)
    return {
      jumps: [...jumpLog],
      backtracks,
      confirmedEntries: confirmed,
      entryTokenIndex: entries.map(e => e.tokenIndex),
    }
  }

  return { feed, reset, position, stats }
}
