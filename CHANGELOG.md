# Changelog

## v2.1.3 — 2026-09-23

Screen-capture protection hardening.

### Every window is excluded from capture, guaranteed

- **Root cause.** Windows were built explicitly *unprotected*
  (`content_protected(false)`) and flipped on afterward by a separate
  `set_content_protected` call whose result was discarded — so if that call
  didn't take effect, the window stayed captured with nothing to re-check it.
  And the **settings panel was never protected at all**. On macOS,
  `NSWindow.sharingType = none` (verified to be honored by `screencapture` and
  every ScreenCaptureKit path Zoom/Meet use — a protected window captures
  blank) is what excludes a window; the app just wasn't guaranteeing it was
  always set.
- **Fix.** Protection is now baked into every window (prompter and settings) at
  creation, so a window is excluded from its first frame — captured is no
  longer the fallback state — and re-asserted after every lifecycle event that
  could reconfigure or reset it (launch, mode switch, notch elevation,
  notch-metrics refresh, config change, window focus). No window can exist
  unprotected while **Hide on screen share** is on.
- The config field now defaults to protected even in a partial/migrated config
  file (an explicit `false` is still honored).

### Diagnostics and verification

- A runtime diagnostic reports each window's actual `NSWindow.sharingType` and
  the config gate — as a `?capturedebug=1` overlay, a live **Settings** status
  line ("Excluded from screen capture: on / off — visible to Zoom, Meet,
  recordings"), and launch/lifecycle logging.
- `scripts/capture-check.mjs` (`npm run capture-check`) drives the app through
  three states (pill collapsed, panel expanded, tracking session), asserts
  every window is excluded via CoreGraphics, and cross-checks by capturing the
  display and diffing the window rect against the same state captured
  unprotected — failing if the app's own pixels appear.

### A note on notch displays

On a notch display the physical notch cutout is always a black rectangle in any
screen share (macOS draws it, for every app); the app's own pixels — the pill,
the expanded panel, and the script text — are never captured. On non-notch
displays the app's windows are fully invisible in a share.

## v2.1.2 — 2026-09-09

A small follow-up to v2.1.1's live-microphone fix.

### A clear hint when recognition is silent

- If the sidecar VAD reports you're speaking for more than 3 s while no
  recognition partial arrives and the cursor hasn't moved — the signature of
  Microphone granted but **Speech Recognition** denied, or the on-device
  English model missing — the reading status line now shows *"Not hearing
  words — check Microphone & Speech Recognition permissions"* with a
  **Settings** button, and clears the instant a partial arrives. The detector
  is a pure module (`src/lib/stuckDetector.js`) with unit tests.

### The live chain is a release gate

- The end-to-end live-recognition smoke test (`npm run smoke`) now runs on the
  macOS build runner **before** the DMGs are built, so a broken recognition
  chain can't ship. On a headless runner without the dictation model or a
  Speech Recognition grant it skips with a clear log line instead of failing.

### Docs and developer conveniences

- README's Word Tracking section documents silence endpointing and zero-gap
  session rotation, the 30-fixture suite (now including quick-resume and noisy
  variants), and the measured first-word recall (57% → 81%) and cross-sentence
  jumps (6 → 2). New `npm run` scripts — `smoke`, `replay`, `fixtures` —
  documented in CONTRIBUTING.md.

## v2.1.1 — 2026-09-09

Live-microphone reliability. v2.1.0's word-tracking was only ever verified by
feeding audio files through the sidecar; the real microphone path had a
rotation-time bug that made the highlight stall on the first word of each new
sentence. This release fixes the live chain and adds a smoke test so it can't
regress unseen again.

### The highlight no longer stalls on the first word (live mic)

- **Zero audio loss across session rotation.** When the recognizer finalizes a
  sentence at a pause, there was a brief window with no active request — and
  the reader resumes right there, so the *first words of the next sentence*
  were dropped on the floor, leaving the highlight stuck on word one. Audio is
  now buffered and replayed into the next session in order, so nothing is lost.
  The artificial 200 ms delay between sessions is gone. On the regression suite,
  first-word recall of resumed sentences rises from **57 % to 81 %** — fast-rate
  reads went from confirming the opening words of 1 sentence in 7 to 5.

### Tracking adapts to your room

- **Adaptive silence threshold.** The pause detector no longer uses a single
  fixed loudness cutoff (which was fragile at real mic levels and, in a noisy
  room, never registered silence at all — so sessions never rotated). It now
  tracks a rolling noise floor and sets the threshold just above it, so it
  works the same in a quiet room and over fan or café noise. The current floor
  shows in the `?trackdebug` overlay.

### One microphone, not two

- While word tracking is active the app now opens a **single** microphone
  capture. The voicing signal that drives display coasting comes from the
  recognition audio itself (a new `vad` message from the sidecar) instead of a
  second `getUserMedia` stream that competed with it.

### Testing

- `scripts/live-smoke.mjs` exercises the whole sidecar chain end to end
  (rotation, real timestamps, voicing edges, first-word recall) and fails
  loudly on regression. The regression suite gains a **first-word recall**
  metric and two fixture families — **quick-resume** (tight sentence
  resumption) and **noisy** (pink noise at −30 dBFS) — across all three
  scripts, 30 fixtures in all.

## v2.1.0 — 2026-09-08

Word-tracking refinements and truer regression fixtures.

### Coasting — no frozen highlight while the recognizer catches up

- When the frequency-based voice-activity signal says you're still
  speaking but no new recognizer partial has arrived for ~800 ms, the
  **display** cursor keeps advancing at your recently measured reading rate
  (a rolling words-per-second estimate from confirmed advances), capped 8
  words past the confirmed position, and eases back to the exact word on the
  next match. A coasted word shows the accent highlight without the
  confirming underline. It is **display only** — the confirmed cursor, and
  every accuracy metric, is untouched. On by default; a Settings toggle
  turns it off. On the fixture suite the worst within-session display stall
  drops from 4.2 s to 2.1 s

### Structurally faithful tracking fixtures

- The sidecar now rotates recognition sessions on its own **silence
  endpointing** — Apple's on-device recognizer never finalizes a continuous
  feed by itself and gives placeholder timestamps in partials, so the
  pipeline watches the audio energy and calls `endAudio()` at a pause to
  elicit a real final (with real per-word timestamps). This is the
  sentence-boundary rotation a live reader produces, for both microphone and
  file input, and it prevents transcript truncation on long readings
- The 24 synthesized-voice fixtures are regenerated as a **single continuous
  audio feed** per script (the v2.0.0 fixtures used one recognizer run per
  breath group, which made session boundaries coincide with sentence
  boundaries and inflated the cross-sentence jump count); a new misread
  variant adds a long mid-sentence pause that forces a session rotation
  mid-sentence. On the regenerated suite the matcher holds overshoot 0 and
  final cursor error 0 on every fixture (the pre-2.1 greedy matcher makes 34
  cross-sentence jumps to the current matcher's 6); a **line-completion**
  rule commits a line's last dropped words on its closing final so the next
  session aligns from the true boundary. Cross-sentence jumps are 0 on the
  natural-rate clean reads and the jargon script, ≤1 on the fast-rate and
  misread variants

### Fixes

- README: the Word Tracking "Scroll follows you" bullet said the cursor
  "never jumps backward"; corrected to describe the bounded self-correction
  (up to 3 words back), and a coasting sentence added

## v2.0.0 — 2026-09-04

The app is renamed **AI Teleprompter** (previously "Bilingual AI
Teleprompter"), its scope narrows to English-only, the word-tracking engine
is rebuilt to be sequence-coherent, and Prepare with AI grows to four
providers.

### Rename

- Product name, bundle identifier (`com.jackyjiang.bilingual-teleprompter`
  → `com.jackyjiang.ai-teleprompter`), npm/Cargo package and binary names,
  Keychain service, language-model cache directory, and the GitHub
  repository (`bilingual-ai-teleprompter` → `ai-teleprompter`; old URLs
  redirect) all follow the new name
- Because the bundle identifier changed, macOS treats 2.0 as a new app. On
  first launch the app copies anything under the old identifier's
  Application Support directory into the new one — copied, never moved or
  deleted, and exactly once (marker file). The script library and settings
  live in identifier-independent files and carry over untouched. What
  cannot cross an identity change: the Keychain-stored AI provider key
  (re-enter it in Settings) and the microphone/speech-recognition
  permissions (macOS asks again) — a one-time notice in the app explains
  this after the migration

### Sequence-coherent word tracking

- **The cursor no longer teleports.** The old matcher used greedy
  first-match within a 12-word lookahead, committed from unstable partials —
  a single stray common word ("I", "the", "and") that also began the next
  sentence could jump the cursor there permanently. The new matcher aligns
  whole phrases: an English **stopword list** can confirm the next word but
  never justify a jump; a jump requires a **two-word (bigram) anchor** (a
  three-word anchor allows a longer forward resync after the recognizer
  drops a clause); the partial tail is tentative and drives a **provisional**
  display cursor while only **stable** words **commit**; and a stable anchor
  can **backtrack** up to three words to undo a wrong jump. Numbers,
  percentages, years, acronyms, hyphens, and possessives are matched in
  spoken form (`23%` ↔ "twenty three percent", `2027` ↔ "twenty twenty
  seven", `UIUC` ↔ "u i u c"); fuzzy matching tolerates edit distance 1 on
  longer words
- **Per-word recognition + script-biased vocabulary.** The sidecar emits
  each transcription segment's substring, timing, and confidence; every
  recognition request is biased with the script's non-stopword vocabulary
  (`contextualStrings`, all macOS versions) on top of the customized
  language model (now with sliding n-gram phrases), plus an optional
  **Tricky words** list in Settings (bare words or `word=phonemes` X-SAMPA
  pronunciations) for proper nouns the recognizer misreads
- **Synthesized-voice regression suite.** 23 fixtures generated by running
  macOS text-to-speech (three voices, two rates) plus five misread variants
  (fillers, a repeat, a skipped word, a restart, a 2-second silence) back
  through the real recognizer, replayed deterministically in CI. Tuned
  against the whole set: across every fixture the committed cursor never
  overshoots (no wrong teleport) and ends within ≤ 3 words of the true end;
  the original teleport case is a committed regression test. Fixtures are
  synthesized speech; generation (`scripts/make-fixtures.sh`) needs macOS
  and stays out of CI

### Prepare with AI: subscriptions, models, and effort

- Two new providers use an existing **Claude** or **ChatGPT subscription**
  with no API key, by delegating to the official CLIs the user has already
  installed and logged into (Claude Code `claude -p`, OpenAI Codex
  `codex exec`). The app never reads or proxies credentials — the CLIs are
  run with tools/sandbox disabled in an empty directory, with a timeout,
  cancellation, and live Available / Not installed / Not logged in
  detection in Settings
- Unified per-provider **Model** picker (curated list + free-text
  override) and four-tier **Effort** selector (Low / Medium / High /
  Extra high), mapped to each provider's own mechanism (`--effort`,
  `model_reasoning_effort`, `output_config.effort`) and disabled with an
  explanation where unsupported (Ollama)
- The guided setup grows to four cards, subscriptions first; Settings
  states plainly that scripts go to the selected provider on Prepare only,
  that subscription providers consume the user's own plan, and links the
  vendors' (repeatedly changed) 2026 policies on third-party subscription
  use

### English-only scope

- The speech language selector is removed from Settings; word tracking
  always runs the on-device `en-US` recognizer (the sidecar keeps its
  internal locale parameter for future use, but no UI exposes it)
- The tokenizer and cursor matcher work on whitespace-delimited words
  only; the per-character CJK splitting, the script/recognition
  language-mismatch warning, and the Chinese-specific "Prepare with AI"
  prompt instructions are removed
- Demo/seed scripts and visual-test fixtures are English-only

## v1.1.0 — 2026-08-20

UI and word-tracking polish release, driven by real-world use on a
MacBook Pro 14" (M4).

### Word tracking

- **Script-biased recognition (macOS 14+):** each reading session builds a
  customized on-device language model from the current script
  (`SFCustomLanguageModelData`, one phrase per line), cached per
  (script, locale) hash and rebuilt on edit; the recognition session rotates
  to the biased model once prepared, and unsupported systems/locales fall
  back to the stock model silently. Measured on a jargon-heavy sentence:
  words recognized 10/18 → 13/18, p90 word-to-recognition latency
  1428 ms → 792 ms (methodology in `docs/ARCHITECTURE.md` §3.3)
- Display-side responsiveness: scroll-easing time constant ~280 ms → ~100 ms,
  spoken-word fade 300 ms → 150 ms — the next-expected-word highlight now
  reads slightly ahead of the voice instead of trailing it
- Latency instrumentation: sidecar messages carry timestamps, a deterministic
  measurement harness (`scripts/track-latency.mjs` + sidecar `--audio-file`
  mode) records partial cadence and spoken-word→partial latency; baseline on
  an M4: partials every ~250 ms, word→partial p50 400 ms / p90 619 ms
- Fixed: adopting the custom model mid-session could cascade a canceled
  recognition task's error into a fatal `recognizer_storm`
- Script/recognition language mismatches (English script with 中文 tracking,
  or a mostly-Chinese script with English) are detected when reading starts
  and surfaced in the reading view and the settings window
- Dev-only tracking-quality overlay (`?trackdebug=1`): raw partials vs
  matched position, LM state, confidence, partial age

### UI

- **Notch fit:** the collapsed pill now derives its exact width, height, and
  x-position from the physical notch at runtime (NSScreen `safeAreaInsets` +
  auxiliary top areas) instead of hardcoded values, correct on any model and
  any display-scaling option; the expanded panel centers on the measured
  notch. Non-notch displays and classic mode are unchanged
- **Editor simplified around reading on camera:** single header row —
  close · script switcher tabs (with a "+" tab replacing + New) ·
  ✦ Prepare · Go · quit. Save button removed in favor of debounced autosave
  with a subtle "Saved" indicator; ⌘S remains as a manual trigger. Cue
  markers consolidated into one "+ Cue" insert menu and bold/color controls
  into a "⋯" overflow menu, both in the footer; the freed rows go to script
  text
- **Guided AI setup:** the first ✦ Prepare click opens a one-time inline
  setup explaining the two providers (Claude API key vs local Ollama), with
  a real "Test connection" validation (new `ai_test` command), then
  automatically continues the originally requested Prepare; with a provider
  configured, Prepare runs immediately behind a visible progress overlay
- **Theme-safe text colors:** script text defaults to the theme text color
  in both the editor and the prompter; explicit white/black/transparent
  color marks are neutralized at load and render time (healing legacy
  scripts), and AI-prepared output inherits the default style — no
  combination can render text invisible
- **Scrollbars:** every scrollable view uses thin overlay-style scrollbars —
  transparent track, subtle theme-tinted thumb — in both themes

### Internals

- 76 unit tests (was 58); visual golden coverage extended to 16 states
  (AI setup panel) and stabilized (fonts-ready wait, deterministic
  trackdemo scroll)
- Dev/test hooks: `TELEPROMPTER_FAKE_NOTCH`, `?aisetup=1`, `?scrolldemo=1`,
  `?trackdebug=1`, sidecar `--script` / `--audio-file`

## v1.0.0 — 2026-08-19

First release of **Bilingual AI Teleprompter**, a fork of
[openTeleprompt](https://github.com/ArunNGun/openTeleprompt) by
[ArunNGun](https://github.com/ArunNGun) (MIT). Version numbering restarts at
1.0.0 for the fork; the upstream base is openTeleprompt v3.0.0.

### Inherited from openTeleprompt v3.0.0

- Dynamic Island notch overlay with real concave corners and Apple spring
  physics; classic draggable-pill mode for Macs without a notch
- Voice-activated scrolling via frequency analysis (85–3400 Hz) — retained
  in this fork as the fallback engine
- React + Vite + Zustand frontend; Tauri v2 / Rust backend
- Rich text script editor (Tiptap): bold, color highlights, and
  `[PAUSE]` / `[SLOW]` / `[BREATHE]` cue markers
- Script library with auto-save (local only — no cloud, no accounts)
- Invisible during screen share (Zoom, Meet, Loom)
- Light & dark themes, opacity control, live speed/font-size controls,
  global shortcuts (⌘⇧Space, ⌘⇧↑↓, ⌘⇧R)

### New in this fork

**Word-level speech tracking (English + Mandarin)**

- On-device speech recognition (Apple Speech framework, via a supervised
  Swift sidecar) replaces volume-only activation: the prompter recognizes
  what you say, dims spoken text, highlights the current word, and drives
  the scroll from your actual reading position
- English (`en-US`) and Mandarin (`zh-CN`), selectable in settings; Chinese
  is matched per character, and mixed Chinese-English scripts are handled
- Forward-only cursor matching tolerates skipped words, fillers, and
  misreads; never jumps backward
- Fully private: `requiresOnDeviceRecognition` is enforced — no audio or
  transcripts leave the machine
- Graceful degradation to the original frequency-based activation when
  Speech permission is denied or the language model is unavailable, with a
  clear status message in settings

**Prepare with AI (optional)**

- "✦ Prepare" rewrites a raw script (English or Chinese) into teleprompter
  form: short lines for the narrow panel, natural spoken phrasing, and cue
  markers at rhetorically appropriate points; Chinese lines break at
  prosodic boundaries
- Side-by-side review (original vs editable prepared text) with
  Accept/Reject; the original is saved to the library before any replace
- Two providers: Anthropic API (key stored in the macOS Keychain, never in
  plaintext config) or any local OpenAI-compatible endpoint (e.g. Ollama)
  for offline use
- Strictly opt-in: off by default, and scripts are sent only on explicit
  user action

**Fixes and maintenance**

- Visual snapshot suite repaired: the harness navigated to URL states the
  app never read, so non-idle states were untestable; browser-only test
  hooks added and coverage extended from 6 to 10 states (AI review panel,
  word-tracking read view). `puppeteer-core` declared as the dev dependency
  the harness always required
- CJK-aware tokenizer: Chinese script text is tokenized per character with
  original spacing preserved (upstream treated an unsegmented Chinese
  paragraph as one giant word)
- 50 unit tests (vitest) covering the tokenizer, cursor matcher, and AI
  prompt/parsing logic, including mixed-language cases
- Release workflow rebuilt for this repository; sidecar cross-compilation
  wired for CI (Intel builds on Apple Silicon runners)

### Attribution

All upstream functionality is the work of the original author. See
[NOTICE](NOTICE) and [LICENSE](LICENSE); the full upstream commit history is
preserved in this repository.
