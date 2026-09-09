# Architecture

Technical architecture of this codebase (upstream: [openTeleprompt](https://github.com/ArunNGun/openTeleprompt) v3.0.0, extended in this fork with on-device word-level speech tracking — §3.1). A Tauri v2 desktop app: Rust backend, React 19 + Vite frontend, Zustand state, Tiptap rich-text editing, plus a Swift speech-recognition sidecar. `file:line` references date from the fork-point audit; in files this fork has since modified (`lib.rs`, `ReadView.jsx`, `tokenizer.js`, settings) they may be offset — treat them as anchors, not exact coordinates.

> **Scope note.** `frontend/renderer/` is the legacy Electron v1.x renderer (plain JS, `frontend/renderer/app.js`). On macOS nothing references it anymore (this fork removed the last consumer — see §1.4); only the compiled-out Windows settings path still points at it. `docs/` (other than this file) is the GitHub Pages landing site.

---

## 1. High-level architecture

### 1.1 Process model

There is one Rust process and up to three WebView windows, each identified by a Tauri window label:

| Window label | Content | Created at |
|---|---|---|
| `prompter` | React app (`index.html` → `src/main.jsx` → `src/App.jsx`) — the notch island / classic pill | `setup()` at `src-tauri/src/lib.rs:693-708`, and recreated by `create_prompter_window()` at `lib.rs:511-578` on mode switch |
| `settings` | React settings panel (`settings.html` → `src/settings-main.jsx` → `src/views/SettingsView.jsx`) | lazily by `show_settings()` at `lib.rs:601-631` on tray click |
On a normal launch exactly two things appear: the notch pill (the `prompter` window in its idle state) and the tray icon. (Window inventories via `CGWindowList` also show a third, never-onscreen 500×500 layer-0 window owned by the app: bisection with the prompter webview disabled confirmed it is created by WKWebView itself — a WebKit-internal helper window, not app code. It is invisible, harmless, and appears in every Tauri/wry app; don't chase it.) Upstream also opened a first-launch `welcome` window (borderless, centered, always-on-top) pointing at `renderer/welcome.html` — a file absent from the bundled frontend, which produced an unclosable blank/black window; this fork removed it along with the `close_welcome` command and the `~/.teleprompter-launched` marker logic. The editor is not a separate window: it is the `edit` view *inside* the prompter island, opened only by explicit action — clicking the pill, or the ⌘⇧E global shortcut (§5.2).

In addition to the windows there is one supervised child process: **`speech-sidecar`**, a Swift binary (source `src-tauri/sidecar/speech-sidecar.swift`, bundled via `externalBin` in `tauri.conf.json`) that runs Apple's `SFSpeechRecognizer` fully on-device and streams partial transcripts to the app — see §3.1.

Entry point: `src-tauri/src/main.rs:4-6` calls `ai_teleprompter_lib::run()`, which runs the one-time identity migration (§1.5), then registers four plugins — `tauri_plugin_global_shortcut`, `tauri_plugin_fs`, `tauri_plugin_shell`, `tauri_plugin_positioner` — installs `AppState`, registers the invoke handlers, and builds the tray + global shortcuts in `setup()`.

The two React windows are separate Vite entry points, declared in `vite.config.js:14-17` (`rollupOptions.input: { main: 'index.html', settings: 'settings.html' }`). They do **not** share JS state; they synchronize only through the Rust backend (see §1.3).

### 1.2 IPC layer

`tauri.conf.json:13` sets `"withGlobalTauri": true`, and the frontend has **no `@tauri-apps/api` npm dependency** (see `package.json` dependencies). All IPC goes through the injected global:

- `src/lib/api.js:1-2` — `window.__TAURI__.core.invoke` and `window.__TAURI__.event.listen`, with no-op fallbacks so the UI also runs in a plain browser (`src/App.jsx:120` uses `!window.__TAURI__` to show a dev panel).
- `src/views/SettingsView.jsx:3-16` duplicates a smaller inline `API` object for the settings window.

Direction of traffic:

- **JS → Rust (commands):** the 34 handlers registered in `run()` (`get_config`, `set_config`, `switch_mode`, `get_notch_metrics`, `get_scripts`, `save_scripts`, `set_ignore_mouse`, `resize_prompter`, `toggle_prompter`, `resize_settings`, `quit_app`, `open_devtools`, `hide_settings`, `start_drag`, `set_movable`, `move_window`, `get_window_pos`, `open_url`, `open_settings`, `focus_prompter`, `elevate_notch_window`, `start_speech`, `stop_speech`, `get_speech_status`, `set_speech_notice`, `get_speech_notice`, `save_tracking_fixture` (dev-only, §3.3), `ai_complete`, `ai_test`, `set_ai_key`, `has_ai_key`, `detect_ai_provider`, `ai_cli_prepare`, `cancel_ai_cli` (§4.4a)).
- **Rust → JS (events):** three event names.
  - `config-update` — broadcast by `set_config`; consumed by `App.jsx` (which normalizes snake_case→camelCase) and `SettingsView.jsx`.
  - `shortcut` — emitted to the `prompter` window with a string payload `"pause" | "faster" | "slower" | "reset"` from the global-shortcut handler, and `"stop"` from `switch_mode` and `toggle_prompter`; consumed in `ReadView.jsx`.
  - `speech-msg` — broadcast to all windows: every NDJSON line from the speech sidecar plus a synthetic `{"type":"terminated"}` on process exit (see §3.1). Consumed by `src/lib/speech.js` (tracking) and `SettingsView.jsx` (status display).

Permissions for the WebView side are scoped in `src-tauri/capabilities/default.json` to the `prompter` and `settings` windows (core window ops, `global-shortcut:*`, `fs:*`, `positioner:*`).

### 1.3 State ownership

Three state stores, with the Rust side as source of truth for anything persistent:

1. **Rust `AppState`**: `Mutex<Config>`, `Mutex<Option<(f64,f64)>>` (last classic-mode window position), plus the speech sidecar's `CommandChild` handle and last status value. `Config` holds `scroll_speed`, `threshold`, `screenshare_hidden`, `mode`, `opacity`, `auto_scroll`, `mic_device_id`, `theme`, `word_tracking`, `tracking_hints` (the user's tricky-words list, §3.3), and the non-secret AI settings `ai_provider`/`ai_model`/`ai_local_url`/`ai_prefs` (per-provider model+effort, §4.4); serialized camelCase (fields added by this fork carry `#[serde(default)]`s so pre-existing config files still parse). The Anthropic API key is **not** in `Config` — it lives in the macOS Keychain (§4.4).
2. **Disk**: two dotfiles in the user's home directory: `~/.teleprompter-config.json` and `~/.teleprompter-scripts.json` (upstream's `~/.teleprompter-launched` first-launch marker went away with the welcome window, §1.1). Writes happen in `save_config` and `save_scripts_to_disk`. Both paths are independent of the bundle identifier, which is why the 2.0 rename did not touch them (§1.5).
3. **Zustand store** (`src/store/index.js`): a single `useAppStore` with `view` (`'idle' | 'edit' | 'read'`), a `config` mirror, `scripts` + `currentScriptIndex`, the active script (`scriptText` plain text, `scriptDoc` Tiptap JSON), playback flags, and `recognition` — the speech-tracking state written by ReadView while reading (`engine: 'none'|'speech'|'vad'`, `status`, `message`, `cursorTokenIndex`, `matchedCount`, `total`, `confidence`).

**Caveat (verified):** the playback flags in the store (`isSpeaking`, `isPaused`, `isHoverPaused`, `isRunning`, `speedIndex`, `store/index.js:29-39`) are written by nothing — `ReadView.jsx:16-17` shadows them with local `useState`, and all `setIsSpeaking`/`setIsPaused` calls in `ReadView` are those local setters. `IdleView.jsx:4` reads the store's `isSpeaking`/`isPaused`, which therefore remain at their initial `false`. Treat the store flags as dead code inherited from a refactor; real playback state lives in `ReadView` local state + refs (§3.2.3). The newer `recognition` slice IS live — ReadView writes it while reading.

### 1.4 Known upstream quirks (relevant when extending)

Documented here because they affect where new code can safely go; none were changed in this fork:

- **(Fixed in this fork.)** Upstream pointed several release URLs at `renderer/*` paths absent from the bundled frontend (the Vite build emits only `index.html` and `settings.html`): the initial prompter (which loaded only via the asset protocol's SPA fallback — now `index.html` directly) and the first-launch `welcome` window (which rendered an unclosable blank window — now removed, see §1.1). Only the compiled-out Windows settings path still references `renderer/`.
- `src/lib/api.js:5` — `elevateNotchWindow` calls a bare `invoke` (undefined identifier; would throw if invoked). Nothing calls it: notch elevation actually happens Rust-side (§2.2). The `elevate_notch_window` command (`lib.rs:267-279`) is effectively unreachable from JS as wired.
- `src-tauri/Cargo.toml:23-33`: `serde`, `serde_json`, `dirs`, `open` and all four Tauri plugins are declared under `[target.'cfg(target_os = "macos")'.dependencies]`, so the crate as committed only builds on macOS (consistent with the README's "Windows v3 coming soon").

### 1.5 Identity migration (v2.0.0 rename)

v2.0.0 renamed the bundle identifier to `com.jackyjiang.ai-teleprompter`, so macOS treats the app as new. `migrate_previous_identity()` (called first thing in `run()`) copies anything under the old identifier's `~/Library/Application Support` directory into the new one — copy-only, never overwriting an existing destination file and never touching the source — guarded by a marker file (`migrated-from-previous-identity.json`) in the new directory so it runs exactly once. The scripts/config dotfiles (§1.3) are identifier-independent and need no migration. When any old-identity footprint is detected (old app-support, caches, LM cache, or WebKit directory), `RunEvent::Ready` shows a one-time `NSAlert` explaining the two things that cannot cross an identity change: the Keychain-stored API key and the TCC microphone/speech permissions. The copy logic is unit-tested against fixture directories (`cargo test`, `migration_tests` in `lib.rs`).

---

## 2. Window management (notch overlay)

### 2.1 Window creation flags

Both creation sites (`lib.rs:543-558` and `lib.rs:693-708`) use `tauri::WebviewWindowBuilder` with:

```
.decorations(false)  .transparent(true)  .always_on_top(true)
.skip_taskbar(true)  .resizable(mode == "classic")  .accept_first_mouse(true)
.visible_on_all_workspaces(true)  .content_protected(false)
```

In notch mode the window is created **full screen width × 200 px at (0, 0)** (`lib.rs:528`, `lib.rs:684`); CSS renders only the island inside it. Transparency on macOS requires `"macOSPrivateApi": true` (`tauri.conf.json:19`) plus the `macos-private-api` cargo feature (`Cargo.toml:20`). The app is a menu-bar-style accessory: `set_activation_policy(ActivationPolicy::Accessory)` (`lib.rs:675`) and `LSUIElement=true` in `src-tauri/Info.plist`.

### 2.2 Elevation above the menu bar (the notch trick)

`elevate_to_notch_level()` (`lib.rs:13-52`, macOS only) drops below Tauri to raw AppKit via `objc2`/`objc2-app-kit`:

1. `window.ns_window()` obtains the `NSWindow` pointer (`lib.rs:16`).
2. `setLevel(27)` — `NSMainMenuWindowLevel` (24) + 3, so the window floats **above the menu bar** (`lib.rs:25`).
3. `setCollectionBehavior((1<<0)|(1<<4)|(1<<6)|(1<<8))` — `canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary` (`lib.rs:27-29`).
4. `setHasShadow(false)` (`lib.rs:30`).
5. `setFrame_display` repositions the window flush with the physical screen top. **Display selection (this fork):** the target screen is the one with a physical notch — the first `NSScreen` whose `safeAreaInsets.top > 0` — falling back to `mainScreen` when no notch display exists (clamshell mode, external-only setups). Upstream used `mainScreen` (the screen with keyboard focus) unconditionally, which parked the pill on an external monitor whenever focus was there; requires macOS 12+ API, and `minimumSystemVersion` is now 13.0. The window is 200 px tall = ~160 px notch content + 40 px overlap kept on-screen because WKWebView stops rendering when fully above the visible area (comment at `lib.rs:7-12`).

Called from `setup()` (`lib.rs:713-715`) and from `create_prompter_window()` (`lib.rs:572-575`); `switch_mode` dispatches recreation via `run_on_main_thread` because NSWindow APIs must run on the main thread (`lib.rs:327-331`).

### 2.3 Hidden from screen capture

`apply_screenshare_mode()` calls Tauri's `WebviewWindow::set_content_protected(bool)` — on macOS this sets `NSWindow.sharingType = .none`, which excludes the window from screen recording/sharing. **Dev-only escape hatch (this fork):** launching with `TELEPROMPTER_ALLOW_CAPTURE=1` disables the protection so the pill can be screenshotted (README captures, visual debugging); the related `TELEPROMPTER_DEMO_PARAMS="view=read&trackdemo=1"` env var navigates the prompter to the same URL demo hooks the snapshot suite uses (§ tests), so fixed UI states can be driven in the real app. Neither is ever set in normal operation, so protection stays on by default. `scripts/readme-shots-real.sh` automates this flow: it launches the app once per demo state and captures the live prompter window for `docs/screenshots/` (requires the invoking terminal to hold macOS Screen Recording permission). It is applied at window creation (`lib.rs:567`, `lib.rs:717-719`) and re-applied whenever `set_config` receives `screenshareHidden` (`lib.rs:302-304`). Default is ON (`Config::default`, `lib.rs:96`).

### 2.4 Resizing, click-through, dragging

- **Resize protocol:** the frontend owns geometry. `App.jsx:11-23` defines per-view sizes (`ISLAND_SIZES` / `CLASSIC_SIZES`); the effect at `App.jsx:87-94` calls `API.resizePrompter` on every view/hover/mode change. Rust's `resize_prompter` (`lib.rs:355-392`) in notch mode sizes the window to exactly the island and horizontally centers it at y = 0 (so the small idle pill doesn't intercept clicks across the whole screen top); in classic mode it resizes in place.
- **Click-through:** `set_ignore_mouse` → `set_ignore_cursor_events` (`lib.rs:342-352`), force-disabled in classic mode. Never set at creation time — a code comment (`lib.rs:565-566`) notes doing so breaks WKWebView rendering; `App.jsx:45` re-enables mouse after mount.
- **Classic dragging:** mousedown on non-interactive elements calls `API.startDrag()` → `start_dragging()` (`App.jsx:102-107`, `lib.rs:480-485`); position persisted in `AppState.classic_pos` via `move_window` (`lib.rs:458-467`).
- **Closing vs quitting (this fork):** the editor's header ✕ collapses the island back to the idle pill (the prompter window itself never closes); the app quits only through explicit quit controls — a hover-revealed quit icon on the idle pill (always visible in classic mode), a ⏻ button in the editor header, or the tray settings panel's Quit — all invoking `quit_app`, whose `RunEvent::Exit` handler kills the speech sidecar so no child process outlives the app.
- **Settings window placement:** anchored to the tray icon via `tauri-plugin-positioner` `Position::TrayCenter`, gated by the `TRAY_CLICKED` atomic because the positioner panics before it has seen a tray event (`lib.rs:63`, `lib.rs:591-598`); falls back to bottom-right. Settings hides instead of closing (`CloseRequested` handler, `lib.rs:847-855`) and auto-hides on blur (`SettingsView.jsx:73-76`).

---

## 3. Reading-position pipelines

Two pipelines can drive the prompter while reading:

1. **Word-level speech tracking** (§3.1, default) — on-device speech recognition aligns what you say against the script; the scroll offset follows your actual reading position, spoken text dims, and the current word is highlighted.
2. **Frequency-based voice activation** (§3.2, fallback) — the original upstream energy heuristic: constant-speed scroll while a per-frame "is the user speaking?" boolean is true. Used when word tracking is disabled in settings, when running outside Tauri (browser dev), or when recognition is unavailable (see degradation rules below).

### 3.1 Word-level speech tracking (speech sidecar)

**Process.** `src-tauri/sidecar/speech-sidecar.swift` is a standalone Swift binary compiled by `scripts/build-sidecar.sh` into `src-tauri/binaries/speech-sidecar-<target-triple>` (gitignored; built automatically by `beforeDevCommand`/`beforeBuildCommand`) and bundled through `externalBin`. It runs `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true`, `shouldReportPartialResults = true`, `taskHint = .dictation`, and `addsPunctuation = false`, fed by an `AVAudioEngine` input tap. **All recognition is on-device; nothing leaves the machine** — the binary's only output channel is NDJSON on stdout to the parent app. It refuses to run at all (fatal `ondevice_unsupported`) if the selected locale's on-device model is missing.

**Protocol** (one JSON object per stdout line, every message stamped with `t` = ms since epoch): `ready {locale, onDevice}`, `partial`/`final {session, text, confidence, words}` — `words` is the per-segment payload (`[{w, t, d, c}]`: substring, timestamp in seconds from the session's audio start, duration, confidence per `SFTranscriptionSegment`; `text` remains the full formatted string, `confidence` the segment mean) — `lm {state}` (customized language model lifecycle, §3.3), `vad {speaking, floor}` (voicing-state edges from the endpointer, drives display coasting — one per rising/falling transition, `floor` = the current adaptive silence floor), `feed {state}` (measurement mode only), and `error {code, message, fatal}`. Emission is unbuffered — each line is one direct `write(2)`, so partials reach the parent the moment the recognizer produces them. Fatal codes: `auth_denied`, `auth_restricted`, `locale_unavailable`, `ondevice_unsupported`, `audio_error`, `recognizer_storm` (three failures within 2 s of session start). Args: `--locale <id>`, `--script <path>` (script text for the customized LM, §3.3), `--contextual <path>` (newline-separated vocabulary set as `contextualStrings` on every recognition request — request-level biasing that works on all supported macOS versions), `--tricky <path>` (the user's tricky-words list, §3.3), `--audio-file <path>` (dev/measurement: feed a file at real-time pace instead of the mic).

**Session rotation (silence endpointing).** Apple's on-device recognizer, run as one continuous buffer-append request, **never emits an `isFinal` on its own** and its *partial*-result segment timestamps are placeholders (uniform ~0.011 s steps) — only a result elicited by `endAudio()` carries real per-word timestamps. So the pipeline endpoints on the audio energy itself: `appendBuffer()` (the single append path for both the microphone tap and `--audio-file` feed) tracks RMS, and after a pause of `SILENCE_MS_TO_ENDPOINT` (600 ms) below an **adaptive silence threshold** it calls `endAudio()` on the request. The recognizer then delivers the session's real final (with real timestamps); the `isFinal` callback emits it and `advance()`s to a fresh session — the sentence-boundary session rotation a reader produces. A watchdog hard-rotates if no final arrives within 1.5 s. This keeps any one session's transcript short (no head truncation on long readings) and makes time-based stability gating (§3.3) real, since finals now carry true timing. `advance()` (from a delivered final) does not cancel the task; `hardRotate()` (custom-LM adoption, recoverable errors, the watchdog) cancels and starts fresh. Each rotation increments `session`, each session's transcript starts empty, and errors from an already-rotated session are ignored so a rotation can't cascade.

**Adaptive silence threshold (v2.1.1).** A fixed RMS threshold cannot serve both a silent room and a noisy one, and real microphone speech levels (RMS ≈ 0.006–0.05, depending on distance and gain) straddle any constant — v2.1.0's fixed `0.006` was fragile on live audio and, above it, sessions would never rotate (nothing ever read as silence). The threshold is now derived per buffer from a rolling **noise floor**: the floor snaps down fast toward a new quieter minimum (`FLOOR_FALL`) and creeps up very slowly (`FLOOR_RISE`) so speech energy never drags it up, and the threshold sits a margin above it (`floor × 3 + 0.0015`), clamped to `[0.004, 0.040]`. The current floor is exposed on every `vad` message and in the `?trackdebug` overlay. The **noisy** fixture family (§3.3, pink noise at −30 dBFS) exercises this: with a fixed threshold those sessions never rotate; with the adaptive floor they rotate and land exactly.

**Zero-gap session rotation (v2.1.1).** Rotation has a hazard: `endpoint()` calls `endAudio()` and clears `request`, and no new request is live until the delivered final triggers `advance()`/`startSession()`. Audio arriving in that window — the *first words of the next sentence*, since the reader resumes right after the pause — has nowhere to go. v2.1.0 dropped it (`request?.append` on a nil request is a no-op), stranding the committed cursor on the resumed line's later words; on a live microphone, where finalization is slower than in a file feed, this is the freeze/one-word-stall that v2.1.0 shipped with (only ever exercised through file feeds, never a real mic — the root cause behind this release). The fix is a bounded **replay queue**: while no request is live, `appendBuffer()` appends incoming buffers to `pendingBuffers` (capped at `maxPendingSeconds`, 3 s — the watchdog rotates before that); `startSession()` replays the queue into the new request, in order, *before* any live buffer, so nothing is lost and ordering is preserved. This is the queue-and-replay approach (b); concurrent on-device tasks (approach a) was rejected as a custom-LM concurrency risk. The artificial 200 ms delay `advance()` used before starting the next session is removed (`hardRotate()` keeps a 200 ms delay as an error-storm guard). Measured on a tight-resume clip, first-two-words recall rose from 2/4 to 3/4 sentences even in the file feed where the gap is smallest; the regression suite's **first-word recall** metric (§3.3) tracks it across the whole fixture set.

**Live-path verification.** Because v2.1.0's live chain shipped unverified, `scripts/live-smoke.mjs` now exercises it end to end: it feeds a tight-resume clip through the built sidecar and asserts session rotation, real per-word timestamps, `vad` rising/falling edges with a floor, no overshoot, and first-word recall ≥ 75 %. It stops just short of the microphone tap itself (that needs a TCC grant and hardware); to verify the actual mic, grant Microphone + Speech Recognition to the app, open a script with `?trackdebug`, play synthesized speech through the speakers or a loopback into the mic, and watch the overlay's session/floor/voicing fields advance as each sentence is read.

**Supervision (Rust).** `start_speech(locale, script_text)` in `src-tauri/src/lib.rs` kills any previous instance (script text is written to a temp file and forwarded as `--script` for the customized LM, §3.3), spawns the sidecar via `tauri_plugin_shell`'s `sidecar()`, and pumps its stdout: every parsed line is broadcast to all windows as a `speech-msg` event; `ready`/`error` lines are also stored in `AppState.speech_status` so the settings window can query the latest state via `get_speech_status` after the fact. Process exit surfaces as a synthetic `{"type":"terminated","code"}` message. `stop_speech` kills the child; the `RunEvent::Exit` handler guarantees the sidecar never outlives the app. Rust makes no policy decisions — restart and fallback logic live in the frontend.

**Matching (JS).** `src/lib/matcher.js` implements the forward-searching cursor:

- Script tokens come from `tokenizeDoc` (`src/lib/tokenizer.js`), which splits text into whitespace-delimited word tokens (markers and newlines are display-only token types).
- Transcript text is tokenized the same way (`tokenizeTranscript`), and both sides are normalized by `normalizeWord`: NFKC fold (full-width → half-width), lowercase, strip all non-letter/non-digit characters in any script.
- `createCursorMatcher(tokens)` maintains two cursors — a **committed** one (evidence-backed, drives the dimming of spoken text) and a **provisional** one (includes the tentative tail of the latest partial, drives the highlight and the scroll) — under the sequence-coherence rules described in §3.3: stopwords can only confirm the next expected word, multi-word advances need a bigram anchor (≤ 6 words), commits require stability (repeat, ~600 ms age, or a final), and a stable bigram anchor can pull the committed cursor back up to 3 words to undo a wrong jump. Unit tests: `src/lib/__tests__/matcher.test.js`, `tokenizer.test.js`, and the fixture replay in `tracking-fixture.test.js` (`npm test`).

**Frontend wiring.** `src/lib/speech.js` (`createSpeechTracker`) subscribes to `speech-msg`, feeds partials into the matcher, and owns policy: up to 2 restarts on unexpected termination, then fallback; fatal error codes map to user-facing messages (`fallbackMessageFor`). `ReadView.jsx` starts the tracker on mount when `config.wordTracking` is on, mirrors every update into the Zustand `recognition` state, and renders word tokens with per-token refs and classes — `tok-spoken` (opacity 0.35) for tokens behind the cursor, `tok-current` (accent underline) for the next expected word, full brightness ahead (`src/style.css`). The RAF loop's tracking branch eases the scroll offset toward `currentWordEl.offsetTop − 0.35 × viewportHeight` with exponential smoothing (`FOLLOW_SMOOTHING`), so the reading line sits at ~35% of the viewport and the scroll speed is entirely driven by the reader. Cue markers, hover-pause, manual wheel scrubbing, and the `[PAUSE]`/`[BREATHE]`/`[SLOW]` behaviors are unchanged.

**Degradation.** Any fatal sidecar error or restart exhaustion calls the tracker's `onFallback`: ReadView clears tracking state, starts the legacy VAD engine (§3.2), and the settings window shows the reason (its status line listens to `speech-msg` and initializes from `get_speech_status`). Word tracking can also be disabled outright with the settings toggle. Permissions: `NSMicrophoneUsageDescription` (upstream) plus `NSSpeechRecognitionUsageDescription` (this fork) in `src-tauri/Info.plist`; the sidecar child process inherits the app's TCC attribution.

### 3.2 Frequency-based voice activation (fallback)

The original upstream pipeline. It performs no speech recognition — an energy heuristic answers one boolean per frame: *is the user speaking?* Scrolling is constant-speed while that boolean is true.

#### 3.2.1 Capture

Audio is captured **in the prompter WebView**, not in Rust, via `navigator.mediaDevices.getUserMedia` (`src/lib/mic.js:52`) with `echoCancellation`, `noiseSuppression`, `autoGainControl`, `suppressLocalAudioPlayback` (`mic.js:41-46`) and an optional exact `deviceId` from `config.micDeviceId` (with `OverconstrainedError` fallback, `mic.js:53-58`). OS permission is granted through `NSMicrophoneUsageDescription` (`src-tauri/Info.plist`) and the `com.apple.security.(device.)audio-input` entitlements (`src-tauri/entitlements.plist`); `App.jsx:66-69` pre-probes permission on mount. The settings window opens its own independent stream for the level meter (`SettingsView.jsx:118-139`).

#### 3.2.2 Detection — `createMicEngine` (`src/lib/mic.js:8-110`)

Factory returning `{ start(micDeviceId), stop(), setThreshold(v) }`. Inside `start()`:

- Web Audio graph: `MediaStreamSource → AnalyserNode`, `fftSize = 2048`, `smoothingTimeConstant = 0.3` (`mic.js:64-69`).
- A 16 ms `setInterval` loop (`mic.js:75-93`) computes RMS over the time-domain buffer; gate #1 is `rms > VOLUME_THRESHOLD` (default `0.018`, user-tunable — see §5).
- Gate #2 is `isVoiceFrequency()` (`mic.js:17-38`), the **85–3400 Hz analysis**: from `getFloatFrequencyData` (dB values), it converts bins to linear energy (`10^(dB/20)`) and averages two bands — the voice band `85–3400 Hz` and a high band `4000–8000 Hz` (bin indices derived from `binHz = sampleRate / fftSize`, `mic.js:73`). Speech passes if `voiceAvg / highAvg > 2.5` (keyboard clicks and broadband noise have proportionally more high-band energy).
- **Hysteresis:** a frame counter increments +1 on pass, decrements −2 on fail, clamped to `[0, 8]`; speech is asserted only at `VOICE_FRAMES_REQUIRED = 8` consecutive-ish frames (`mic.js:6`, `mic.js:34-37`), i.e. ~130 ms of sustained voice.
- **Debounce down:** on the first non-speech frame while speaking, a 400 ms timer (`SILENCE_DELAY_MS`, `mic.js:5`) fires `onSilence`; any speech frame cancels it. `onSpeaking` fires on the rising edge.

#### 3.2.3 Where scroll state lives

The VAD engine is started by `ReadView`'s `startVadEngine()` (on mount when word tracking is off/unavailable, or later via fallback); its callbacks set **local** state/refs: `isSpeakingRef` + `useState isSpeaking` + `micStatus`. A mic-device change tears down and recreates the engine; threshold changes are pushed live via `setThreshold`.

Both pipelines share one `requestAnimationFrame` loop in `ReadView` with two branches. The legacy branch:

```
shouldScroll = config.autoScroll ? true : isSpeakingRef.current   // (outer guard: not paused)
scrollPosRef.current += SCROLL_SPEED_BASE(0.1) * SPEEDS[speedIdx] * frameDelta
scriptTextRef.current.style.transform = translateY(-scrollPos)
```

with `paused = isPausedRef || isHoverPausedRef` gating both branches. Scroll position is a ref (`scrollPosRef`), applied as a CSS transform — it never touches React state or the Zustand store (the `recognition` slice is updated from speech-tracking callbacks, not from the RAF loop). As noted in §1.3, the older Zustand playback flags are dead; Zustand's real responsibilities in read mode are `scriptText`/`scriptDoc` (input), `recognition` (output for other views), and `setView` (exit). Cue markers (`[PAUSE]`, `[BREATHE]`, `[SLOW]`) fire when their DOM element enters the top 40 % of the viewport (`checkMarkers`), driving timed pauses or a speed step-down. Manual wheel scrubbing writes the same `scrollPosRef`.

### 3.3 Word-tracking alignment, recognition biasing, and tooling

**Alignment algorithm (`src/lib/matcher.js`).** The original matcher was a
per-word greedy first-match within a 12-word lookahead, committed
immediately from unstable partial hypotheses — one stray common word ("I",
"the") that also began the next sentence teleported the cursor there
permanently. The current matcher is built around five rules:

1. **Normalization** — applied identically to script and transcript at
   tokenization time: numbers and percentages expand to spoken form
   (`23%` → *twenty three percent*; `2027` → *twenty twenty seven* with
   *two thousand twenty seven* as an alternate), all-caps acronyms to
   letter sequences (`UIUC` → *u i u c*), hyphenated compounds split (with
   the joined form as an alternate), possessives accepted with and without
   the *s*. Each script word carries multiple accepted forms
   (`expandWordForms`); transcript words expand to their canonical primary
   sequence, so a formatted token meets its spoken reading in expanded
   space.
2. **Stopword rule** — a stopword (`STOPWORDS`) can only confirm the next
   expected word (advance by 1); it can never justify a jump.
3. **Jump rule** — advancing by more than one word requires a **bigram
   anchor**: two consecutive transcript words matching two consecutive
   script words at the target position, nearest candidate first, at most
   `MAX_JUMP` (6) words ahead. A stronger **trigram** anchor (three
   consecutive matches) justifies a much longer forward **resync** up to
   `MAX_RESYNC` (40) words — this recovers when the recognizer drops a whole
   clause or sentence (a live hiccup or a low-fidelity stretch) without
   letting a coincidental match teleport the cursor. Unmatched words are
   dropped (fillers, misreads).
4. **Stability gating** — two cursors. The **provisional** cursor includes
   the tentative tail of the latest partial and drives the highlight and
   the scroll; the **committed** cursor (which dims spoken text and defines
   `done`) advances only on stable words. A word is stable when it is: part
   of a final result; more than `TAIL_TENTATIVE` (2) words behind the
   growing end of the transcript (the recognizer revises only the last word
   or two — the position rule, and the workhorse, since it needs no
   timestamps); or older than `STABLE_AGE_S` (~600 ms) by segment timestamp
   **when those timestamps span a realistic duration** (they do not in the
   sidecar's file-feed mode). The stable prefix is tracked monotonically per
   session, so one noisy partial cannot drop it; a final is authoritative
   and replaces it outright. Commits replay the stable prefix from the
   session base, so later stable evidence can revise an earlier wrong path.
5. **Bounded backtrack** — a stable bigram anchor up to `MAX_BACKTRACK` (3)
   words behind the committed cursor pulls it back, correcting a wrong
   jump. The bound is a hard invariant: the committed cursor never drops
   more than `MAX_BACKTRACK` below its prior value, so even a truncated
   "final" (the recognizer discards the head of a very long single-session
   transcript) cannot erase committed progress.
6. **Line completion** — a final is delivered at the pause after a line
   (§3.1 endpointing), so if only the line's last few words remain
   uncommitted (`LINE_COMPLETE_SLACK`, 4), the recognizer dropped them at
   the pause — commit them, so the next line's session aligns from the true
   boundary instead of jumping forward to catch up. Two guards keep this
   from ever over-advancing: a final at a mid-line pause is far from the
   line end (many words still to come) and is untouched; and the **last**
   line is never completed (no following session needs pre-empting, and a
   short single-line transcript is left exactly where the recognizer put
   it). This removes the benign cross-sentence catch-ups that recognition
   word-drops at boundaries would otherwise produce.

Fuzzy matching accepts edit distance ≤ 1 for script words of 5+ letters;
shorter words must match exactly. The public interface is unchanged
(`feed`/`reset`/`position`), with `position()` now reporting both
`matchedCount`/`cursorTokenIndex` (committed) and
`provisionalCount`/`provisionalTokenIndex`; `stats()` exposes committed-path
jump/backtrack events for the tooling below.

**Parameters (`MAX_JUMP`, `MAX_RESYNC`, `MAX_BACKTRACK`, `TAIL_TENTATIVE`,
`STABLE_AGE_S`, `LINE_COMPLETE_SLACK`, `STOPWORDS`) were tuned against the
synthesized-voice fixture suite** (below), not one example — the stopword
list was narrowed to core function words (a bigram anchor already guards
against teleporting, so content-ish words like "just"/"no"/"up" stay
matchable) and the resync, final-authority, backtrack-bound, and
line-completion rules were added to fix failures the fixtures exposed
(dropped sentences, truncated finals, benign boundary catch-ups). On the
synthetic teleport fixture the legacy matcher scores 1 cross-sentence jump, a
5-word skip, and 44% alignment on the affected sentence; the current matcher
is clean (0 jumps, 100%). Across all 24 continuous-feed fixtures the current
matcher's **overshoot is 0** (the committed cursor never reaches a position
it must retreat from — the true wrong-teleport signal) and **final cursor
error is 0** on every clean and misread read; the legacy matcher on the same
fixtures makes 34 cross-sentence jumps to the current matcher's 6.

**Display coasting (`src/lib/coasting.js`, on by default).** The recognizer
lags the voice by a partial or two, and on a hard phrase it can go quiet for
a second or more; without help the highlight would freeze there even as the
reader keeps talking. Coasting keeps the *display* cursor moving: when the
frequency-based voice-activity signal says the reader is voicing but no new
partial has arrived for `COAST_GAP_MS` (800 ms), the display word advances at
the reader's recently measured rate (a rolling words-per-second estimate from
committed advances, `createReadingRate`), capped `COAST_CAP_WORDS` (8) past
the committed position, and eases back to the truth on the next real match.
It is **display only** — the committed cursor, and therefore every accuracy
metric, is untouched — so a coasted word is rendered with the accent colour
but without the confirming underline (`tok-coasted`). Because the tracker's
own `speaking` flag drops ~900 ms after the last partial (exactly when
coasting is wanted), coasting needs an independent "still voicing?" signal.
As of v2.1.1 that signal is the sidecar's own `vad` message (§3.1) — emitted
off the same microphone tap that feeds recognition — so while word tracking
is active there is **one** microphone capture, not two. (v2.1.0 ran a second
`getUserMedia` frequency-VAD engine alongside the tracker for this; that
second capture, which competed with the recognition audio engine, is gone.)
The frequency VAD engine (§3.2) is still used, but only as the no-tracking
fallback.
`createReadingRate` and the capped `coastDisplayWords` are pure and
unit-tested (`coasting.test.js`); `scripts/track-replay.mjs` reports the
worst within-session display stall coasting-off vs coasting-on (on the
fixture suite, 4.2 s → 2.1 s). A Settings toggle turns it off.

**Recognition biasing.** Three layers, all optional and silent on failure:

- `contextualStrings` (all supported macOS versions): the frontend passes
  the script's non-stopword vocabulary (`buildContextualStrings`, original
  casing, deduplicated, capped at 100) via `--contextual`; the sidecar sets
  it on every recognition request.
