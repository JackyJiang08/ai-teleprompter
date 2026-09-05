// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
/**
 * make-fixtures.mjs — synthesizes the tracking regression fixtures from
 * macOS text-to-speech. For each (script, voice, rate[, alteration]):
 *
 *   1. `say -v <voice> -r <rate> -o utterance.aiff` renders the SPOKEN text
 *      (misread variants alter the spoken text; the fixture's script text
 *      stays the original), then `afconvert` normalizes it to the canonical
 *      feed format (WAVE, pcm_s16le, 22050 Hz).
 *   2. The speech sidecar runs in --audio-file mode with the matching
 *      --script and --contextual inputs — the exact recognition pipeline the
 *      app uses, at real-time pace.
 *   3. The complete NDJSON message stream plus the script text is saved as a
 *      gzipped fixture under tests/fixtures/tracking/, in the same shape
 *      ?trackrecord=1 produces, with generator metadata (voice, rate,
 *      alteration, audio format).
 *
 * Run via scripts/make-fixtures.sh. Generation needs macOS (`say`,
 * `afconvert`, on-device speech recognition) and real time per fixture, so
 * it is NOT part of CI — CI replays the committed fixtures instead
 * (tracking-suite.test.js).
 *
 * Usage: node scripts/make-fixtures.mjs [--only <name-substring>]
 */

import { execFileSync, spawn } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gzipSync } from 'zlib'
import readline from 'readline'
import { tokenizeDoc } from '../src/lib/tokenizer.js'
import { buildContextualStrings, createCursorMatcher } from '../src/lib/matcher.js'

const ROOT = new URL('..', import.meta.url).pathname
const SIDECAR = join(ROOT, 'src-tauri/binaries/speech-sidecar-aarch64-apple-darwin')
const SCRIPT_DIR = join(ROOT, 'tests/fixtures/tracking/scripts')
const OUT_DIR = join(ROOT, 'tests/fixtures/tracking')

const SCRIPTS = ['about-me', 'product-demo', 'jargon-brief']
// Three natural en-US system voices the on-device recognizer handles well
// (robotic novelty voices like Fred/Reed are not representative of speech).
const VOICES = ['Samantha', 'Alex', 'Tom']
const RATES = [160, 200]

// Misread variants: the SPOKEN text is deliberately altered; the fixture's
// script stays the original. Applied to product-demo (Samantha, 175 wpm).
const ALTERATIONS = {
  fillers: (t) => t
    .replace('Let me walk', 'Let me um walk')
    .replace("what we've built", "what we've uh built")
    .replace('is a voice-activated', 'is um a voice-activated')
    .replace('it pauses', 'uh it pauses')
    .replace('just open and go', 'just um open and go'),
  'repeated-phrase': (t) => t
    .replace('a voice-activated teleprompter', 'a voice-activated, a voice-activated teleprompter'),
  'skipped-word': (t) => t
    .replace('lives right in', 'lives in')
    .replace('no setup, just open', 'no setup, open'),
  restart: (t) => t
    .replace('Let me walk you through', 'Let me walk you — Let me walk you through'),
  silence: (t) => t
    .replace('teleprompter that lives', 'teleprompter [[slnc 2000]] that lives'),
}

const only = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? process.argv[i + 1] : null
})()

function docFromText(text) {
  return {
    type: 'doc',
    content: text.split('\n').map(line => {
      const trimmed = line.trim()
      return trimmed
        ? { type: 'paragraph', content: [{ type: 'text', text: trimmed }] }
        : { type: 'paragraph' }
    }),
  }
}

// A short spoken lead-in warms up the custom LM before the first sentence.
const LEAD_IN = 'All right, here we go.'

// Split a spoken utterance into breath-group segments. Each becomes its own
// sidecar run — one recognition session ending in a final — so the fixture
// reproduces the live recognizer's session rotation at reading pauses,
// instead of one giant continuous session (whose transcript the recognizer
// truncates on long scripts). Consecutive sentences are grouped until a
// segment reaches ~MIN_SEG_WORDS words: a lone three-word sentence recognizes
// poorly in isolation, so terse sentences ride together as a natural breath
// group. Silence markers a misread variant injected stay in place.
const MIN_SEG_WORDS = 10
function splitSentences(text) {
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'—[])/)
    .map(s => s.trim())
    .filter(Boolean)
  const segments = []
  let cur = ''
  const wc = s => s.split(/\s+/).filter(Boolean).length
  for (const sent of sentences) {
    cur = cur ? `${cur} ${sent}` : sent
    if (wc(cur) >= MIN_SEG_WORDS) { segments.push(cur); cur = '' }
  }
  if (cur) {
    if (segments.length) segments[segments.length - 1] += ` ${cur}`
    else segments.push(cur)
  }
  return segments
}

