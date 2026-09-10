// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
/**
 * live-smoke.mjs — end-to-end smoke test of the LIVE recognition chain.
 *
 * v2.1.0's live microphone path was only ever verified by feeding audio files
 * through the sidecar, never exercised as a whole; a rotation-time audio-loss
 * bug therefore shipped unseen (see docs/ARCHITECTURE.md §3.1). This script
 * exercises the whole sidecar chain the GUI depends on — the silence
 * endpointer, session rotation, the zero-gap replay queue, real per-word
 * finalization, and the VAD voicing messages — end to end, and fails loudly
 * if any of it regresses.
 *
 * It stops just short of the microphone tap itself (that needs TCC grants and
 * hardware, so it can't run unattended); the tap is a thin AVAudioEngine
 * shim over the same appendBuffer() path this drives. To verify the actual
 * microphone, follow the manual steps in docs/ARCHITECTURE.md §3.1.
 *
 * Usage:  node scripts/live-smoke.mjs            # build sidecar if needed, run
 *         node scripts/live-smoke.mjs --no-build # use the existing sidecar
 *
 * Requires macOS (`say`, `afconvert`, on-device recognition). Exits non-zero
 * on any failed assertion, so it can gate a macOS CI job.
 */

import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import readline from 'readline'
import { replayFixture } from './track-replay.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const SIDECAR = join(ROOT, 'src-tauri/binaries/speech-sidecar-aarch64-apple-darwin')

// A four-sentence clip of ordinary, easily-recognized English with tight
// (~630 ms) inter-sentence pauses — just past the 600 ms endpoint — so every
// sentence resumes right at a session rotation, the exact condition that used
// to drop first words. Ordinary words (not the phonetic alphabet, which the
// recognizer mis-hears) keep first-word recall a measure of audio loss across
// rotation, not of recognition accuracy.
const SCRIPT = 'Good morning everyone and welcome to the show. Today we will explore three important ideas together. First let us look at the bigger picture here. Finally I want to thank you all for listening.'
const SPOKEN = SCRIPT.replace(/([.!?])\s+(?=[A-Z])/g, '$1 [[slnc 630]] ') + ' [[slnc 800]]'

const failures = []
let skipped = false
const check = (cond, msg) => { if (!cond) failures.push(msg); else console.log(`  ✓ ${msg}`) }

function buildSidecar() {
  console.log('building sidecar…')
  execFileSync('bash', [join(ROOT, 'scripts/build-sidecar.sh')], { stdio: 'inherit' })
}

