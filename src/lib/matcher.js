// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// Forward-searching cursor matcher: aligns a live speech transcript against
// the tokenized script and reports the reader's current position.
//
// Design constraints (see docs/ARCHITECTURE.md §7a):
// - The cursor NEVER moves backward. Recognition partials may revise earlier
//   words; revisions of already-consumed words are ignored.
// - Skipped script words, filler words ("um"), and misreads are tolerated:
//   transcript words that don't match anything in the lookahead window are
//   simply dropped, and matching a word deeper in the window jumps the
//   cursor over the skipped script words.

// How many upcoming script words to search for each transcript word.
// Large enough to absorb a skipped phrase, small enough that a stray
// recognition of a common word ("the") can't teleport the cursor.
export const DEFAULT_LOOKAHEAD = 12

// Lowercase, fold full-width forms to half-width (NFKC), drop everything
// that isn't a letter or digit. "Ｒｅａｃｔ，" → "react".
export function normalizeWord(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

// Tokenize recognized transcript text the same way the script is tokenized:
// whitespace-split, then normalized. Returns only non-empty normalized words.
export function tokenizeTranscript(text) {
  const out = []
  for (const chunk of (text || '').split(/\s+/)) {
    if (!chunk) continue
    const norm = normalizeWord(chunk)
    if (norm) out.push(norm)
  }
  return out
}

// scriptTokens: output of tokenizeDoc(). Only type==='word' tokens take part
// in matching; markers/newlines are display-only.
//
// Returns { feed, reset, position }:
//   feed(session, transcriptText) → position object
//   position() → { matchedCount, total, cursorTokenIndex, done }
//     matchedCount     — number of script words consumed (cursor in word space)
//     cursorTokenIndex — index into scriptTokens of the NEXT expected word,
//                        or -1 when the whole script has been read
export function createCursorMatcher(scriptTokens, { lookahead = DEFAULT_LOOKAHEAD } = {}) {
  const matchable = []
  scriptTokens.forEach((tok, tokenIndex) => {
    if (tok.type !== 'word') return
    const norm = normalizeWord(tok.text)
    if (norm) matchable.push({ tokenIndex, norm })
  })

  let cursor = 0            // index into matchable of the next expected word
  let session = null        // sidecar recognition session currently being fed
  let prevWords = []        // transcript words already processed this session

  function position() {
    return {
      matchedCount: cursor,
      total: matchable.length,
      cursorTokenIndex: cursor < matchable.length ? matchable[cursor].tokenIndex : -1,
      done: cursor >= matchable.length,
    }
  }

  function feed(newSession, transcriptText) {
    if (newSession !== session) {
      // The sidecar rotates recognition sessions (on final results and
      // recoverable errors); each session's transcript starts empty.
      session = newSession
      prevWords = []
    }

    const words = tokenizeTranscript(transcriptText)

    // Partials rewrite the tail of the transcript. Only process words beyond
    // the longest common prefix with what we already consumed — revisions of
    // earlier words never move the cursor backward.
    let prefix = 0
    while (prefix < prevWords.length && prefix < words.length && prevWords[prefix] === words[prefix]) {
      prefix++
    }
    const newWords = words.slice(prefix)
    prevWords = words

    for (const w of newWords) {
      const end = Math.min(cursor + lookahead, matchable.length)
      for (let k = cursor; k < end; k++) {
        if (matchable[k].norm === w) {
          cursor = k + 1
          break
        }
      }
      // No match within the window: filler word or misread — ignore.
    }

    return position()
  }

  function reset() {
    cursor = 0
    session = null
    prevWords = []
    return position()
  }

  return { feed, reset, position }
}