// Run the sidecar once over one synthesized audio segment; return its
// recognition messages (partial/final/lm/feed/error).
async function recognizeSegment(spokenSegment, { voice, rate, scriptFile, contextualFile, dir, i, leadIn }) {
  const aiff = join(dir, `seg-${i}.aiff`)
  const wav = join(dir, `seg-${i}.wav`)
  const prefix = leadIn ? `${LEAD_IN} [[slnc 400]] ` : ''
  execFileSync('say', ['-v', voice, '-r', String(rate), '-o', aiff, `${prefix}${spokenSegment}`])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', '-c', '1', aiff, wav])

  const messages = []
  const sidecar = spawn(SIDECAR, [
    '--locale', 'en-US',
    '--audio-file', wav,
    '--script', scriptFile,
    '--contextual', contextualFile,
  ], { stdio: ['ignore', 'pipe', 'inherit'] })
  const rl = readline.createInterface({ input: sidecar.stdout })
  rl.on('line', (line) => {
    try { messages.push({ recv: Date.now(), ...JSON.parse(line) }) } catch {}
  })
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const end = messages.find(m => m.type === 'feed' && m.state === 'end')
      const fatal = messages.find(m => m.type === 'error' && m.fatal)
      if (fatal) { clearInterval(iv); resolve() }
      if (end && Date.now() - end.recv > 1500) { clearInterval(iv); resolve() }
    }, 100)
  })
  sidecar.kill()
  return messages
}

async function makeFixture({ name, kind, scriptText, spokenText, voice, rate, alteration }) {
  const dir = mkdtempSync(join(tmpdir(), 'make-fixture-'))
  try {
    const scriptFile = join(dir, 'script.txt')
    writeFileSync(scriptFile, scriptText)
    const contextualFile = join(dir, 'contextual.txt')
    writeFileSync(contextualFile, buildContextualStrings(scriptText).join('\n'))

    const segments = splitSentences(spokenText)
    const messages = []
    let sessionOffset = 0
    for (let s = 0; s < segments.length; s++) {
      const segMsgs = await recognizeSegment(segments[s], {
        voice, rate, scriptFile, contextualFile, dir, i: s, leadIn: s === 0,
      })
      // Renumber sessions to increase globally across segments, and mark each
      // segment's last partial as the sentence's final (the recognizer
      // finalizes when the reader pauses at the sentence boundary).
      const pf = segMsgs.filter(m => m.type === 'partial' || m.type === 'final')
      const localSessions = [...new Set(pf.map(m => m.session))]
      const remap = new Map(localSessions.map((sid, k) => [sid, sessionOffset + k + 1]))
      const lastBySession = new Map()
      for (const m of segMsgs) {
        if (m.session != null && remap.has(m.session)) m.session = remap.get(m.session)
        if (m.type === 'partial' || m.type === 'final') lastBySession.set(m.session, m)
      }
      for (const m of lastBySession.values()) if (m.type === 'partial') m.type = 'final'
      sessionOffset += localSessions.length
      messages.push(...segMsgs.filter(m => m.type === 'partial' || m.type === 'final'))
    }

    const probe = createCursorMatcher(tokenizeDoc(docFromText(scriptText)))
    const fixture = {
      name,
      kind, // 'clean' | 'misread'
      script: scriptText,
      locale: 'en-US',
      recordedAt: new Date().toISOString(),
      generator: {
        tool: 'say',
        voice,
        rate,
        alteration: alteration || null,
        audioFormat: 'WAVE pcm_s16le 22050 Hz mono (afconvert LEI16@22050)',
        sidecar: 'speech-sidecar --audio-file (real on-device recognition), one run per sentence',
      },
      expectedFinal: probe.position().total,
      messages: messages.map(({ recv, ...m }) => m),
    }
    const outPath = join(OUT_DIR, `${name}.json.gz`)
    writeFileSync(outPath, gzipSync(JSON.stringify(fixture)))
    const partials = messages.filter(m => m.type === 'partial' || m.type === 'final').length
    console.log(`✅  ${name}.json.gz — ${partials} recognition messages, ${fixture.expectedFinal} script words`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const jobs = []
for (const script of SCRIPTS) {
  const scriptText = readFileSync(join(SCRIPT_DIR, `${script}.txt`), 'utf8').trim()
  for (const voice of VOICES) {
    for (const rate of RATES) {
      jobs.push({
        name: `${script}__${voice.split(' ')[0].toLowerCase()}__r${rate}`,
        kind: 'clean',
        scriptText,
        spokenText: scriptText,
        voice,
        rate,
      })
    }
  }
}
{
  const scriptText = readFileSync(join(SCRIPT_DIR, 'product-demo.txt'), 'utf8').trim()
  for (const [alteration, apply] of Object.entries(ALTERATIONS)) {
    jobs.push({
      name: `product-demo__misread-${alteration}`,
      kind: 'misread',
      scriptText,
      spokenText: apply(scriptText),
      voice: 'Samantha',
      rate: 175,
      alteration,
    })
  }
}

const selected = only ? jobs.filter(j => j.name.includes(only)) : jobs
console.log(`Generating ${selected.length} fixtures (sequential, real-time audio)…`)
for (const job of selected) {
  await makeFixture(job)
}
console.log('Done.')
