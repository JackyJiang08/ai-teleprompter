// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
/**
 * track-latency.mjs — measures speech-recognition partial cadence and
 * spoken-word→partial latency deterministically: renders a known sentence
 * with macOS TTS (`say -o`), then has the sidecar consume that audio at
 * real-time pace (--audio-file mode) exactly as if it were live mic input.
 * No speakers or microphone involved, so runs are reproducible.
 *
 * Word spoken times are estimated by linear interpolation across the
 * utterance (exact start/end from the sidecar's "feed" events). Latency per
 * word = first partial containing it − its estimated spoken time. Constant
 * ~few-ms bias from interpolation cancels out in before/after comparisons.
 * Words are read from the per-word "words" segments the sidecar now emits
 * (substring/timestamp/duration/confidence), falling back to splitting the
 * flat "text" for older recordings.
 *
 * Usage: node scripts/track-latency.mjs [runs]
 *   TL_SENTENCE="..."  override the spoken sentence
 *   TL_BIAS=1          also pass the sentence as --script so the sidecar
 *                      builds a customized language model from it (A/B
 *                      accuracy comparisons: run once without, once with)
 */

import { spawn, execFileSync } from 'child_process'
import readline from 'readline'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SIDECAR = new URL('../src-tauri/binaries/speech-sidecar-aarch64-apple-darwin', import.meta.url).pathname
const SENTENCE = process.env.TL_SENTENCE ||
  'the quick brown fox jumps over the lazy dog while the calm river flows near the old stone bridge'
const BIAS = process.env.TL_BIAS === '1'
const RATE = 170 // words per minute for `say`
const RUNS = Number(process.argv[2] || 3)

const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '')
const LEAD_IN = 'all right, here we go.'
const LEAD_WORDS = LEAD_IN.split(' ').map(norm)
const WORDS = SENTENCE.split(' ').map(norm)
// All words in the audio, in order — interpolation runs over this list
const SPOKEN = [...LEAD_WORDS, ...WORDS]

// Render the utterance once
const dir = mkdtempSync(join(tmpdir(), 'track-latency-'))
const audio = join(dir, 'utterance.aiff')
// Lead-in gives the custom LM (when TL_BIAS=1) time to activate before the
// sentence under test arrives
execFileSync('say', ['-r', String(RATE), '-o', audio, `${LEAD_IN} ${SENTENCE}`])
const scriptFile = join(dir, 'script.txt')
writeFileSync(scriptFile, SENTENCE)

const allGaps = []
const allWordLat = []
const allTail = []

for (let run = 1; run <= RUNS; run++) {
  const msgs = []
  const sidecar = spawn(
    SIDECAR,
    ['--locale', 'en-US', '--audio-file', audio, ...(BIAS ? ['--script', scriptFile] : [])],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const rl = readline.createInterface({ input: sidecar.stdout })
  rl.on('line', (line) => {
    try { msgs.push({ recv: Date.now(), ...JSON.parse(line) }) } catch {}
  })

  // wait until the feed ends + recognition settles
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const end = msgs.find(m => m.type === 'feed' && m.state === 'end')
      const fatal = msgs.find(m => m.type === 'error' && m.fatal)
      if (fatal) { clearInterval(iv); resolve() }
      if (end && Date.now() - end.recv > 2500) { clearInterval(iv); resolve() }
    }, 50)
  })
  sidecar.kill()

  const feedStart = msgs.find(m => m.type === 'feed' && m.state === 'start')
  const feedEnd = msgs.find(m => m.type === 'feed' && m.state === 'end')
  const partials = msgs.filter(m => m.type === 'partial' || m.type === 'final')
  if (!feedStart || !feedEnd || partials.length < 2) {
    console.log(`run ${run}: ${partials.length} partials — skipped`, msgs.find(m => m.type === 'error') || '')
    continue
  }

  const gaps = partials.slice(1).map((m, i) => m.recv - partials[i].recv).filter(g => g < 2000)
  allGaps.push(...gaps)

  // estimated per-word latency: interpolate word end times across the feed
  // (over all spoken words including the lead-in), scored only for the
  // sentence under test
  const durPerWord = (feedEnd.recv - feedStart.recv) / SPOKEN.length
  const seen = new Map()
  for (const m of partials) {
    const words = Array.isArray(m.words) && m.words.length
      ? m.words.map(x => norm(String(x.w || '')))
      : String(m.text || '').split(/\s+/).map(norm)
    let idx = 0
    for (const w of words) {
      const at = SPOKEN.indexOf(w, idx)
      if (at >= 0 && !seen.has(at)) { seen.set(at, m.recv); idx = at + 1 }
    }
  }
  const scored = [...seen.entries()].filter(([i]) => i >= LEAD_WORDS.length)
  const lats = scored.map(([i, recv]) => recv - (feedStart.recv + durPerWord * (i + 1)))
  allWordLat.push(...lats)

  allTail.push(Math.max(...partials.map(m => m.recv)) - feedEnd.recv)
  console.log(`run ${run}: ${partials.length} partials, ${scored.length}/${WORDS.length} sentence words recognized`)
}

rmSync(dir, { recursive: true, force: true })

function stats(a) {
  if (!a.length) return 'n/a'
  const s = [...a].sort((x, y) => x - y)
  const q = p => s[Math.min(s.length - 1, Math.floor(s.length * p))]
  return `n=${s.length} p50=${q(0.5).toFixed(0)}ms p90=${q(0.9).toFixed(0)}ms mean=${(s.reduce((x, y) => x + y, 0) / s.length).toFixed(0)}ms`
}

console.log('\npartial cadence (inter-partial gap): ', stats(allGaps))
console.log('est. spoken-word → partial latency:  ', stats(allWordLat))
console.log('utterance end → last partial (tail): ', stats(allTail))