- Customized language model (macOS 14+, below).
- **Tricky words** (Settings → Word Tracking, `tracking_hints`, empty by
  default): one entry per line, either a bare word (prepended to
  `contextualStrings` and added as a high-count LM phrase) or
  `word=phonemes` (X-SAMPA), which additionally registers an
  `SFCustomLanguageModelData.CustomPronunciation` for proper nouns the
  recognizer misreads.

**Recording and replay.** `?trackrecord=1` (dev-only, like the other URL
hooks) records a live session — script text plus the full raw sidecar
message stream — and saves it via the dev-only `save_tracking_fixture`
command as a JSON fixture under `tests/fixtures/tracking/`.
`scripts/track-replay.mjs <fixture[.gz]> [--legacy]` (or `--all` for a table)
replays a fixture through the matcher deterministically and reports
cross-sentence jump count, max forward skip, overshoot, backtracks, final
cursor error, max within-session stall, per-sentence alignment rate, and
**first-word recall** (the fraction of sentences whose first two words are
confirmed by an actual match rather than skipped — the direct signal for the
rotation-time audio-loss bug §3.1 fixes, since dropped audio at a session
boundary loses exactly the resumed sentence's opening words);
`--legacy` runs an inline copy of the pre-2.1 greedy matcher for
before/after comparisons.

**Synthesized-voice fixture suite.** `scripts/make-fixtures.sh` (macOS only,
kept out of CI) synthesizes the fixtures from `say` text-to-speech: for each
source script (`tests/fixtures/tracking/scripts/` — the demo library plus a
~200-word jargon-dense brief with product names, acronyms, and numbers) it
renders the whole script as **one continuous utterance** (a warm-up lead-in,
a short pause between sentences, a trailing pause), converts it to the feed
format, and runs the real speech sidecar **once** in `--audio-file` mode with
the matching `--script`/`--contextual` inputs. The sidecar's own silence
endpointing (§3.1) rotates recognition sessions at the pauses — exactly as it
does live — so session boundaries emerge from the recognizer rather than from
pre-splitting, and each session's final carries real per-word timestamps.
(v2.0.0 generated one sidecar run per breath group, which made session
boundaries coincide with sentence boundaries and inflated the cross-sentence
jump count; those fixtures were regenerated for v2.1.0 and the old ones
deleted.) 30 fixtures cover three en-US voices, two rates (~160/200 wpm), six
misread variants (inserted fillers, a repeated phrase, a skipped word, a
restarted sentence, a 2-second mid-sentence silence, and a long mid-sentence
pause that forces a session rotation mid-sentence), and — new in v2.1.1 — two
alteration families applied to all three scripts, each aimed at one live-chain
fix: **quick-resume** (correct speech, but each sentence resumes only ~630 ms
after the previous ends, just past the endpoint, so the next sentence's
opening words land right at the rotation — the zero-gap replay's target) and
**noisy** (correct speech mixed with low-level pink noise at −30 dBFS, raising
the noise floor above any fixed silence threshold, so sessions rotate only
because the threshold is adaptive).
`src/lib/__tests__/tracking-suite.test.js` replays them all in CI (they are
committed, so no speech dependency there) via the same `replayFixture` the
CLI uses, and asserts: overshoot 0 and no within-session stall beyond 7 s
on every fixture; final cursor error ≤ 3; ≤ 1 cross-sentence jump on every
fixture, and exactly 0 on the natural-rate (160 wpm) clean reads; and a
suite-wide first-word-recall floor of 75 % (§3.1 zero-gap rotation; the
pre-fix fixtures scored 57 %, the fast-rate reads collapsing to one sentence
in seven). A handful
of fast-rate (200 wpm) clean fixtures retain a single benign forward
catch-up where the recognizer dropped several words at a boundary
(overshoot and final error stay 0 — the cursor is correct, not teleported).
The committed `synthetic-teleport.json` fixture reproduces the original
teleport bug and is asserted exactly in `tracking-fixture.test.js`.

**On the stall target.** The 2-second aspiration holds for normal-density
scripts; a long jargon-dense sentence at 160 wpm can run to ~6–7 s because the
recognizer's partials for a hard sub-phrase (percentages, acronyms, product
names) lag within one otherwise-correct session — a recognition property, not
a matcher stall (the cursor is not wrong, it is waiting for a recognizable
word), and display coasting (§3.3) masks it to ~3.6 s on screen. To regenerate after tuning: `scripts/build-sidecar.sh &&
scripts/make-fixtures.sh`, then `node scripts/track-replay.mjs --all` to
review, then re-run the suite.

**Latency instrumentation.** `scripts/track-latency.mjs` measures the
recognition pipeline deterministically: it renders a known sentence with
macOS TTS (`say -o`), then runs the sidecar in `--audio-file` mode, which
streams that file into the recognizer at real-time pace exactly as if it
were live mic input (no speakers/microphone involved, so runs are
reproducible). Words are read from the per-word `words` segments (falling
back to the flat text for old recordings). Exact feed start/end times come
from the sidecar's `feed` events; per-word spoken times are estimated by
linear interpolation across the utterance. `TL_SENTENCE` overrides the
sentence; `TL_BIAS=1` additionally passes it as `--script` for A/B
comparisons of the customized language model.

**Baseline (2026-08-19, MacBook Pro M4, macOS 15.6, en-US on-device model,
19-word common-vocabulary sentence at 170 wpm):**

| metric | p50 | p90 | mean |
|---|---|---|---|
| partial cadence (inter-partial gap) | 249 ms | 303 ms | 238 ms |
| spoken word → partial containing it | 400 ms | 619 ms | 413 ms |

Re-validated 2026-09-03 against the per-word protocol (cadence p50 245 ms,
word→partial p50 418 ms — within run-to-run noise of the baseline).

The cadence is recognizer-bound (Apple emits partials roughly every 250 ms);
our transport adds ~1 ms (unbuffered NDJSON → Tauri event) and the matcher
runs in microseconds on every partial, so end-to-end spoken-word → highlight
is recognition latency + at most one animation frame. What users perceived as
lag was mostly on the display side and is tuned in this fork: scroll-easing
time constant cut from ~280 ms to ~100 ms (`FOLLOW_SMOOTHING` 0.06 → 0.16)
and the spoken-token fade from 300 ms to 150 ms — the highlight marks the
next *expected* word, so with a fast-settling scroll it reads as slightly
ahead of the voice rather than trailing it.

**Customized language model (macOS 14+).** At session start the sidecar
builds an `SFCustomLanguageModelData` from the current script: one
`PhraseCount` per line (≤500 lines, count 10), sliding 3–5-word n-gram
phrases at count 3 (≤3000, teaching local word order, not just
vocabulary), high-count phrases for the tricky words, and
`CustomPronunciation`s for `word=phonemes` entries. It exports the asset to
`~/Library/Caches/ai-teleprompter-lm/<sha256(script|locale|tricky|v2)>.bin`
and prepares it via `SFSpeechLanguageModel.prepareCustomLanguageModel`. The
hash covers everything that shapes the model — edits, tricky-word changes,
and scheme bumps force a rebuild. Preparation is asynchronous: early
sessions run the stock model, and the pipeline rotates to the biased one
when ready (`lm {state:"active"}`; typically ≈1 s when cached). Any failure
— macOS 13, unsupported locale, training error — emits
`lm {state:"unavailable"}` and recognition continues on the stock model,
silently. Measured effect of the v1 (per-line phrases only) model on a
jargon-heavy sentence ("Tauri… NDJSON… WKWebView… Anthropic… Yuqing…",
`TL_BIAS=1` vs without): words recognized 10/18 → **13/18**, and
spoken-word→partial p90 1428 ms → **792 ms** (the biased model commits to
hard words much sooner). Common-vocabulary sentences are unaffected.

**Debug overlay.** `?trackdebug=1` (dev-only, via the snapshot harness or
`TELEPROMPTER_DEMO_PARAMS`) renders an overlay in read mode showing the raw
partial tail, session number, LM state, matched/total counts, confidence,
and the age of the last partial — for eyeballing raw recognition against the
matcher's position.

**Locale.** Recognition always runs `en-US` (v2.0.0 narrowed the scope to
English). The sidecar keeps its `--locale` argument and the
`start_speech(locale, …)` command keeps its parameter for future use, but
no UI selects another locale; `ReadView` passes `en-US` unconditionally.
The `set_speech_notice`/`speech-notice` advisory channel remains wired
(Rust command + settings display) but currently has no writer.

---

## 4. Script editor and library

### 4.1 Data model

One `Script` = `{ name, text, content }` (`lib.rs:107-113`): `name` is display title, `text` is the plain-text flattening, `content` is the **Tiptap JSON document serialized as a string**. The frontend mirrors this shape untyped. Three seeded demo scripts are generated in `default_scripts()` (`lib.rs:153-243`) when no scripts file exists.

### 4.2 Persistence

Whole-array read/write through two commands: `get_scripts` → `load_scripts()` and `save_scripts` → `save_scripts_to_disk()` (`lib.rs:335-339`, `245-255`), storing pretty-printed JSON at `~/.teleprompter-scripts.json`. There is no partial update, no IDs (scripts are addressed by array index — see `currentScriptIndex`, `store/index.js:20`), and no debounce; every save rewrites the file.

### 4.3 Tiptap integration (`src/views/EditView.jsx`)

- Editor: `useEditor` with `StarterKit`, `TextStyle`, `Color` extensions (`EditView.jsx:36-45`); toolbar offers bold, five fixed colors, and cue-marker insertion (`MARKERS = ['[PAUSE]','[SLOW]','[BREATHE]']`, `EditView.jsx:16`; markers are inserted as plain text tokens, `insertMarker`, `EditView.jsx:121-123`).
- Save: `saveCurrentScript` (`EditView.jsx:60-75`) derives `name` from the first line (≤ 40 chars), `text` from `editor.getText()`, `content` from `JSON.stringify(editor.getJSON())`, updates the array in Zustand, and calls `API.saveScripts` (write-through).
- Load: `loadScript(i)` / mount effect parse `script.content` back into the editor, falling back to wrapping `script.text` in a paragraph on parse failure (`EditView.jsx:48-58`, `99-111`).
- Handoff to the prompter: `handleStart` (`EditView.jsx:77-85`) saves, then `setScriptText(text)` + `setScriptDoc(editor.getJSON())` + `setView('read')`.
- Rendering for reading: `tokenizeDoc` (`src/lib/tokenizer.js`) walks the Tiptap JSON and flattens it to tokens `{ type: 'word'|'marker'|'newline', text, bold, color, marker }`, split on whitespace. `ReadView` renders one `<span>` per token (with speech-tracking classes, §3.1). Word-count stats assume `\s+`-separated words at 130 WPM (`EditView.jsx:18-24`).

---

### 4.4 Prepare with AI (this fork)

An optional, explicitly user-triggered preprocessing step that rewrites a raw script into teleprompter form (short lines, spoken phrasing, cue markers). Fully inert when unconfigured — the app behaves exactly as upstream.

**Providers.** Four, all funnelled through one abstraction in `src/lib/ai.js` (`PROVIDERS`, each exposing `detect()` / `listModels()` / `supportsEffort(model)` / `prepare(system, prompt, {model, effort})`), with a unified effort scale `low | medium | high | xhigh`:

| provider id | route | model | effort |
|---|---|---|---|
| `claude-code` | user's Claude subscription via the official Claude Code CLI (§4.4a) | `--model` (aliases opus/sonnet/haiku/fable, or empty = CLI default) | `--effort low\|medium\|high\|xhigh` |
| `codex` | user's ChatGPT subscription via the official OpenAI Codex CLI (§4.4a) | `-m/--model` (empty = CLI default) | `-c model_reasoning_effort="…"` |
| `anthropic-api` | `POST /v1/messages` with the user's API key | `claude-opus-5` (default) / sonnet / haiku or free text | `output_config.effort` (omitted for models that reject it, e.g. Haiku 4.5) |
| `ollama` | `POST {ai_local_url}/v1/chat/completions` (OpenAI-compatible, offline) | free text, required | unsupported — greyed out in the UI |

Model and effort are persisted **per provider** in `config.ai_prefs`; the legacy single `ai_model` field remains as a fallback. Legacy provider ids migrate on config load (`anthropic` → `anthropic-api`, `local` → `ollama`).

**Split of responsibilities.** Everything testable lives in JS; secrets, credentials, and process supervision live in Rust:

- `src/lib/ai.js` — the provider table, prompt construction (`buildPrepareMessages`), response parsing (`parsePreparedResponse`), Tiptap conversion (`preparedTextToDoc`), and error mapping (`mapAiError`). Unit tests: `ai.test.js`, `providers.test.js`.
- `ai_complete(system, prompt, model, effort)` in `src-tauri/src/lib.rs` — the API/local transport; the Anthropic branch opts into server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) and sets `output_config.effort` when given.
- `detect_ai_provider` / `ai_cli_prepare` / `cancel_ai_cli` — the subscription-CLI leg (§4.4a).
- Errors return as `code:detail` strings (`no_provider`, `no_api_key`, `no_model`, `auth`, `rate_limit`, `model_not_found`, `network`, `refusal`, `server`, `parse`, plus the CLI codes `cli_not_installed`, `cli_not_logged_in`, `cli_rate_limit`, `cli_failed`, `timeout`, `canceled`).

