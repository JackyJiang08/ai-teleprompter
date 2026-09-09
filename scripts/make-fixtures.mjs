// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
/**
 * make-fixtures.mjs — synthesizes the tracking regression fixtures from
 * macOS text-to-speech. For each (script, voice, rate[, alteration]):
 *
 *   1. `say -v <voice> -r <rate> -o utterance.aiff` renders the SPOKEN text
 *      as ONE continuous utterance — a warm-up lead-in, then the script with
 *      a short pause between sentences and a trailing pause — then `afconvert`
 *      normalizes it to the canonical feed format (WAVE, pcm_s16le, 22050 Hz).
 *      Misread variants alter the spoken text; the fixture's script stays the
 *      original.
 *   2. The speech sidecar runs ONCE in --audio-file mode over that continuous
 *      audio with the matching --script/--contextual inputs. The sidecar's
 *      own silence endpointing rotates recognition sessions at the pauses —
 *      exactly as it does for a live reader — so session boundaries emerge
 *      from the recognizer, not from pre-splitting, and each session's final
 *      carries real per-word segment timestamps.
 *   3. The complete NDJSON message stream plus the script text is saved as a
 *      gzipped fixture under tests/fixtures/tracking/, in the same shape
 *      ?trackrecord=1 produces, with generator metadata.
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
  // New in v2.1.0: a long pause in the middle of a sentence. With the
  // sidecar's silence endpointing this forces a session rotation MID-sentence
  // — a session boundary that does not coincide with a sentence boundary,
  // which is the case the restored cross-sentence-jump target must survive.
  'midpause': (t) => t
    .replace('right in your', 'right [[slnc 1600]] in your'),
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

// ── Seeded pink-noise mixer (for the "noisy" fixture family) ──
// Deterministic so regenerated fixtures are reproducible. Mixes low-level
// pink noise into the 16-bit PCM so the sidecar's ADAPTIVE silence threshold
// is exercised against a raised, non-silent noise floor — a fixed threshold
// would never endpoint (noise sits above it) and sessions would never rotate.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Add pink noise at the given RMS level (dBFS) to a mono 16-bit WAV in place.
function addPinkNoiseToWav(wavPath, dbfs, seed) {
  const buf = readFileSync(wavPath)
  // Locate the 'data' chunk (WAV headers are not always a flat 44 bytes).
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') { off += 8; break }
    off += 8 + size + (size & 1)
  }
  const dataStart = off
  const n = (buf.length - dataStart) >> 1
  const rnd = mulberry32(seed)
  // Paul Kellet's economy pink-noise filter over white noise.
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  const pink = new Float64Array(n)
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const white = rnd() * 2 - 1
    b0 = 0.99886 * b0 + white * 0.0555179
    b1 = 0.99332 * b1 + white * 0.0750759
    b2 = 0.96900 * b2 + white * 0.1538520
    b3 = 0.86650 * b3 + white * 0.3104856
    b4 = 0.55000 * b4 + white * 0.5329522
    b5 = -0.7616 * b5 - white * 0.0168980
    const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362
    b6 = white * 0.115926
    pink[i] = p
    sumSq += p * p
  }
  const rms = Math.sqrt(sumSq / Math.max(1, n)) || 1
  const targetRms = Math.pow(10, dbfs / 20) * 32767
  const gain = targetRms / rms
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(dataStart + i * 2) + pink[i] * gain
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), dataStart + i * 2)
  }
  writeFileSync(wavPath, buf)
}

// Turn the script's spoken text into one continuous utterance: insert a pause
// after each sentence and a trailing pause so the sidecar's silence
// endpointing rotates a session per sentence (the last one included), and
// prepend the warm-up lead-in. Silence markers a misread variant injected
// (e.g. a mid-sentence [[slnc]]) are preserved and produce their own session
// rotations.
function toContinuousSpoken(spokenText, pauseMs = 650) {
  const paced = spokenText.replace(/([.!?])(\s+)(?=[A-Z0-9"'—[])/g, `$1 [[slnc ${pauseMs}]] $2`)
  return `${LEAD_IN} [[slnc 400]] ${paced} [[slnc 800]]`
}

async function makeFixture({ name, kind, scriptText, spokenText, voice, rate, alteration, pauseMs = 650, noiseDbfs = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'make-fixture-'))
  try {
    const scriptFile = join(dir, 'script.txt')
    writeFileSync(scriptFile, scriptText)
    const contextualFile = join(dir, 'contextual.txt')
    writeFileSync(contextualFile, buildContextualStrings(scriptText).join('\n'))

    const aiff = join(dir, 'utterance.aiff')
    const wav = join(dir, 'utterance.wav')
    execFileSync('say', ['-v', voice, '-r', String(rate), '-o', aiff, toContinuousSpoken(spokenText, pauseMs)])
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', '-c', '1', aiff, wav])
    // "noisy" family: raise the noise floor so the adaptive threshold matters.
    if (noiseDbfs != null) {
      // Seed from the fixture name so each fixture's noise is fixed but distinct.
      const seed = [...name].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7)
      addPinkNoiseToWav(wav, noiseDbfs, seed)
    }

    // ONE sidecar run over the whole utterance; the sidecar rotates sessions
    // itself at the pauses (silence endpointing), exactly as it does live.
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
        // The trailing pause lets the last session finalize; wait a beat past
        // feed-end for that final to arrive.
        if (end && Date.now() - end.recv > 2500) { clearInterval(iv); resolve() }
      }, 100)
    })
    sidecar.kill()

    const pf = messages.filter(m => m.type === 'partial' || m.type === 'final')
    const probe = createCursorMatcher(tokenizeDoc(docFromText(scriptText)))
    const sessions = [...new Set(pf.map(m => m.session))].length
    const finals = pf.filter(m => m.type === 'final').length
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
        pauseMs,
        noiseDbfs,
        audioFormat: 'WAVE pcm_s16le 22050 Hz mono (afconvert LEI16@22050)',
        sidecar: 'speech-sidecar --audio-file, single continuous feed, silence-endpointed session rotation',
      },
      expectedFinal: probe.position().total,
      messages: pf.map(({ recv, ...m }) => m),
    }
    const outPath = join(OUT_DIR, `${name}.json.gz`)
    writeFileSync(outPath, gzipSync(JSON.stringify(fixture)))
    console.log(`✅  ${name}.json.gz — ${pf.length} messages, ${sessions} sessions, ${finals} finals, ${fixture.expectedFinal} script words`)
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

// New in v2.1.1 — two alteration FAMILIES applied to ALL THREE scripts, each
// targeting one live-chain fix directly:
//
//   quick-resume  Correct speech, but each sentence resumes only ~630 ms after
//                 the previous ends — just past the 600 ms endpoint. The next
//                 sentence's opening words land right at the session rotation,
//                 so this measures the zero-gap replay (first-word recall).
//   noisy         Correct speech mixed with low-level pink noise (~−30 dBFS),
//                 raising the noise floor above any fixed silence threshold.
//                 Sessions must still rotate — that only works with the
//                 adaptive floor — and the targets must still hold.
for (const script of SCRIPTS) {
  const scriptText = readFileSync(join(SCRIPT_DIR, `${script}.txt`), 'utf8').trim()
  jobs.push({
    name: `${script}__quick-resume`,
    kind: 'clean',
    scriptText,
    spokenText: scriptText,
    voice: 'Samantha',
    rate: 175,
    alteration: 'quick-resume',
    pauseMs: 630,
  })
  jobs.push({
    name: `${script}__noisy`,
    kind: 'clean',
    scriptText,
    spokenText: scriptText,
    voice: 'Samantha',
    rate: 175,
    alteration: 'noisy',
    noiseDbfs: -30,
  })
}

const selected = only ? jobs.filter(j => j.name.includes(only)) : jobs
console.log(`Generating ${selected.length} fixtures (sequential, real-time audio)…`)
for (const job of selected) {
  await makeFixture(job)
}
console.log('Done.')