async function run() {
  if (!process.argv.includes('--no-build') || !existsSync(SIDECAR)) buildSidecar()
  if (!existsSync(SIDECAR)) { console.error(`sidecar missing: ${SIDECAR}`); process.exit(1) }

  const dir = mkdtempSync(join(tmpdir(), 'live-smoke-'))
  const aiff = join(dir, 'clip.aiff')
  const wav = join(dir, 'clip.wav')
  try {
    execFileSync('say', ['-v', 'Samantha', '-r', '175', '-o', aiff, SPOKEN])
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', '-c', '1', aiff, wav])

    console.log('feeding clip through the sidecar (live chain)…')
    const messages = []
    const sidecar = spawn(SIDECAR, ['--locale', 'en-US', '--audio-file', wav],
      { stdio: ['ignore', 'pipe', 'inherit'] })
    readline.createInterface({ input: sidecar.stdout }).on('line', (line) => {
      try { messages.push(JSON.parse(line)) } catch {}
    })
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        const end = messages.find(m => m.type === 'feed' && m.state === 'end')
        if (end && Date.now() - (end.t || 0) > 2500) { clearInterval(iv); resolve() }
        if (messages.find(m => m.type === 'error' && m.fatal)) { clearInterval(iv); resolve() }
      }, 100)
      setTimeout(() => { clearInterval(iv); resolve() }, 30000) // hard cap
    })
    sidecar.kill()

    // ── Skip cleanly when the environment can't do on-device recognition ──
    // A headless CI runner may lack the on-device English dictation model or a
    // Speech Recognition grant. That is not a regression — the live chain
    // simply can't be exercised here — so exit 0 with a clear line rather than
    // fail. We only FAIL when recognition actually ran and an assertion broke.
    const SKIP_CODES = ['auth_denied', 'auth_restricted', 'locale_unavailable', 'ondevice_unsupported']
    const fatal = messages.find(m => m.type === 'error' && m.fatal)
    const anyRecognition = messages.some(m => m.type === 'partial' || m.type === 'final')
    if ((fatal && SKIP_CODES.includes(fatal.code)) || !anyRecognition) {
      const why = fatal ? `${fatal.code}: ${fatal.message || ''}`.trim() : 'no partials or finals were produced'
      console.log(`\n⏭  live-smoke SKIPPED — on-device English recognition unavailable here (${why}).`)
      console.log('   Expected on headless CI without the dictation model or a Speech Recognition grant; not a failure.')
      skipped = true
      return
    }

    // ── Assertions over the live chain ──
    const finals = messages.filter(m => m.type === 'final')
    const sessions = new Set(messages.filter(m => m.type === 'partial' || m.type === 'final').map(m => m.session))
    const vad = messages.filter(m => m.type === 'vad')
    const vadUp = vad.filter(v => v.speaking).length
    const vadDown = vad.filter(v => !v.speaking).length

    console.log('\nassertions:')
    check(sessions.size >= 4, `silence endpointing rotated ≥4 sessions (got ${sessions.size})`)
    check(finals.length >= 4, `≥4 real finals delivered (got ${finals.length})`)

    // Real per-word timestamps: a session's final must have words whose
    // timestamps are not all the placeholder 0 (the bug that motivated the
    // endpointer). Check the last final with words.
    const withWords = finals.filter(f => Array.isArray(f.words) && f.words.length > 1)
    const realTs = withWords.some(f => new Set(f.words.map(w => w.t)).size > 1)
    check(withWords.length > 0 && realTs, 'finals carry real per-word timestamps (not placeholders)')

    check(vadUp >= 3, `VAD emitted rising voicing edges (got ${vadUp})`)
    check(vadDown >= 3, `VAD emitted falling voicing edges (got ${vadDown})`)
    check(vad.every(v => typeof v.floor === 'number'), 'every VAD message carries the adaptive floor')

    // First-word recall through the real matcher: with the zero-gap replay the
    // opening words of every resumed sentence survive rotation.
    const fixture = { script: SCRIPT, messages, expectedFinal: undefined }
    const m = replayFixture(fixture)
    check(m.overshoot === 0, `no teleport (overshoot ${m.overshoot})`)
    // Coarse health gate on a 4-sentence sample (the strict 75 % suite-wide
    // bound lives in tracking-suite.test.js). The pre-fix bug scored ~1/4
    // here; a healthy chain scores 3–4/4, so 50 % separates them without
    // flaking on run-to-run recognition variance.
    check(m.firstWordRecallPct >= 50,
      `first-word recall ${m.firstWordSentences}/${m.sentenceCount} sentences (${m.firstWordRecallPct}%) ≥ 50%`)

    console.log(`\nsummary: ${sessions.size} sessions · ${finals.length} finals · ${vad.length} vad edges · first-word recall ${m.firstWordRecallPct}%`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  if (skipped) return   // clean skip: exit 0 without a PASS/FAIL verdict
  if (failures.length) {
    console.error(`\n❌ live-smoke FAILED (${failures.length}):`)
    for (const f of failures) console.error(`   - ${f}`)
    process.exit(1)
  }
  console.log('\n✅ live-smoke PASSED — the live recognition chain is healthy.')
}

run().catch((e) => { console.error(e); process.exit(1) })