**Key storage.** The Anthropic API key is stored in the macOS Keychain via the `keyring` crate (service `AI Teleprompter`, account `anthropic-api-key`). `set_ai_key` writes/deletes, `has_ai_key` reports existence; the key itself is read only inside `ai_complete` at request time and **never crosses IPC to the WebView** and never touches the JSON config files.

**UI flow.** `EditView.jsx` `handlePrepare`: no working provider → the guided four-card setup (subscriptions first); otherwise `prepareScript(text, {provider, model, effort})` behind a progress state that names the provider/model/effort and offers Cancel (`cancel_ai_cli`). On success the view switches to a side-by-side review — original (read-only) vs prepared (editable textarea) — with Accept/Reject. `acceptReview` first appends the pre-preparation script to the library (`"<name> · original"`, persisted via `save_scripts`) so the original stays recoverable, then replaces the editor content with `preparedTextToDoc(...)`. Reject leaves the editor untouched. Nothing ever runs automatically.

### 4.4a Subscription providers — official CLIs only (design constraint)

Subscription access is implemented **only** by delegating to the official CLIs the user has already installed and logged into: Claude Code (`claude -p`, non-interactive) and the OpenAI Codex CLI (`codex exec`). The app **never reads, copies, proxies, or stores any OAuth token or credential file** from either CLI, and never talks to Anthropic's or OpenAI's subscription endpoints directly. Rationale: both vendors changed their positions on subscription use in third-party tools several times during 2026, and the one consistently sanctioned path is the vendor's own client — Anthropic documents `claude -p` and Agent-SDK apps as covered plan usage, and OpenAI supports "Sign in with ChatGPT" through its official clients. Delegating means the vendor's own binary owns authentication, token refresh, rate limiting, and policy enforcement; if a vendor changes the rules, the CLI is where the change lands, and this app inherits it instead of circumventing it. The Settings notice links both policy pages and says plainly that these providers consume the user's own plan.

**Detection.** Binaries are located on `PATH` plus common install directories (`~/.local/bin`, `~/.claude/local{,/bin}`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`, `~/bin`) — GUI apps launched from Finder get a minimal PATH. Login state uses each CLI's own status mechanism, neither of which consumes plan usage: `claude auth status` (JSON with `loggedIn`) and `codex login status` (exit code + "Logged in" message). Result states: `available` / `not_installed` / `not_logged_in`, each with one-line install/login instructions in the UI.

**Invocation.** Spawned from Rust (`std::process`) with the prompt on stdin, in a **fresh empty temp directory**, as its own process group, with a 120 s default timeout and cancellation; on cancel/timeout/quit the whole process group is killed and reaped (`kill_child_tree`) so no CLI child ever lingers. The CLIs are never exposed to the WebView through the shell plugin — no shell-scope capability entries exist for them, which is strictly tighter than scoping plugin execution. Flags, **verified empirically against `claude` 2.1.259 and `codex-cli` 0.153.0** (re-verify on major CLI updates):

- `claude -p --output-format json --safe-mode --tools "" --no-session-persistence --system-prompt <s> [--model m] [--effort e]` — `--tools ""` removes every built-in tool, `--safe-mode` disables hooks/plugins/MCP/CLAUDE.md, output is a single JSON object (`{is_error, subtype, result}`).
- `codex exec --sandbox read-only --skip-git-repo-check --ephemeral --color never -C <tmp> --output-last-message <file> [-m m] [-c model_reasoning_effort="e"]` — read-only sandbox, no session files, final message read from the output file (system prompt rides at the top of the stdin prompt; `exec` has no separate system channel).

**Failure handling.** Non-zero exits map the CLI's own stderr/JSON message to `cli_rate_limit` (usage caps surface verbatim), `cli_not_logged_in`, or `cli_failed`; hung CLIs hit `timeout`; a CLI uninstalled mid-session resurfaces as `cli_not_installed` (re-resolved per call) and reopens the guided setup. Tested against committed fake `claude`/`codex` executables (`tests/fixtures/cli/`) covering detection, argument construction, output parsing, rate-limit/timeout/malformed-output mapping, and cancellation; two `#[ignore]`d tests (`cargo test real_cli -- --ignored`) run the real CLIs end to end.

---

## 5. Settings system and global shortcuts

### 5.1 Config flow

`SettingsView` (own window, §1.1) reads config on mount and writes individual patches through `set_config` (`lib.rs:287-306`), which merges the patch into `AppState`, persists to disk, re-applies content protection, and broadcasts `config-update` — closing the loop to the prompter window (`App.jsx:52-64`) and back to any other settings instance. Notable mappings:

- The UI "Voice Input" toggle is the **inverse** of `autoScroll` (`SettingsView.jsx:88`, `164-167`): voice input ON ⇒ `autoScroll: false` (scroll only while speaking); OFF ⇒ `autoScroll: true` (scroll continuously).
- Voice sensitivity: a log-scale slider mapping `0.003–0.562` RMS (`sliderToThreshold`, `SettingsView.jsx:19-22`), displayed in dB, with a live RMS meter from its own mic stream (`startMeter`, `SettingsView.jsx:118-139`).
- Mode switching calls the dedicated `switch_mode` command (not `set_config`) because the prompter window must be destroyed and recreated (`SettingsView.jsx:154-157`, `lib.rs:309-333`).
- Mic enumeration via `enumerateDevices` after a temporary permission-priming stream (`SettingsView.jsx:105-116`).
- Word tracking (this fork): a "Word Tracking" toggle (`wordTracking`), a "Tricky words" textarea (`trackingHints` — one word per line, optionally `word=phonemes` in X-SAMPA; empty by default, applied at the next reading session, §3.3), plus a live status line driven by `get_speech_status` + `speech-msg` events and an on-device privacy note. Recognition always runs `en-US` (§3.3 Locale); there is no language selector.
- Prepare with AI (this fork): a provider list (Off + the four providers of §4.4) with live detection badges (`detect_ai_provider` on mount + a re-check button), a unified per-provider Model selector (curated list + free-text override) and four-tier Effort selector (disabled with an explanation where unsupported), Keychain key management through `set_ai_key`/`has_ai_key` for the API provider, the local-URL field for Ollama, and the §4.4a notices: scripts are sent only on ✦ Prepare, subscription providers consume the user's own plan, and the linked vendor policies changed several times in 2026.

### 5.2 Global shortcuts

Registered in `setup()` using `tauri-plugin-global-shortcut` (`lib.rs:809-843`). On macOS both `⌘⇧` (SUPER) and `⌃⇧` (CONTROL) variants are registered for `Space`, `ArrowUp`, `ArrowDown`, `KeyR`, and (this fork) `KeyE` — the `"edit"` action, which shows the prompter window and is handled app-level in `App.jsx` to open the editor from the idle pill; Windows builds register only `Ctrl+Shift` variants. Registration failures are silently skipped (`let _ =`, `lib.rs:832`) so OS-taken combos don't crash startup. The handler maps key → action string and `emit_to("prompter", "shortcut", action)` (`lib.rs:834-841`); `ReadView.jsx:152-161` translates actions into the same local state used by the on-screen controls (`pause`→`togglePause`, `faster`/`slower`→speed index, `reset`→scroll to top, `stop`→`handleDone`). Shortcuts therefore only have an effect while `ReadView` is mounted, except `stop`, which is also emitted by the backend before hiding/recreating the window.

---

## 6. Frontend dependency map

```
index.html ─→ src/main.jsx ─→ src/App.jsx
                               │  bootstraps config+scripts (lib/api.js → Tauri invoke)
                               │  owns: view routing, hover, window resize, theme/opacity
                               │
              ┌────────────────┼──────────────────┐
              ▼                ▼                  ▼
      views/IdleView.jsx  views/EditView.jsx  views/ReadView.jsx
        store: view,        store: scripts,     store: scriptText/Doc, config,
        isSpeaking*,        currentScriptIndex, setView, setRecognition
        isPaused*, config   scriptText/Doc,     lib/tokenizer.js (doc→tokens)
        (*never updated)    config              lib/speech.js (word tracker)
              │                │                  └─ lib/matcher.js (cursor)
              │                │                lib/mic.js (VAD fallback)
              │                │                lib/api.js (shortcuts, resize,
              │                │                            start/stop_speech)
              │                ├─ @tiptap/react + starter-kit
              │                │  + extension-text-style + extension-color
              └────────┬───────┴──────────┬─────┘
                       ▼                  ▼
              src/store/index.js   src/lib/api.js ──→ window.__TAURI__ ──→ src-tauri/src/lib.rs
              (Zustand useAppStore)                    (invoke/listen)          │
                                                                                ▼ (spawn, stdout)
                                                             speech-sidecar (Swift, SFSpeechRecognizer)

settings.html ─→ src/settings-main.jsx ─→ src/views/SettingsView.jsx
                 (separate window & bundle; inline API copy at SettingsView.jsx top;
                  no Zustand — local useState only; syncs via config-update and
                  speech-msg events)
```

Shared modules: `store/index.js` (all three prompter views + App), `lib/api.js` (App, EditView, ReadView, lib/speech.js — **not** SettingsView), `lib/mic.js`, `lib/speech.js`, `lib/matcher.js`, and `lib/tokenizer.js` (ReadView only; matcher/tokenizer also unit-tested in `src/lib/__tests__/`). Styling: `src/style.css` (prompter), `src/settings.css` (settings).

---

## 7. Extension points

### 7a. Speech-recognition-driven word tracker — **implemented**

This fork implemented the word tracker along the three seams identified here; the full pipeline is documented in §3.1. Where the pieces landed:

1. **Engine seam** → `src/lib/speech.js` (`createSpeechTracker`), a sibling of `createMicEngine` that streams sidecar transcripts into the matcher and owns restart/fallback policy. The RMS/band VAD (`src/lib/mic.js`) was kept intact as the fallback engine.
2. **Scroll-application seam** → the RAF loop in `ReadView.jsx` gained a tracking branch: per-word refs (`wordRefs`) give token→DOM geometry, and the scroll offset eases toward the current word's `offsetTop` at the 35% reading line.
3. **Token seam** → `tokenizeDoc` flattens the Tiptap doc to whitespace-delimited word tokens; `src/lib/matcher.js` handles normalization and transcript alignment.

Remaining extension surface here: swapping the recognizer (e.g. a Whisper sidecar for more locales) only requires emitting the same NDJSON protocol from a different binary; nothing above the sidecar changes.

### 7b. Script preprocessing before a script is loaded into the prompter — **implemented**

This fork implemented AI script preparation at the editor level ("Prepare with AI", §4.4): the transform runs on the editor's current text on explicit user action, with a review step, rather than silently inside `handleStart`. The analysis below remains valid for further preprocessing hooks (e.g. automatic per-`Go` transforms or token-level annotation).

There is a single choke point where an edited script becomes the active prompter content: **`handleStart` in `src/views/EditView.jsx:77-85`**. It computes `text` and `editor.getJSON()`, then calls `setScriptText` / `setScriptDoc` (`store/index.js:24-27`) and `setView('read')`. An AI preprocessing step (cleanup, sentence segmentation, automatic `[PAUSE]`/`[BREATHE]` insertion, pinyin/translation annotation) slots in as an async transform of the Tiptap JSON between `editor.getJSON()` and `setScriptDoc`, ideally with a loading state on the "Go →" button. Because `ReadView` consumes only `scriptDoc`/`scriptText` from the store (`ReadView.jsx:8-9`), no other component needs to change.

Secondary hook options, depending on where the transform should live:

- **Token level (display-only transforms):** wrap `tokenizeDoc(scriptDoc)` at `ReadView.jsx:9` — appropriate for segmentation/annotation that shouldn't alter the saved document.
- **Persistence level (transform once, store the result):** the save path `saveCurrentScript` (`EditView.jsx:60-75`) → `API.saveScripts` → `save_scripts` command (`lib.rs:339`); preprocess before `JSON.stringify(editor.getJSON())` so the library stores the processed doc. Editor load paths that would then receive processed content: the mount effect (`EditView.jsx:48-58`) and `loadScript` (`EditView.jsx:99-111`).
- **Backend level (if preprocessing calls an LLM or heavy native code):** add a new `#[tauri::command] async fn preprocess_script(doc: String) -> Result<String, String>` in `src-tauri/src/lib.rs`, register it in the `invoke_handler` list (`lib.rs:660-670`), expose it in `src/lib/api.js`, and await it inside `handleStart`. The `Script.content`-as-JSON-string convention (`lib.rs:112`) means the command can operate on the serialized doc directly.

The cue-marker system is the natural output format for AI-inserted delivery hints: markers are plain-text tokens recognized by `MARKER_RE` (`tokenizer.js:4`) and acted on in `checkMarkers` (`ReadView.jsx:87-113`), so a preprocessor only needs to inject ` [PAUSE] ` text nodes — no renderer changes. Adding new marker types requires touching only `MARKER_RE`, the `checkMarkers` dispatch, and (optionally) the editor toolbar list (`EditView.jsx:16`).
