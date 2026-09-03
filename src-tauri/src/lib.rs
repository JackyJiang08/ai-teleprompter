

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

// ── macOS: elevate window above menu bar/notch AND position it at screen top ─
// Strategy: window height = notch_content_h + overlap_h (e.g. 160+40=200px)
// Position window so its TOP is flush with screen top (above menu bar).
// The 40px overlap at the bottom keeps WKWebView rendering (it stops
// rendering when 100% above visible area).
// CSS island sits at top:0 = physically in the notch.
#[cfg(target_os = "macos")]
fn elevate_to_notch_level(window: &WebviewWindow) {
    use objc2_foundation::{NSRect, NSPoint, NSSize};
    let ns_win_ptr = match window.ns_window() {
        Ok(p) => p,
        Err(e) => { eprintln!("[notch] ns_window error: {e}"); return; }
    };
    unsafe {
        let mtm = objc2::MainThreadMarker::new_unchecked();
        let ns_win = ns_win_ptr as *mut objc2_app_kit::NSWindow;

        // Level 27 = NSMainMenuWindowLevel(24) + 3 — floats above menu bar (same as Atoll)
        (*ns_win).setLevel(27);
        // All spaces, stationary, ignored in cmd+tab, fullscreen safe
        (*ns_win).setCollectionBehavior(
            objc2_app_kit::NSWindowCollectionBehavior((1<<0)|(1<<4)|(1<<6)|(1<<8))
        );
        (*ns_win).setHasShadow(false);

        // Reposition: flush to screen top so CSS island appears in physical notch.
        // Use full screen width, height=200 (notch content area).
        // y = screenFrame.maxY - windowHeight positions top of window at screen top.
        // WKWebView renders because level=27 makes the window "visible" to compositor
        // even when fully above the menu bar.
        //
        // Display selection: prefer the screen with a physical notch
        // (safeAreaInsets.top > 0, macOS 12+ API — minimum system is 13).
        // Upstream used mainScreen (the screen with keyboard focus), which
        // parks the pill on an external monitor whenever focus is there.
        // Fallback when no notch display exists (external-only / clamshell):
        // mainScreen, so the pill sits on the display the user is working on.
        let screens = objc2_app_kit::NSScreen::screens(mtm);
        let notch_screen = screens.iter().find(|s| s.safeAreaInsets().top > 0.0);
        if let Some(screen) = notch_screen.or_else(|| objc2_app_kit::NSScreen::mainScreen(mtm)) {
            let sf = screen.frame(); // NSScreen uses bottom-left origin
            let win_h = (*ns_win).frame().size.height;
            let new_y = sf.origin.y + sf.size.height - win_h;
            let new_frame = NSRect {
                origin: NSPoint { x: sf.origin.x, y: new_y },
                size: NSSize { width: sf.size.width, height: win_h },
            };
            (*ns_win).setFrame_display(new_frame, true);
            eprintln!("[notch] elevated+positioned: level=27 y={new_y} (screen top at {})",
                sf.origin.y + sf.size.height);
        } else {
            eprintln!("[notch] elevated: level=27 (no screen for reposition)");
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn elevate_to_notch_level(_window: &WebviewWindow) {}

// ── Notch metrics (macOS) ──────────────────────────────────
// Derives the physical notch geometry at runtime from NSScreen instead of
// hardcoding per-model values: height = safeAreaInsets.top, width/x = the gap
// between auxiliaryTopLeftArea and auxiliaryTopRightArea (both are ObjC
// selectors returning a zero rect on non-notch screens — Swift maps that to
// nil). Values are logical points, so they follow the user's chosen display
// scaling automatically. centerX is in global top-left window coordinates.
//
// Dev-only test hook: TELEPROMPTER_FAKE_NOTCH="<width>x<height>@<centerX>"
// simulates a notch so the sizing pipeline can be exercised (and captured)
// on machines without a notch display. Never set in normal operation.
fn fake_notch_metrics() -> Option<serde_json::Value> {
    let v = std::env::var("TELEPROMPTER_FAKE_NOTCH").ok()?;
    let (dims, center) = v.split_once('@')?;
    let (w, h) = dims.split_once('x')?;
    Some(serde_json::json!({
        "hasNotch": true,
        "width": w.trim().parse::<f64>().ok()?,
        "height": h.trim().parse::<f64>().ok()?,
        "centerX": center.trim().parse::<f64>().ok()?,
    }))
}

#[cfg(target_os = "macos")]
fn notch_metrics() -> Option<serde_json::Value> {
    if let Some(fake) = fake_notch_metrics() { return Some(fake); }
    use objc2_foundation::NSRect;
    unsafe {
        let mtm = objc2::MainThreadMarker::new_unchecked();
        let screens = objc2_app_kit::NSScreen::screens(mtm);
        for s in screens.iter() {
            let inset_top = s.safeAreaInsets().top;
            if inset_top <= 0.0 { continue; }
            let sf = s.frame();
            let aux_l: NSRect = objc2::msg_send![&*s, auxiliaryTopLeftArea];
            let aux_r: NSRect = objc2::msg_send![&*s, auxiliaryTopRightArea];
            if aux_l.size.width <= 0.0 || aux_r.size.width <= 0.0 { continue; }
            // Notch span = gap between the two auxiliary areas, relative to
            // this screen's left edge (aux rects are in global coordinates).
            let left_rel  = (aux_l.origin.x + aux_l.size.width) - sf.origin.x;
            let right_rel = aux_r.origin.x - sf.origin.x;
            let width = right_rel - left_rel;
            if width <= 0.0 { continue; }
            return Some(serde_json::json!({
                "hasNotch": true,
                "width": width,
                "height": inset_top,
                "centerX": sf.origin.x + left_rel + width / 2.0,
            }));
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn notch_metrics() -> Option<serde_json::Value> {
    fake_notch_metrics()
}




use std::sync::{Mutex, atomic::{AtomicBool, Ordering}};

// Set to true once the tray icon has been clicked — positioner needs this before TrayCenter works
static TRAY_CLICKED: AtomicBool = AtomicBool::new(false);
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, State, WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_positioner::{Position, WindowExt};

// ── Config ─────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub scroll_speed: f64,
    pub threshold: f64,
    pub screenshare_hidden: bool,
    pub mode: String,
    pub opacity: f64,
    pub auto_scroll: bool,
    pub mic_device_id: String,
    pub theme: String,
    #[serde(default = "default_word_tracking")]
    pub word_tracking: bool,
    // Newline-separated user-supplied "tricky words" for recognition biasing:
    // "word" or "word=X-SAMPA phonemes". Empty by default.
    #[serde(default)]
    pub tracking_hints: String,
    #[serde(default)]
    pub ai_provider: String, // "" (off) | "claude-code" | "codex" | "anthropic-api" | "ollama"
    #[serde(default)]
    pub ai_model: String, // legacy pre-2.1 single model field (ai_prefs supersedes it)
    #[serde(default = "default_ai_local_url")]
    pub ai_local_url: String,
    // Per-provider model/effort choices: { "<provider>": {"model": "...", "effort": "..."} }
    #[serde(default)]
    pub ai_prefs: serde_json::Value,
}

fn default_word_tracking() -> bool { true }
fn default_ai_local_url() -> String { "http://localhost:11434".to_string() }

impl Default for Config {
    fn default() -> Self {
        // macOS: notch mode, Windows: classic mode
        #[cfg(target_os = "windows")]
        let default_mode = "classic".to_string();
        #[cfg(not(target_os = "windows"))]
        let default_mode = "notch".to_string();

        Self {
            scroll_speed: 1.0,
            threshold: 0.018,
            screenshare_hidden: true,  // hide on screenshare: ON by default (both platforms)
            mode: default_mode,
            opacity: 1.0,
            auto_scroll: true,         // voice input: ON by default (both platforms)
            mic_device_id: "default".to_string(),
            theme: "dark".to_string(),
            word_tracking: default_word_tracking(),
            tracking_hints: String::new(),
            ai_provider: String::new(),
            ai_model: String::new(),
            ai_local_url: default_ai_local_url(),
            ai_prefs: serde_json::json!({}),
        }
    }
}

// ── Script ─────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Script {
    pub name: String,
    pub text: String,
    #[serde(default)]
    pub content: String, // Tiptap JSON string
}

// ── App state ──────────────────────────────────────────────
pub struct AppState {
    config:        Mutex<Config>,
    classic_pos:   Mutex<Option<(f64, f64)>>,
    speech_child:  Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
    speech_status: Mutex<serde_json::Value>,
    speech_notice: Mutex<String>,
    // The currently running provider CLI (claude/codex) for Prepare with AI,
    // so it can be cancelled and never outlives the app.
    cli_child:     std::sync::Arc<Mutex<Option<std::process::Child>>>,
}

// ── File paths ─────────────────────────────────────────────
fn config_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".teleprompter-config.json")
}

fn scripts_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".teleprompter-scripts.json")
}
fn load_config() -> Config {
    let mut cfg: Config = fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // Pre-2.1 provider names: "anthropic" and "local" became "anthropic-api"
    // and "ollama" when the subscription providers were added.
    match cfg.ai_provider.as_str() {
        "anthropic" => cfg.ai_provider = "anthropic-api".to_string(),
        "local" => cfg.ai_provider = "ollama".to_string(),
        _ => {}
    }
    cfg
}
fn save_config(cfg: &Config) {
    if let Ok(json) = serde_json::to_string_pretty(cfg) {
        let _ = fs::write(config_path(), json);
    }
}

// ── First-launch migration from the previous app identity ──
// The 2.0 rename changed the bundle identifier from
// com.jackyjiang.bilingual-teleprompter to com.jackyjiang.ai-teleprompter, so
// macOS treats this as a brand-new app. The script library and settings live
// in identifier-independent dotfiles (~/.teleprompter-*.json) and carry over
// on their own; anything under the old identifier's Application Support
// directory is copied — never moved or deleted — into the new one, exactly
// once (guarded by a marker file in the new directory). Keychain items and
// TCC permissions (microphone, speech recognition) cannot cross an identity
// change, so when a previous install is detected a one-time notice tells the
// user to re-enter the API key and re-grant the permissions.

const OLD_BUNDLE_ID: &str = "com.jackyjiang.bilingual-teleprompter";
const NEW_BUNDLE_ID: &str = "com.jackyjiang.ai-teleprompter";
const OLD_LM_CACHE_DIR: &str = "bilingual-teleprompter-lm";
const MIGRATION_MARKER: &str = "migrated-from-previous-identity.json";

#[derive(Debug, Default, PartialEq)]
pub struct MigrationOutcome {
    pub performed: bool,      // this call did the (one-time) migration work
    pub notice_pending: bool, // a previous install was found — show the notice
    pub files_copied: u64,
}

// Recursively copy src into dst without ever overwriting an existing
// destination file and without touching the source. Returns files copied.
fn copy_tree_no_overwrite(src: &PathBuf, dst: &PathBuf) -> std::io::Result<u64> {
    let mut copied = 0;
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copied += copy_tree_no_overwrite(&from, &to)?;
        } else if ty.is_file() && !to.exists() {
            fs::copy(&from, &to)?;
            copied += 1;
        }
    }
    Ok(copied)
}

fn run_identity_migration(
    old_dir: &PathBuf,
    new_dir: &PathBuf,
    extra_footprints: &[PathBuf],
) -> MigrationOutcome {
    let marker = new_dir.join(MIGRATION_MARKER);
    if marker.exists() {
        return MigrationOutcome::default();
    }

    let files_copied = if old_dir.is_dir() {
        copy_tree_no_overwrite(old_dir, new_dir).unwrap_or_else(|e| {
            eprintln!("[migrate] copy failed: {e}");
            0
        })
    } else {
        0
    };

    let previous_install = old_dir.is_dir() || extra_footprints.iter().any(|p| p.exists());

    // Write the marker before the notice is shown, so a launch killed
    // mid-notice never repeats the migration or the notice.
    if fs::create_dir_all(new_dir).is_ok() {
        let record = serde_json::json!({
            "migratedFrom": OLD_BUNDLE_ID,
            "filesCopied": files_copied,
            "previousInstallDetected": previous_install,
        });
        let _ = fs::write(&marker, serde_json::to_string_pretty(&record).unwrap_or_default());
    }

    MigrationOutcome { performed: true, notice_pending: previous_install, files_copied }
}

// Runs the migration against the real user directories. Returns whether the
// one-time notice should be shown this launch.
fn migrate_previous_identity() -> bool {
    let Some(home) = dirs::home_dir() else { return false };
    let app_support = home.join("Library/Application Support");
    let caches = home.join("Library/Caches");
    let outcome = run_identity_migration(
        &app_support.join(OLD_BUNDLE_ID),
        &app_support.join(NEW_BUNDLE_ID),
        &[
            caches.join(OLD_BUNDLE_ID),
            caches.join(OLD_LM_CACHE_DIR),
            home.join("Library/WebKit").join(OLD_BUNDLE_ID),
        ],
    );
    if outcome.performed {
        eprintln!(
            "[migrate] first launch under {NEW_BUNDLE_ID}: {} file(s) copied, previous install: {}",
            outcome.files_copied, outcome.notice_pending
        );
    }
    outcome.notice_pending
}

// One-time native notice after a detected identity migration.
#[cfg(target_os = "macos")]
fn show_migration_notice() {
    unsafe {
        let mtm = objc2::MainThreadMarker::new_unchecked();
        let alert = objc2_app_kit::NSAlert::new(mtm);
        alert.setMessageText(&objc2_foundation::NSString::from_str(
            "Welcome to AI Teleprompter 2.0",
        ));
        alert.setInformativeText(&objc2_foundation::NSString::from_str(
            "This app replaces the previous \"Bilingual AI Teleprompter\" install. \
             Your script library and settings have carried over automatically.\n\n\
             Two things macOS cannot carry across the rename:\n\n\
             \u{2022} The AI provider API key — re-enter it in Settings → Prepare \
             with AI (it is stored only in the macOS Keychain).\n\n\
             \u{2022} Microphone and Speech Recognition permissions — macOS will \
             ask for them again the first time you start reading.",
        ));
        eprintln!("[migrate] showing one-time migration notice");
        alert.runModal();
        eprintln!("[migrate] migration notice dismissed");
    }
}

#[cfg(not(target_os = "macos"))]
fn show_migration_notice() {}

fn default_scripts() -> Vec<Script> {
    let about_me_content = serde_json::json!({
        "type": "doc",
        "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "text": "Hi, I'm " },
                { "type": "text", "marks": [{"type": "bold"}], "text": "Arun" },
                { "type": "text", "text": " — a full-stack engineer with " },
                { "type": "text", "marks": [{"type": "textStyle", "attrs": {"color": "#4ade80"}}], "text": "five years of experience" },
                { "type": "text", "text": " building products that scale." }
            ]},
            { "type": "paragraph", "content": [
                { "type": "text", "text": "I've worked on systems serving " },
                { "type": "text", "marks": [{"type": "textStyle", "attrs": {"color": "#60a5fa"}}], "text": "over thirty million customers" },
                { "type": "text", "text": ", and I love building things that actually " },
                { "type": "text", "marks": [{"type": "bold"}], "text": "matter to people" },
                { "type": "text", "text": "." }
            ]},
            { "type": "paragraph", "content": [
                { "type": "text", "text": "My stack spans " },
                { "type": "text", "marks": [{"type": "textStyle", "attrs": {"color": "#4ade80"}}], "text": "React, Node.js, TypeScript" },
                { "type": "text", "text": ", and cloud infrastructure on " },
                { "type": "text", "marks": [{"type": "bold"}], "text": "GCP" },
                { "type": "text", "text": ". I'm comfortable across the entire stack — from pixel-perfect frontends to distributed backend systems." }
            ]},
            { "type": "paragraph", "content": [
                { "type": "text", "text": "I thrive in environments where " },
                { "type": "text", "marks": [{"type": "textStyle", "attrs": {"color": "#facc15"}}], "text": "ownership and impact" },
                { "type": "text", "text": " go hand in hand. I've led cross-functional features, mentored engineers, and shipped products used by real people every day." }
            ]},
            { "type": "paragraph", "content": [
                { "type": "text", "text": "Outside of work, I'm into " },
                { "type": "text", "marks": [{"type": "bold"}], "text": "game development" },
                { "type": "text", "text": ", guitar, and building side projects that push what's possible on the web." }
            ]}
        ]
    }).to_string();

    let meeting_content = serde_json::json!({
        "type": "doc",
        "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "text": "Quick recap from " },
                { "type": "text", "marks": [{"type": "bold"}], "text": "yesterday's sync" },
                { "type": "text", "text": "." }
            ]},
            { "type": "paragraph", "content": [
                { "type": "text", "text": "We aligned on the " },
                { "type": "text", "marks": [{"type": "textStyle", "attrs": {"color": "#facc15"}}], "text": "Q2 roadmap priorities" },
                { "type": "text", "text": " — performance improvements take the lead." }
            ]},
            { "type": "paragraph", "content": [
                { "type": "text", "marks": [{"type": "bold"}], "text": "Action items:" },
                { "type": "text", "text": " design review by " },
                { "type": "text", "marks": [{"type": "textStyle", "attrs": {"color": "#f87171"}}], "text": "Friday" },
                { "type": "text", "text": ", API spec finalized by " },
                { "type": "text", "marks": [{"type": "textStyle", "attrs": {"color": "#f87171"}}], "text": "end of next week" },
                { "type": "text", "text": "." }
            ]}
        ]
    }).to_string();

    let demo_content = serde_json::json!({
        "type": "doc",
        "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "text": "Let me walk you through what we've built." }
            ]},
            { "type": "paragraph", "content": [
                { "type": "text", "marks": [{"type": "bold"}], "text": "AI Teleprompter" },
                { "type": "text", "text": " is a " },
                { "type": "text", "marks": [{"type": "textStyle", "attrs": {"color": "#4ade80"}}], "text": "voice-activated teleprompter" },
                { "type": "text", "text": " that lives right in your Mac's notch." }
            ]},
            { "type": "paragraph", "content": [
                { "type": "text", "marks": [{"type": "textStyle", "attrs": {"color": "#60a5fa"}}], "text": "Speak" },
                { "type": "text", "text": " — it scrolls. " },
                { "type": "text", "marks": [{"type": "textStyle", "attrs": {"color": "#f87171"}}], "text": "Stop" },
                { "type": "text", "text": " — it pauses. " },
                { "type": "text", "marks": [{"type": "bold"}], "text": "No subscriptions, no setup" },
                { "type": "text", "text": ", just open and go." }
            ]}
        ]
    }).to_string();

    vec![
        Script { name: "About Me".to_string(), text: "Hi, I'm Arun.".to_string(), content: about_me_content },
        Script { name: "Meeting Notes".to_string(), text: "Quick recap.".to_string(), content: meeting_content },
        Script { name: "Product Demo".to_string(), text: "Let me walk you through what we've built.".to_string(), content: demo_content },
    ]
}

fn load_scripts() -> Vec<Script> {
    fs::read_to_string(scripts_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(default_scripts)
}
fn save_scripts_to_disk(scripts: &[Script]) {
    if let Ok(json) = serde_json::to_string_pretty(scripts) {
        let _ = fs::write(scripts_path(), json);
    }
}

// ── Helpers ────────────────────────────────────────────────
fn get_prompter(app: &AppHandle) -> Option<WebviewWindow> { app.get_webview_window("prompter") }
fn get_settings(app: &AppHandle) -> Option<WebviewWindow> { app.get_webview_window("settings") }

// Dev-only escape hatch: TELEPROMPTER_ALLOW_CAPTURE=1 disables screen-capture
// protection so the pill can be screenshotted (README/docs captures, visual
// debugging). Normal launches never set it, so content protection stays on.
fn capture_allowed() -> bool {
    std::env::var("TELEPROMPTER_ALLOW_CAPTURE").map(|v| v == "1").unwrap_or(false)
}

fn apply_screenshare_mode(window: &WebviewWindow, hidden: bool) {
    let _ = window.set_content_protected(hidden && !capture_allowed());
}

// ── Commands ───────────────────────────────────────────────

// Called from JS after window mounts — runs on Tauri's main thread dispatcher
#[tauri::command]
fn elevate_notch_window(window: WebviewWindow) -> String {
    let cfg = window.app_handle()
        .try_state::<AppState>()
        .map(|s| s.config.lock().unwrap().mode.clone())
        .unwrap_or_default();
    eprintln!("[notch-cmd] called, mode={cfg}");
    if cfg != "classic" {
        // elevate_to_notch_level now handles both level=27 AND repositioning to screen top
        elevate_to_notch_level(&window);
    }
    format!("ok:mode={cfg}")
}

#[tauri::command]
fn get_config(state: State<AppState>) -> Config {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn get_notch_metrics() -> serde_json::Value {
    notch_metrics().unwrap_or_else(|| serde_json::json!({ "hasNotch": false }))
}

#[tauri::command]
fn set_config(app: AppHandle, state: State<AppState>, patch: serde_json::Value) {
    let mut cfg = state.config.lock().unwrap();
    if let Some(v) = patch.get("scrollSpeed").and_then(|v| v.as_f64()) { cfg.scroll_speed = v; }
    if let Some(v) = patch.get("threshold").and_then(|v| v.as_f64()) { cfg.threshold = v; }
    if let Some(v) = patch.get("screenshareHidden").and_then(|v| v.as_bool()) { cfg.screenshare_hidden = v; }
    if let Some(v) = patch.get("mode").and_then(|v| v.as_str()) { cfg.mode = v.to_string(); }
    if let Some(v) = patch.get("opacity").and_then(|v| v.as_f64()) { cfg.opacity = v; }
    if let Some(v) = patch.get("autoScroll").and_then(|v| v.as_bool()) { cfg.auto_scroll = v; }
    if let Some(v) = patch.get("micDeviceId").and_then(|v| v.as_str()) { cfg.mic_device_id = v.to_string(); }
    if let Some(v) = patch.get("theme").and_then(|v| v.as_str()) { cfg.theme = v.to_string(); }
    if let Some(v) = patch.get("wordTracking").and_then(|v| v.as_bool()) { cfg.word_tracking = v; }
    if let Some(v) = patch.get("trackingHints").and_then(|v| v.as_str()) { cfg.tracking_hints = v.to_string(); }
    if let Some(v) = patch.get("aiProvider").and_then(|v| v.as_str()) { cfg.ai_provider = v.to_string(); }
    if let Some(v) = patch.get("aiModel").and_then(|v| v.as_str()) { cfg.ai_model = v.to_string(); }
    if let Some(v) = patch.get("aiLocalUrl").and_then(|v| v.as_str()) { cfg.ai_local_url = v.to_string(); }
    if let Some(v) = patch.get("aiPrefs") { if v.is_object() { cfg.ai_prefs = v.clone(); } }

    let cfg_clone = cfg.clone();
    save_config(&cfg_clone);
    drop(cfg);

    if let Some(w) = get_prompter(&app) {
        apply_screenshare_mode(&w, cfg_clone.screenshare_hidden);
    }
    let _ = app.emit("config-update", &cfg_clone);
}

/// Safe mode switch — collapses JS first, then recreates window
#[tauri::command]
fn switch_mode(app: AppHandle, state: State<AppState>, mode: String) {
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.mode = mode.clone();
        save_config(&cfg);
    }
    let _ = app.emit_to("prompter", "shortcut", "stop");
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        if let Some(w) = get_prompter(&app2) { let _ = w.close(); }
        // Wait up to 3s for the window to actually close
        for _ in 0..60 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if app2.get_webview_window("prompter").is_none() { break; }
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
        // Window creation + NSWindow APIs MUST be on main thread (macOS Sequoia requirement)
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || {
            create_prompter_window(&app3);
        });
    });
}

#[tauri::command]
fn get_scripts() -> Vec<Script> { load_scripts() }

#[tauri::command]
fn save_scripts(scripts: Vec<Script>) { save_scripts_to_disk(&scripts); }

#[tauri::command]
fn set_ignore_mouse(app: AppHandle, state: State<AppState>, ignore: bool) -> Result<(), String> {
    // Never enable click-through in classic mode — buttons must be clickable
    let cfg = state.config.lock().unwrap();
    let is_classic = cfg.mode == "classic";
    drop(cfg);
    if let Some(w) = get_prompter(&app) {
        let effective = if is_classic { false } else { ignore };
        w.set_ignore_cursor_events(effective).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn resize_prompter(app: AppHandle, state: State<AppState>, dims: serde_json::Value) -> Result<(), String> {
    let Some(w) = get_prompter(&app) else { return Ok(()) };
    let width  = dims.get("width").and_then(|v| v.as_f64()).unwrap_or(560.0);
    let height = dims.get("height").and_then(|v| v.as_f64()).unwrap_or(400.0);

    let cfg = state.config.lock().unwrap();
    let is_notch = cfg.mode != "classic";
    drop(cfg);

    // Notch mode:
    // - idle (small pill): use exact size so window doesn't block clicks behind it
    // - edit/read (expanded): use full screen width so island can animate from center
    if is_notch {
        let monitor = w.current_monitor().map_err(|e| e.to_string())?
            .or_else(|| w.primary_monitor().ok().flatten());
        let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
        let screen_w = monitor.as_ref().map(|m| m.size().width as f64 / scale).unwrap_or(1440.0);

        // Always use exact island size — center the window horizontally.
        // Island is centered via CSS within this window, so the window must be
        // centered on the physical notch (runtime-derived); screens without a
        // notch center on the screen midline as before.
        // Loose sanity floor only — the idle size is notch-derived and can be
        // well under the old 200×36 fixed pill on scaled resolutions.
        let win_w = width.max(120.0);
        let win_h = height.max(24.0);
        let center_x = notch_metrics()
            .and_then(|m| m.get("centerX").and_then(|v| v.as_f64()))
            .unwrap_or(screen_w / 2.0);
        let x = center_x - win_w / 2.0;
        w.set_size(LogicalSize::new(win_w, win_h)).map_err(|e| e.to_string())?;
        w.set_position(LogicalPosition::new(x, 0.0)).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let monitor = w.current_monitor().map_err(|e| e.to_string())?
        .or_else(|| w.primary_monitor().ok().flatten());
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let cur = w.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
    let (x, y) = (cur.x as f64 / scale, cur.y as f64 / scale);

    w.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    w.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn toggle_prompter(app: AppHandle) -> Result<bool, String> {
    let Some(w) = get_prompter(&app) else { return Ok(false) };
    let visible = w.is_visible().unwrap_or(false);
    if visible {
        let _ = app.emit_to("prompter", "shortcut", "stop");
        w.hide().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
fn resize_settings(app: AppHandle, dims: serde_json::Value) -> Result<(), String> {
    let Some(w) = get_settings(&app) else { return Ok(()) };
    let height = dims.get("height").and_then(|v| v.as_f64()).unwrap_or(380.0);

    #[cfg(target_os = "windows")]
    let panel_w = 220.0_f64;
    #[cfg(not(target_os = "windows"))]
    let panel_w = 280.0_f64;

    let monitor = w.current_monitor().ok().flatten();
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let screen_h = monitor.as_ref().map(|m| m.size().height as f64 / scale).unwrap_or(900.0);
    let capped_h = height.min(screen_h - 40.0);

    w.set_size(LogicalSize::new(panel_w, capped_h)).map_err(|e| e.to_string())?;
    // Re-anchor after resize — only use positioner after tray has been clicked
    if !TRAY_CLICKED.load(Ordering::Relaxed) || w.move_window(Position::TrayCenter).is_err() {
        // Positioner not ready — fall back to bottom-right corner
        let monitor = w.current_monitor().ok().flatten();
        let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
        let screen_w = monitor.as_ref().map(|m| m.size().width as f64 / scale).unwrap_or(1440.0);
        let screen_h = monitor.map(|m| m.size().height as f64 / scale).unwrap_or(900.0);
        let x = screen_w - panel_w - 12.0;
        let y = screen_h - capped_h - 48.0;
        let _ = w.set_position(LogicalPosition::new(x, y));
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) { app.exit(0); }

#[tauri::command]
fn focus_prompter(app: AppHandle) {
    if let Some(w) = get_prompter(&app) {
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn open_devtools(app: AppHandle) {
    if let Some(w) = get_prompter(&app) { w.open_devtools(); }
}

#[tauri::command]
fn set_movable(_app: AppHandle, _movable: bool) -> Result<(), String> { Ok(()) }

#[tauri::command]
fn move_window(app: AppHandle, pos: serde_json::Value) -> Result<(), String> {
    let Some(w) = get_prompter(&app) else { return Ok(()) };
    let x = pos.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let y = pos.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
    w.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    if let Some(state) = app.try_state::<AppState>() {
        *state.classic_pos.lock().unwrap() = Some((x, y));
    }
    Ok(())
}

#[tauri::command]
fn get_window_pos(app: AppHandle) -> serde_json::Value {
    if let Some(w) = get_prompter(&app) {
        if let Ok(pos) = w.outer_position() {
            return serde_json::json!({ "x": pos.x, "y": pos.y });
        }
    }
    serde_json::json!({ "x": 0, "y": 0 })
}

#[tauri::command]
fn start_drag(app: AppHandle) -> Result<(), String> {
    if let Some(w) = get_prompter(&app) {
        w.start_dragging().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_settings(app: AppHandle) {
    if let Some(w) = get_settings(&app) { let _ = w.hide(); }
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    show_settings(&app);
}

#[tauri::command]
fn open_url(_app: AppHandle, url: String) {
    let _ = open::that(url);
}

// ── Speech sidecar (on-device recognition) ─────────────────
// Spawns the bundled speech-sidecar binary and forwards its NDJSON stdout
// lines to all windows as `speech-msg` events. The frontend owns matching,
// fallback, and restart policy; Rust only supervises the process.

fn kill_speech_child(state: &AppState) {
    if let Some(child) = state.speech_child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

#[tauri::command]
fn start_speech(
    app: AppHandle,
    state: State<AppState>,
    locale: String,
    script_text: Option<String>,
    contextual: Option<Vec<String>>,
    tricky: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    kill_speech_child(&state);
    *state.speech_status.lock().unwrap() =
        serde_json::json!({ "type": "starting", "locale": locale });

    // Script text feeds the sidecar's customized language model (macOS 14+);
    // `contextual` is the script's non-stopword vocabulary (prepared by the
    // frontend) for the request-level contextualStrings bias; `tricky` is the
    // user's Settings list of hard words / pronunciations. All passed via
    // files to avoid argv limits; the sidecar ignores what it can't use.
    let mut args = vec!["--locale".to_string(), locale.clone()];
    if let Some(text) = script_text.filter(|t| !t.trim().is_empty()) {
        let path = std::env::temp_dir().join("ai-teleprompter-script.txt");
        if fs::write(&path, text).is_ok() {
            args.push("--script".to_string());
            args.push(path.to_string_lossy().to_string());
        }
    }
    if let Some(list) = contextual.filter(|l| !l.is_empty()) {
        let path = std::env::temp_dir().join("ai-teleprompter-contextual.txt");
        if fs::write(&path, list.join("\n")).is_ok() {
            args.push("--contextual".to_string());
            args.push(path.to_string_lossy().to_string());
        }
    }
    if let Some(text) = tricky.filter(|t| !t.trim().is_empty()) {
        let path = std::env::temp_dir().join("ai-teleprompter-tricky.txt");
        if fs::write(&path, text).is_ok() {
            args.push("--tricky".to_string());
            args.push(path.to_string_lossy().to_string());
        }
    }

    let (mut rx, child) = app
        .shell()
        .sidecar("speech-sidecar")
        .map_err(|e| e.to_string())?
        .args(&args)
        .spawn()
        .map_err(|e| e.to_string())?;
    *state.speech_child.lock().unwrap() = Some(child);

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let s = String::from_utf8_lossy(&line);
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                        let msg_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        if msg_type == "ready" || msg_type == "error" {
                            if let Some(st) = app2.try_state::<AppState>() {
                                *st.speech_status.lock().unwrap() = v.clone();
                            }
                        }
                        let _ = app2.emit("speech-msg", v);
                    }
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[speech-sidecar] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    let msg = serde_json::json!({
                        "type": "terminated",
                        "code": payload.code,
                    });
                    if let Some(st) = app2.try_state::<AppState>() {
                        st.speech_child.lock().unwrap().take();
                        // Keep a fatal error as the surfaced status; otherwise
                        // record the termination itself.
                        let mut status = st.speech_status.lock().unwrap();
                        let is_fatal_error = status.get("type").and_then(|t| t.as_str()) == Some("error")
                            && status.get("fatal").and_then(|f| f.as_bool()).unwrap_or(false);
                        if !is_fatal_error {
                            *status = msg.clone();
                        }
                    }
                    let _ = app2.emit("speech-msg", msg);
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn stop_speech(state: State<AppState>) {
    kill_speech_child(&state);
    *state.speech_status.lock().unwrap() = serde_json::json!({ "type": "stopped" });
}

// Advisory notice from the prompter (e.g. script/recognition language
// mismatch) surfaced in the settings window. Empty string clears it.
#[tauri::command]
fn set_speech_notice(app: AppHandle, state: State<AppState>, message: String) {
    *state.speech_notice.lock().unwrap() = message.clone();
    let _ = app.emit("speech-notice", message);
}

#[tauri::command]
fn get_speech_notice(state: State<AppState>) -> String {
    state.speech_notice.lock().unwrap().clone()
}

#[tauri::command]
fn get_speech_status(state: State<AppState>) -> serde_json::Value {
    state.speech_status.lock().unwrap().clone()
}

// Dev-only (?trackrecord=1): saves a recorded reading session — the script
// text plus the raw sidecar message stream — as a JSON regression fixture
// under tests/fixtures/tracking/ in the repo checkout (replayed by
// scripts/track-replay.mjs). Compiled out of release builds, which have no
// repo checkout to write into.
#[tauri::command]
#[allow(unused_variables)]
fn save_tracking_fixture(json: String) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/tracking");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let path = dir.join(format!("session-{stamp}.json"));
        fs::write(&path, json).map_err(|e| e.to_string())?;
        eprintln!("[trackrecord] fixture saved: {}", path.display());
        Ok(path.to_string_lossy().to_string())
    }
    #[cfg(not(debug_assertions))]
    Err("recording is available in dev builds only".to_string())
}

// ── Subscription provider CLIs (Prepare with AI) ───────────
// The claude-code and codex providers delegate to the official CLIs the user
// has already installed and logged into (`claude -p`, `codex exec`). The app
// never reads, copies, or proxies any OAuth token or credential file, and
// never talks to the vendors' subscription endpoints itself — the CLI owns
// authentication end to end. Rationale in docs/ARCHITECTURE.md §4.4a.
//
// The CLIs are spawned from Rust only (std::process); they are never exposed
// to the WebView through the shell plugin, so no shell-scope capability
// entries exist for them — strictly tighter than scoping plugin execution.

const CLI_DEFAULT_TIMEOUT_SECS: u64 = 120;

// Extra directories searched besides PATH: GUI apps launched from Finder get
// a minimal PATH, so the common install locations are checked explicitly.
fn cli_extra_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.insert(0, home.join(".local/bin"));
        dirs.insert(1, home.join(".claude/local/bin"));
        dirs.insert(2, home.join(".claude/local"));
        dirs.push(home.join(".npm-global/bin"));
        dirs.push(home.join("bin"));
    }
    dirs
}

fn find_cli_in(name: &str, extra_dirs: &[PathBuf], search_path: bool) -> Option<PathBuf> {
    let is_exec = |p: &PathBuf| {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    };
    if search_path {
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                let cand = dir.join(name);
                if is_exec(&cand) { return Some(cand); }
            }
        }
    }
    for dir in extra_dirs {
        let cand = dir.join(name);
        if is_exec(&cand) { return Some(cand); }
    }
    None
}

fn find_cli(name: &str) -> Option<PathBuf> {
    find_cli_in(name, &cli_extra_dirs(), true)
}

// Kill a CLI child and everything it spawned (it leads its own process
// group), then reap it — no zombies, no orphans holding pipes open.
fn kill_child_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("/bin/kill")
            .args(["-KILL", &format!("-{}", child.id())])
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

struct CliOutput {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

// Spawn a CLI, feed `stdin_data`, and collect output with a hard timeout.
// The child is parked in `slot` (when given) so cancel_ai_cli / app exit can
// kill it; on timeout it is killed and reaped — no zombies either way.
fn run_cli_capture(
    mut cmd: std::process::Command,
    stdin_data: &str,
    timeout: std::time::Duration,
    slot: Option<&Mutex<Option<std::process::Child>>>,
) -> Result<CliOutput, String> {
    use std::io::{Read, Write};
    use std::process::Stdio;

    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // New process group: killing on cancel/timeout signals the whole tree,
    // so helpers the CLI forks can't linger or hold the output pipes open.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("cli_failed:could not start: {e}"))?;

    let mut stdin = child.stdin.take();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let data = stdin_data.to_string();
    let w = std::thread::spawn(move || {
        if let Some(ref mut pipe) = stdin {
            let _ = pipe.write_all(data.as_bytes());
        }
        // dropping stdin closes the pipe so the CLI sees EOF
    });
    let out_reader = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(ref mut pipe) = stdout { let _ = pipe.read_to_string(&mut buf); }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(ref mut pipe) = stderr { let _ = pipe.read_to_string(&mut buf); }
        buf
    });

    // Park the child where cancellation can reach it, then poll.
    match slot {
        Some(slot_ref) => {
            *slot_ref.lock().unwrap() = Some(child);
            finish_cli_shared(slot_ref, w, out_reader, err_reader, timeout)
        }
        // Local slot so the polling below is uniform.
        None => finish_cli(Mutex::new(Some(child)), w, out_reader, err_reader, timeout),
    }
}

fn finish_cli(
    slot: Mutex<Option<std::process::Child>>,
    w: std::thread::JoinHandle<()>,
    out_reader: std::thread::JoinHandle<String>,
    err_reader: std::thread::JoinHandle<String>,
    timeout: std::time::Duration,
) -> Result<CliOutput, String> {
    finish_cli_shared(&slot, w, out_reader, err_reader, timeout)
}

fn finish_cli_shared(
    slot: &Mutex<Option<std::process::Child>>,
    w: std::thread::JoinHandle<()>,
    out_reader: std::thread::JoinHandle<String>,
    err_reader: std::thread::JoinHandle<String>,
    timeout: std::time::Duration,
) -> Result<CliOutput, String> {
    let started = std::time::Instant::now();
    let code = loop {
        {
            let mut guard = slot.lock().unwrap();
            match guard.as_mut() {
                None => break None, // cancelled: cancel_ai_cli killed and took it
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        guard.take();
                        break Some(status.code());
                    }
                    Ok(None) => {}
                    Err(e) => {
                        kill_child_tree(child);
                        guard.take();
                        return Err(format!("cli_failed:wait error: {e}"));
                    }
                },
            }
            if started.elapsed() >= timeout {
                if let Some(mut child) = guard.take() {
                    kill_child_tree(&mut child);
                }
                let _ = w.join();
                let _ = out_reader.join();
                let _ = err_reader.join();
                return Err(format!(
                    "timeout:The provider CLI did not answer within {}s",
                    timeout.as_secs()
                ));
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(80));
    };
    let _ = w.join();
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    match code {
        None => Err("canceled:Prepare was cancelled".to_string()),
        Some(code) => Ok(CliOutput { code, stdout, stderr }),
    }
}

// Argument builders — pure, unit-tested. Flags verified against
// claude 2.1.259 and codex-cli 0.153.0 (docs/ARCHITECTURE.md §4.4a):
// tools/customizations off, nothing persisted, machine-readable output.
fn claude_prepare_args(system: &str, model: &str, effort: &str) -> Vec<String> {
    let mut args = vec![
        "-p".into(),
        "--output-format".into(), "json".into(),
        "--safe-mode".into(),               // no hooks/plugins/MCP/CLAUDE.md
        "--tools".into(), "".into(),        // no built-in tools at all
        "--no-session-persistence".into(),
        "--system-prompt".into(), system.into(),
    ];
    if !model.is_empty() {
        args.push("--model".into());
        args.push(model.into());
    }
    if !effort.is_empty() {
        args.push("--effort".into());
        args.push(effort.into());
    }
    args
}

fn codex_prepare_args(workdir: &str, outfile: &str, model: &str, effort: &str) -> Vec<String> {
    let mut args = vec![
        "exec".into(),
        "--sandbox".into(), "read-only".into(), // model-run commands can't write
        "--skip-git-repo-check".into(),
        "--ephemeral".into(),                   // no session files on disk
        "--color".into(), "never".into(),
        "-C".into(), workdir.into(),
        "--output-last-message".into(), outfile.into(),
    ];
    if !model.is_empty() {
        args.push("--model".into());
        args.push(model.into());
    }
    if !effort.is_empty() {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort=\"{effort}\""));
    }
    args
}

// Map a failed CLI run to a "code:detail" error, surfacing the CLI's own
// message for rate limits / usage caps / auth problems.
fn map_cli_failure(kind: &str, code: Option<i32>, stdout: &str, stderr: &str) -> String {
    let combined = format!("{stdout}\n{stderr}").to_lowercase();
    let detail = {
        let s = stderr.trim();
        let line = s.lines().rev().find(|l| !l.trim().is_empty())
            .or_else(|| stdout.trim().lines().rev().find(|l| !l.trim().is_empty()))
            .unwrap_or("the CLI reported no error message");
        line.trim().chars().take(300).collect::<String>()
    };
    if ["rate limit", "usage limit", "quota", "out of credit", "usage cap", "limit reached", "too many requests"]
        .iter().any(|m| combined.contains(m))
    {
        return format!("cli_rate_limit:{detail}");
    }
    if ["not logged in", "login required", "please log in", "please run codex login",
        "please sign in", "authentication", "unauthorized", "oauth"]
        .iter().any(|m| combined.contains(m))
    {
        return format!("cli_not_logged_in:{detail}");
    }
    format!("cli_failed:{kind} exited with {} — {detail}", code.map_or("signal".into(), |c| c.to_string()))
}

fn parse_claude_result(stdout: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|_| "parse:the Claude CLI returned unexpected output".to_string())?;
    let is_error = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
    let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
    let result = v.get("result").and_then(|r| r.as_str()).unwrap_or("");
    if is_error || subtype != "success" {
        let detail = if result.is_empty() { subtype } else { result };
        let lower = detail.to_lowercase();
        if lower.contains("limit") || lower.contains("quota") {
            return Err(format!("cli_rate_limit:{}", detail.chars().take(300).collect::<String>()));
        }
        return Err(format!("cli_failed:{}", detail.chars().take(300).collect::<String>()));
    }
    if result.trim().is_empty() {
        return Err("parse:empty response".to_string());
    }
    Ok(result.to_string())
}

// Detection: binary presence via PATH + known install dirs, login state via
// each CLI's own status mechanism — `claude auth status` (JSON, loggedIn) and
// `codex login status` (exit code + message). Neither consumes plan usage.
fn detect_cli_at(kind: &str, bin: &PathBuf) -> serde_json::Value {
    let timeout = std::time::Duration::from_secs(15);
    let version = {
        let mut c = std::process::Command::new(bin);
        c.arg("--version");
        run_cli_capture(c, "", timeout, None)
            .ok()
            .map(|o| o.stdout.trim().to_string())
            .unwrap_or_default()
    };
    let path_str = bin.to_string_lossy().to_string();
    match kind {
        "claude-code" => {
            let mut c = std::process::Command::new(bin);
            c.args(["auth", "status"]);
            match run_cli_capture(c, "", timeout, None) {
                Ok(o) => {
                    let logged_in = serde_json::from_str::<serde_json::Value>(o.stdout.trim())
                        .ok()
                        .and_then(|v| v.get("loggedIn").and_then(|b| b.as_bool()))
                        .unwrap_or(false);
                    if o.code == Some(0) && logged_in {
                        serde_json::json!({ "state": "available", "path": path_str, "version": version })
                    } else {
                        serde_json::json!({ "state": "not_logged_in", "path": path_str, "version": version,
                                            "detail": o.stdout.trim().chars().take(300).collect::<String>() })
                    }
                }
                Err(e) => serde_json::json!({ "state": "not_logged_in", "path": path_str, "version": version, "detail": e }),
            }
        }
        "codex" => {
            let mut c = std::process::Command::new(bin);
            c.args(["login", "status"]);
            match run_cli_capture(c, "", timeout, None) {
                Ok(o) => {
                    let msg = format!("{} {}", o.stdout.trim(), o.stderr.trim());
                    if o.code == Some(0) && msg.to_lowercase().contains("logged in") {
                        serde_json::json!({ "state": "available", "path": path_str, "version": version })
                    } else {
                        serde_json::json!({ "state": "not_logged_in", "path": path_str, "version": version,
                                            "detail": msg.trim().chars().take(300).collect::<String>() })
                    }
                }
                Err(e) => serde_json::json!({ "state": "not_logged_in", "path": path_str, "version": version, "detail": e }),
            }
        }
        _ => serde_json::json!({ "state": "error", "detail": "unknown cli" }),
    }
}

#[tauri::command]
async fn detect_ai_provider(app: AppHandle, provider: String) -> serde_json::Value {
    match provider.as_str() {
        "claude-code" | "codex" => {
            let bin_name = if provider == "claude-code" { "claude" } else { "codex" };
            match find_cli(bin_name) {
                None => serde_json::json!({ "state": "not_installed" }),
                Some(bin) => {
                    let kind = provider.clone();
                    tauri::async_runtime::spawn_blocking(move || detect_cli_at(&kind, &bin))
                        .await
                        .unwrap_or_else(|e| serde_json::json!({ "state": "error", "detail": e.to_string() }))
                }
            }
        }
        "anthropic-api" => {
            let has_key = keyring_entry()
                .ok()
                .and_then(|e| e.get_password().ok())
                .map(|k| !k.is_empty())
                .unwrap_or(false);
            serde_json::json!({ "state": if has_key { "available" } else { "not_configured" } })
        }
        "ollama" => {
            let url = {
                let state = app.state::<AppState>();
                let cfg = state.config.lock().unwrap();
                cfg.ai_local_url.clone()
            };
            let probe = format!("{}/v1/models", url.trim_end_matches('/'));
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(3))
                .build();
            match client {
                Ok(c) => match c.get(&probe).send().await {
                    Ok(resp) if resp.status().is_success() =>
                        serde_json::json!({ "state": "available" }),
                    _ => serde_json::json!({ "state": "not_running" }),
                },
                Err(_) => serde_json::json!({ "state": "not_running" }),
            }
        }
        _ => serde_json::json!({ "state": "error", "detail": "unknown provider" }),
    }
}

#[tauri::command]
async fn ai_cli_prepare(
    app: AppHandle,
    provider: String,
    system: String,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    let bin_name = match provider.as_str() {
        "claude-code" => "claude",
        "codex" => "codex",
        _ => return Err("no_provider:Unknown CLI provider".to_string()),
    };
    // Re-resolved on every call, so a CLI uninstalled mid-session surfaces
    // as a clean setup error instead of a spawn failure.
    let bin = find_cli(bin_name)
        .ok_or_else(|| format!("cli_not_installed:{bin_name} is not installed"))?;
    let model = model.unwrap_or_default();
    let effort = effort.unwrap_or_default();
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(CLI_DEFAULT_TIMEOUT_SECS));

    // Fresh empty working directory per run: the CLI sees no user files, and
    // anything it drops there is deleted afterwards.
    let workdir = std::env::temp_dir().join(format!(
        "ai-teleprompter-cli-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
    ));
    fs::create_dir_all(&workdir).map_err(|e| format!("cli_failed:tempdir: {e}"))?;

    let slot = app.state::<AppState>().cli_child.clone();
    let workdir_in = workdir.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_provider_cli(&provider, &bin, &workdir_in, &system, &prompt, &model, &effort, timeout, &slot)
    })
    .await
    .map_err(|e| format!("cli_failed:{e}"))?;

    let _ = fs::remove_dir_all(&workdir);
    result
}

// The blocking core of ai_cli_prepare, factored out so the fake-CLI tests
// can exercise it directly.
#[allow(clippy::too_many_arguments)]
fn run_provider_cli(
    provider: &str,
    bin: &PathBuf,
    workdir: &PathBuf,
    system: &str,
    prompt: &str,
    model: &str,
    effort: &str,
    timeout: std::time::Duration,
    slot: &Mutex<Option<std::process::Child>>,
) -> Result<String, String> {
    match provider {
        "claude-code" => {
            let mut cmd = std::process::Command::new(bin);
            cmd.args(claude_prepare_args(system, model, effort));
            cmd.current_dir(workdir);
            let out = run_cli_capture(cmd, prompt, timeout, Some(slot))?;
            if out.code != Some(0) {
                // A failed run may still carry a JSON error body on stdout.
                if let Err(mapped) = parse_claude_result(&out.stdout) {
                    if !mapped.starts_with("parse:") { return Err(mapped); }
                }
                return Err(map_cli_failure("claude", out.code, &out.stdout, &out.stderr));
            }
            parse_claude_result(&out.stdout)
        }
        "codex" => {
            let outfile = workdir.join("last-message.txt");
            let mut cmd = std::process::Command::new(bin);
            cmd.args(codex_prepare_args(
                &workdir.to_string_lossy(),
                &outfile.to_string_lossy(),
                model,
                effort,
            ));
            cmd.current_dir(workdir);
            // Codex has no separate system-prompt channel in exec mode —
            // the instructions ride at the top of the prompt.
            let combined = format!("{system}\n\n{prompt}");
            let out = run_cli_capture(cmd, &combined, timeout, Some(slot))?;
            if out.code != Some(0) {
                return Err(map_cli_failure("codex", out.code, &out.stdout, &out.stderr));
            }
            let text = fs::read_to_string(&outfile).unwrap_or_default();
            if text.trim().is_empty() {
                return Err("parse:the Codex CLI returned no output".to_string());
            }
            Ok(text)
        }
        _ => Err("no_provider:Unknown CLI provider".to_string()),
    }
}

#[tauri::command]
fn cancel_ai_cli(state: State<AppState>) {
    if let Some(mut child) = state.cli_child.lock().unwrap().take() {
        kill_child_tree(&mut child);
    }
}

// ── AI provider proxy (Prepare with AI) ────────────────────
// The frontend builds prompts and parses responses (src/lib/ai.js); this side
// is a dumb transport that owns the secrets: the Anthropic API key lives in
// the macOS Keychain and is read here at request time — it never crosses IPC
// to the WebView. Errors are returned as "code:detail" strings; the frontend
// maps codes to actionable messages.

const KEYCHAIN_SERVICE: &str = "AI Teleprompter";
const KEYCHAIN_ACCOUNT: &str = "anthropic-api-key";

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| format!("keychain:{e}"))
}

#[tauri::command]
fn set_ai_key(key: String) -> Result<(), String> {
    let entry = keyring_entry()?;
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keychain:{e}")),
        }
    } else {
        entry.set_password(&key).map_err(|e| format!("keychain:{e}"))
    }
}

#[tauri::command]
fn has_ai_key() -> bool {
    keyring_entry()
        .ok()
        .and_then(|e| e.get_password().ok())
        .map(|k| !k.is_empty())
        .unwrap_or(false)
}

fn api_error_message(v: &serde_json::Value) -> String {
    v.get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("request failed")
        .to_string()
}

fn map_http_error(status: u16, retry_after: &str, v: &serde_json::Value) -> String {
    let msg = api_error_message(v);
    match status {
        401 | 403 => format!("auth:{msg}"),
        404 => format!("model_not_found:{msg}"),
        429 => format!("rate_limit:{retry_after}|{msg}"),
        _ => format!("server:{status} {msg}"),
    }
}

#[tauri::command]
async fn ai_complete(
    app: AppHandle,
    system: String,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    // Snapshot config before any await — the Mutex guard must not cross it
    let (provider, cfg_model, local_url) = {
        let state = app.state::<AppState>();
        let cfg = state.config.lock().unwrap();
        (cfg.ai_provider.clone(), cfg.ai_model.clone(), cfg.ai_local_url.clone())
    };
    let model = model.filter(|m| !m.is_empty()).unwrap_or(cfg_model);
    let effort = effort.filter(|e| !e.is_empty());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("network:{e}"))?;

    match provider.as_str() {
        "anthropic" | "anthropic-api" => {
            let key = keyring_entry()?
                .get_password()
                .map_err(|_| "no_api_key:No API key saved".to_string())?;
            let model = if model.is_empty() { "claude-opus-5".to_string() } else { model };
            let mut body = serde_json::json!({
                "model": model,
                "max_tokens": 8192,
                "system": system,
                // Server-side refusal fallback: if safety classifiers decline,
                // the API retries on Anthropic's recommended model in-call.
                "fallbacks": "default",
                "messages": [{ "role": "user", "content": prompt }],
            });
            // Effort is GA inside output_config on models that support it
            // (low|medium|high|xhigh); the frontend gates per model.
            if let Some(e) = effort {
                body["output_config"] = serde_json::json!({ "effort": e });
            }
            let resp = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .header("anthropic-beta", "server-side-fallback-2026-07-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("network:{e}"))?;

            let status = resp.status().as_u16();
            let retry_after = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let v: serde_json::Value = resp.json().await.map_err(|e| format!("parse:{e}"))?;
            if status >= 400 {
                return Err(map_http_error(status, &retry_after, &v));
            }
            // Check stop_reason before reading content — safety classifiers
            // return HTTP 200 with stop_reason "refusal" and empty content.
            if v.get("stop_reason").and_then(|s| s.as_str()) == Some("refusal") {
                return Err("refusal:The model declined to process this script".to_string());
            }
            v.get("content")
                .and_then(|c| c.as_array())
                .and_then(|blocks| {
                    blocks.iter().find_map(|b| {
                        if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                            b.get("text").and_then(|t| t.as_str()).map(String::from)
                        } else {
                            None
                        }
                    })
                })
                .ok_or_else(|| "parse:empty response".to_string())
        }
        "local" | "ollama" => {
            if model.is_empty() {
                return Err("no_model:Set a model name in Settings".to_string());
            }
            let url = format!("{}/v1/chat/completions", local_url.trim_end_matches('/'));
            let body = serde_json::json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": prompt },
                ],
            });
            let resp = client
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("network:{e}"))?;

            let status = resp.status().as_u16();
            let retry_after = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let v: serde_json::Value = resp.json().await.map_err(|e| format!("parse:{e}"))?;
            if status >= 400 {
                return Err(map_http_error(status, &retry_after, &v));
            }
            v.get("choices")
                .and_then(|c| c.as_array())
                .and_then(|c| c.first())
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|t| t.as_str())
                .map(String::from)
                .ok_or_else(|| "parse:empty response".to_string())
        }
        _ => Err("no_provider:No AI provider configured".to_string()),
    }
}

// Validates a candidate provider setup with a minimal request BEFORE it is
// saved — backs the editor's guided onboarding ("Test connection"). Takes the
// candidate values directly (not the stored config) so the user can test
// exactly what they typed; an empty key falls back to the Keychain.
#[tauri::command]
async fn ai_test(cfg: serde_json::Value) -> Result<(), String> {
    let provider  = cfg.get("provider").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let model     = cfg.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let local_url = cfg.get("localUrl").and_then(|v| v.as_str()).unwrap_or("http://localhost:11434").to_string();
    let key       = cfg.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("network:{e}"))?;

    async fn check(resp: reqwest::Response) -> Result<(), String> {
        let status = resp.status().as_u16();
        if status < 400 { return Ok(()); }
        let retry_after = resp.headers().get("retry-after")
            .and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let v: serde_json::Value = resp.json().await.unwrap_or_default();
        Err(map_http_error(status, &retry_after, &v))
    }

    match provider.as_str() {
        "anthropic" | "anthropic-api" => {
            let key = if key.is_empty() {
                keyring_entry()?.get_password().map_err(|_| "no_api_key:No API key saved".to_string())?
            } else { key };
            let model = if model.is_empty() { "claude-opus-5".to_string() } else { model };
            let body = serde_json::json!({
                "model": model,
                "max_tokens": 1,
                "messages": [{ "role": "user", "content": "ping" }],
            });
            let resp = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("network:{e}"))?;
            check(resp).await
        }
        "local" | "ollama" => {
            if model.is_empty() {
                return Err("no_model:Enter a model name (e.g. llama3.1)".to_string());
            }
            let url = format!("{}/v1/chat/completions", local_url.trim_end_matches('/'));
            let body = serde_json::json!({
                "model": model,
                "max_tokens": 1,
                "messages": [{ "role": "user", "content": "ping" }],
            });
            let resp = client
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("network:{e}"))?;
            check(resp).await
        }
        _ => Err("no_provider:No AI provider selected".to_string()),
    }
}

// ── Window creation ────────────────────────────────────────

fn create_prompter_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("prompter") {
        let _ = w.close();
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    let cfg = app.try_state::<AppState>()
        .map(|s| s.config.lock().unwrap().clone())
        .unwrap_or_default();

    let is_notch = cfg.mode != "classic";

    let monitor = app.primary_monitor().ok().flatten();
    let scale   = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let screen_w: f64 = monitor.map(|m| m.size().width as f64 / scale).unwrap_or(1440.0);

    // Notch: full-screen-width transparent window — CSS shows only the pill
    let (width, height): (f64, f64) = if is_notch { (screen_w, 200.0) } else { (560.0, 400.0) };
    let saved_pos = app.try_state::<AppState>()
        .and_then(|s| s.classic_pos.lock().ok().and_then(|p| *p));
    let (x, y) = if !is_notch {
        saved_pos.unwrap_or(((screen_w - width) / 2.0, 100.0))
    } else {
        (0.0, 0.0)
    };

    // In dev mode use Vite dev server, in release use bundled dist
    #[cfg(debug_assertions)]
    let prompter_url = tauri::WebviewUrl::External("http://localhost:1420".parse().unwrap());
    #[cfg(not(debug_assertions))]
    let prompter_url = tauri::WebviewUrl::App("index.html".into());

    let window = tauri::WebviewWindowBuilder::new(
        app, "prompter",
        prompter_url,
    )
    .title("Teleprompter")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(cfg.mode == "classic")
    .accept_first_mouse(true)
    .inner_size(width, height)
    .position(x, y)
    .visible_on_all_workspaces(true)
    .content_protected(false)
    .build();

    let window = match window {
        Ok(w) => w,
        Err(e) => { eprintln!("Failed to create prompter window: {e}"); return; }
    };

    // NOTE: do NOT set_ignore_cursor_events here — breaks WKWebView rendering
    // JS side calls API.setIgnoreMouse after React mounts
    apply_screenshare_mode(&window, cfg.screenshare_hidden);

    // Elevate window level above menu bar (NSWindow APIs — must be on main thread).
    // switch_mode now dispatches create_prompter_window to main thread, so this is safe.
    eprintln!("[OT] is_notch={is_notch}, mode={}", cfg.mode);
    if is_notch {
        eprintln!("[OT] calling elevate_to_notch_level");
        elevate_to_notch_level(&window);
    }


}

fn position_settings_window(app: &AppHandle, w: &WebviewWindow) {
    let scale = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
    let screen_w = app.primary_monitor().ok().flatten().map(|m| m.size().width as f64 / scale).unwrap_or(1440.0);
    let screen_h = app.primary_monitor().ok().flatten().map(|m| m.size().height as f64 / scale).unwrap_or(900.0);

    #[cfg(target_os = "windows")]
    let (panel_w, panel_h) = (220.0_f64, 400.0_f64);
    #[cfg(not(target_os = "windows"))]
    let (panel_w, panel_h) = (280.0_f64, 380.0_f64);

    // Only use positioner after tray has been clicked — calling it before panics
    if TRAY_CLICKED.load(Ordering::Relaxed) {
        if w.move_window(Position::TrayCenter).is_ok() { return; }
    }

    // Fallback: bottom-right corner above taskbar
    let x = screen_w - panel_w - 12.0;
    let y = screen_h - panel_h - 48.0;
    let _ = w.set_position(LogicalPosition::new(x, y));
}

fn show_settings(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    let (settings_url, win_w, win_h) = ("renderer/settings-win.html", 220.0_f64, 500.0_f64);
    #[cfg(not(target_os = "windows"))]
    let (settings_url, win_w, win_h) = ("settings.html", 280.0_f64, 420.0_f64);

    if let Some(w) = get_settings(app) {
        position_settings_window(app, &w);
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        let _ = tauri::WebviewWindowBuilder::new(
            app, "settings",
            tauri::WebviewUrl::App(settings_url.into()),
        )
        .title("Settings")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(win_w, win_h)
        .build()
        .ok();
        if let Some(w) = get_settings(app) {
            position_settings_window(app, &w);
            w.set_always_on_top(true).ok();
            w.set_focus().ok();
        }
    }
}

fn hide_settings_internal(app: &AppHandle) {
    if let Some(w) = get_settings(app) { let _ = w.hide(); }
}

fn toggle_settings(app: &AppHandle) {
    if let Some(w) = get_settings(app) {
        if w.is_visible().unwrap_or(false) { hide_settings_internal(app); return; }
    }
    show_settings(app);
}

// ── Run ────────────────────────────────────────────────────

pub fn run() {
    eprintln!("[OT] starting up");
    // One-time copy of the previous bundle identity's app-support data; must
    // run before anything else touches the new identity's directories.
    let migration_notice_pending = migrate_previous_identity();
    let config = load_config();
    let state  = AppState {
        config:        Mutex::new(config),
        classic_pos:   Mutex::new(None),
        speech_child:  Mutex::new(None),
        speech_status: Mutex::new(serde_json::json!({ "type": "stopped" })),
        speech_notice: Mutex::new(String::new()),
        cli_child:     std::sync::Arc::new(Mutex::new(None)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_positioner::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_config, set_config, switch_mode, get_notch_metrics,
            get_scripts, save_scripts,
            set_ignore_mouse, resize_prompter,
            toggle_prompter, resize_settings,
            quit_app, open_devtools,
            hide_settings, start_drag,
            set_movable, move_window, get_window_pos,
            open_url, open_settings,
            focus_prompter, elevate_notch_window,
            start_speech, stop_speech, get_speech_status,
            set_speech_notice, get_speech_notice, save_tracking_fixture,
            ai_complete, ai_test, set_ai_key, has_ai_key,
            detect_ai_provider, ai_cli_prepare, cancel_ai_cli,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let cfg = app_handle.state::<AppState>().config.lock().unwrap().clone();
            let is_notch = cfg.mode != "classic";

            let monitor  = app_handle.primary_monitor().ok().flatten();
            let scale    = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
            let screen_w = monitor.map(|m| m.size().width as f64 / scale).unwrap_or(1440.0);

            let (width, height): (f64, f64) = if is_notch { (screen_w, 200.0) } else { (560.0, 400.0) };
            let x: f64 = if is_notch { 0.0 } else { (screen_w - width) / 2.0 };
            let y: f64 = if is_notch { 0.0 } else { 100.0 };

            #[cfg(debug_assertions)]
            let prompter_url = tauri::WebviewUrl::External("http://localhost:1420".parse().unwrap());
            // The bundled frontend is the Vite dist (index.html + settings.html);
            // upstream pointed this at a legacy "renderer/" path that only loaded
            // via the asset protocol's SPA fallback.
            #[cfg(not(debug_assertions))]
            let prompter_url = tauri::WebviewUrl::App("index.html".into());

            let prompter = tauri::WebviewWindowBuilder::new(
                app, "prompter",
                prompter_url,
            )
            .title("Teleprompter")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(cfg.mode == "classic")
            .accept_first_mouse(true)
            .inner_size(width, height)
            .position(x, y)
            .visible_on_all_workspaces(true)
            .content_protected(false)
            .build()?;

            eprintln!("[OT] setup: prompter window built, is_notch={is_notch}");

            // Elevate above menu bar in notch mode (must be on main thread)
            if is_notch {
                elevate_to_notch_level(&prompter);
            }

            apply_screenshare_mode(&prompter, cfg.screenshare_hidden);

            // Dev-only demo hooks: TELEPROMPTER_DEMO_PARAMS="view=read&trackdemo=1"
            // navigates the prompter to the same URL test hooks the visual
            // snapshot suite uses, so fixed UI states can be captured in the
            // real app. Delayed so the initial page load has settled.
            if let Ok(params) = std::env::var("TELEPROMPTER_DEMO_PARAMS") {
                if !params.is_empty() {
                    let w = prompter.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                        let js = format!("window.location.search = {};", serde_json::json!(params));
                        let _ = w.eval(&js);
                    });
                }
            }

            // NOTE: upstream opened a first-launch "welcome" window here. It
            // pointed at legacy renderer assets that are not part of the
            // bundled frontend, producing an unclosable blank/black centered
            // window on first launch — removed in this fork. On launch, only
            // the notch pill (and tray icon) appear.

            // ── Tray ───────────────────────────────────────
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
                .unwrap_or_else(|_| app_handle.default_window_icon().unwrap().clone());

            #[cfg(target_os = "macos")]
            TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .icon_as_template(true)
                .tooltip("AI Teleprompter")
                .build(app)?;

            #[cfg(not(target_os = "macos"))]
            {
                use tauri::menu::{Menu, MenuItem};
                let s = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
                let q = MenuItem::with_id(app, "quit",     "Quit",     true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&s, &q])?;
                TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .tooltip("AI Teleprompter")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .build(app)?;
            }

            let app_tray = app_handle.clone();
            app_handle.on_tray_icon_event(move |tray, event| {
                // Feed event to positioner so it knows tray position
                tauri_plugin_positioner::on_tray_event(tray, &event);
                TRAY_CLICKED.store(true, Ordering::Relaxed);
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up, ..
                } = event { toggle_settings(&app_tray); }
            });

            // Handle Windows tray menu item clicks
            let app_menu = app_handle.clone();
            app_handle.on_menu_event(move |_app, event| {
                match event.id().as_ref() {
                    "settings" => toggle_settings(&app_menu),
                    "quit"     => app_menu.exit(0),
                    _ => {}
                }
            });

            // ── Shortcuts ──────────────────────────────────
            // Use only Ctrl+Shift variants on Windows (Super/Win key combos conflict with system shortcuts)
            #[cfg(target_os = "windows")]
            let shortcuts = vec![
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space),
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::ArrowUp),
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::ArrowDown),
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyR),
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyE),
            ];
            #[cfg(not(target_os = "windows"))]
            let shortcuts = vec![
                Shortcut::new(Some(Modifiers::SUPER   | Modifiers::SHIFT), Code::Space),
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space),
                Shortcut::new(Some(Modifiers::SUPER   | Modifiers::SHIFT), Code::ArrowUp),
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::ArrowUp),
                Shortcut::new(Some(Modifiers::SUPER   | Modifiers::SHIFT), Code::ArrowDown),
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::ArrowDown),
                Shortcut::new(Some(Modifiers::SUPER   | Modifiers::SHIFT), Code::KeyR),
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyR),
                Shortcut::new(Some(Modifiers::SUPER   | Modifiers::SHIFT), Code::KeyE),
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyE),
            ];

            // Register shortcuts — skip any that are already taken by the OS
            for sc in shortcuts {
                let _ = app_handle.global_shortcut().on_shortcut(sc, move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed { return; }
                    let action = match shortcut.key {
                        Code::Space     => "pause",
                        Code::ArrowUp   => "faster",
                        Code::ArrowDown => "slower",
                        Code::KeyR      => "reset",
                        Code::KeyE      => "edit", // open the script editor
                        _ => return,
                    };
                    if action == "edit" {
                        // Make sure the prompter is visible before opening the editor
                        if let Some(w) = get_prompter(app) {
                            let _ = w.show();
                        }
                    }
                    let _ = app.emit_to("prompter", "shortcut", action);
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "settings" {
                    window.hide().ok();
                    api.prevent_close();
                }
                // Note: do NOT prevent prompter close — switch_mode needs to close and recreate it
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(move |app, event| {
            match event {
                // Post-migration notice: shown once the event loop is up (the
                // pill window already exists), on the main thread as NSAlert
                // requires. RunEvent::Ready fires exactly once per launch, and
                // the migration marker keeps it to one launch ever.
                tauri::RunEvent::Ready => {
                    if migration_notice_pending {
                        show_migration_notice();
                    }
                }
                // Make sure the speech sidecar never outlives the app
                tauri::RunEvent::Exit => {
                    if let Some(st) = app.try_state::<AppState>() {
                        kill_speech_child(&st);
                        if let Some(mut child) = st.cli_child.lock().unwrap().take() {
                            kill_child_tree(&mut child);
                        }
                    }
                }
                _ => {}
            }
        });
}

// ── Tests ──────────────────────────────────────────────────
#[cfg(test)]
mod migration_tests {
    use super::*;
    use std::path::PathBuf;

    // Fixture directories under the OS temp dir, unique per test so the
    // suite can run in parallel. Layout mirrors the real one: an "old"
    // app-support dir, a "new" one, and optional extra footprint dirs.
    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("ai-teleprompter-migration-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Fixture { root }
        }
        fn old_dir(&self) -> PathBuf { self.root.join("old-identity") }
        fn new_dir(&self) -> PathBuf { self.root.join("new-identity") }
        fn write(&self, rel: &str, contents: &str) {
            let path = self.root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
        fn read(&self, rel: &str) -> String {
            fs::read_to_string(self.root.join(rel)).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn copies_the_old_tree_including_nested_dirs_and_keeps_the_old_data() {
        let fx = Fixture::new("copy");
        fx.write("old-identity/library.json", "{\"scripts\":1}");
        fx.write("old-identity/nested/deep/settings.json", "{\"theme\":\"dark\"}");

        let outcome = run_identity_migration(&fx.old_dir(), &fx.new_dir(), &[]);

        assert!(outcome.performed);
        assert!(outcome.notice_pending);
        assert_eq!(outcome.files_copied, 2);
        assert_eq!(fx.read("new-identity/library.json"), "{\"scripts\":1}");
        assert_eq!(fx.read("new-identity/nested/deep/settings.json"), "{\"theme\":\"dark\"}");
        // Source is copied, never moved or deleted
        assert_eq!(fx.read("old-identity/library.json"), "{\"scripts\":1}");
        assert_eq!(fx.read("old-identity/nested/deep/settings.json"), "{\"theme\":\"dark\"}");
        assert!(fx.new_dir().join(MIGRATION_MARKER).exists());
    }

    #[test]
    fn never_overwrites_files_already_present_in_the_new_directory() {
        let fx = Fixture::new("no-overwrite");
        fx.write("old-identity/library.json", "old contents");
        fx.write("new-identity/library.json", "new contents");

        let outcome = run_identity_migration(&fx.old_dir(), &fx.new_dir(), &[]);

        assert!(outcome.performed);
        assert_eq!(outcome.files_copied, 0);
        assert_eq!(fx.read("new-identity/library.json"), "new contents");
    }

    #[test]
    fn is_idempotent_on_a_second_launch() {
        let fx = Fixture::new("idempotent");
        fx.write("old-identity/library.json", "v1");

        let first = run_identity_migration(&fx.old_dir(), &fx.new_dir(), &[]);
        assert!(first.performed);

        // A file that appears in the old dir later must NOT be picked up —
        // the migration is one-time, keyed on the marker.
        fx.write("old-identity/late-arrival.json", "nope");
        let second = run_identity_migration(&fx.old_dir(), &fx.new_dir(), &[]);

        assert_eq!(second, MigrationOutcome::default());
        assert!(!fx.new_dir().join("late-arrival.json").exists());
    }

    #[test]
    fn fresh_install_writes_the_marker_but_shows_no_notice() {
        let fx = Fixture::new("fresh");

        let outcome = run_identity_migration(&fx.old_dir(), &fx.new_dir(), &[]);

        assert!(outcome.performed);
        assert!(!outcome.notice_pending);
        assert_eq!(outcome.files_copied, 0);
        assert!(fx.new_dir().join(MIGRATION_MARKER).exists());

        // ...and the marker suppresses everything on the next launch.
        let second = run_identity_migration(&fx.old_dir(), &fx.new_dir(), &[]);
        assert_eq!(second, MigrationOutcome::default());
    }

    #[test]
    fn footprint_dirs_alone_trigger_the_notice_without_copying() {
        let fx = Fixture::new("footprint");
        fx.write("caches/old-identity-cache/blob.bin", "cache");

        let outcome = run_identity_migration(
            &fx.old_dir(),
            &fx.new_dir(),
            &[fx.root.join("caches/old-identity-cache")],
        );

        assert!(outcome.performed);
        assert!(outcome.notice_pending);
        assert_eq!(outcome.files_copied, 0);
    }
}

#[cfg(test)]
mod cli_tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    // The fake-CLI scripts read process-global environment variables, so
    // env-touching tests are serialized.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/cli").join(name)
    }

    fn temp_workdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-tp-cli-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn with_env(vars: &[(&str, &str)], f: impl FnOnce()) {
        // Poison-tolerant: an assertion failure in one test must not cascade
        // into PoisonError failures in every other env-touching test.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for (k, v) in vars { std::env::set_var(k, v); }
        f();
        for (k, _) in vars { std::env::remove_var(k); }
    }

    // ── detection ──────────────────────────────────────────
    #[test]
    fn find_cli_in_checks_the_given_directories() {
        let dir = fixture("fake-claude").parent().unwrap().to_path_buf();
        assert!(find_cli_in("fake-claude", &[dir.clone()], false).is_some());
        assert!(find_cli_in("fake-nonexistent", &[dir], false).is_none());
    }

    #[test]
    fn detects_a_logged_in_claude_cli() {
        with_env(&[("FAKE_CLAUDE_LOGGED_IN", "1")], || {
            let v = detect_cli_at("claude-code", &fixture("fake-claude"));
            assert_eq!(v["state"], "available");
            assert!(v["version"].as_str().unwrap().contains("9.9.9"));
        });
    }

    #[test]
    fn detects_a_logged_out_claude_cli() {
        with_env(&[("FAKE_CLAUDE_LOGGED_IN", "0")], || {
            let v = detect_cli_at("claude-code", &fixture("fake-claude"));
            assert_eq!(v["state"], "not_logged_in");
        });
    }

    #[test]
    fn detects_codex_login_state() {
        with_env(&[("FAKE_CODEX_LOGGED_IN", "1")], || {
            let v = detect_cli_at("codex", &fixture("fake-codex"));
            assert_eq!(v["state"], "available");
        });
        with_env(&[("FAKE_CODEX_LOGGED_IN", "0")], || {
            let v = detect_cli_at("codex", &fixture("fake-codex"));
            assert_eq!(v["state"], "not_logged_in");
            assert!(v["detail"].as_str().unwrap().contains("Not logged in"));
        });
    }

    // ── argument construction ──────────────────────────────
    #[test]
    fn claude_args_carry_model_effort_and_the_lockdown_flags() {
        let args = claude_prepare_args("SYS", "opus", "high");
        let joined = args.join(" ");
        assert!(args.windows(2).any(|w| w == ["--model", "opus"]));
        assert!(args.windows(2).any(|w| w == ["--effort", "high"]));
        assert!(args.windows(2).any(|w| w == ["--output-format", "json"]));
        assert!(args.windows(2).any(|w| w == ["--system-prompt", "SYS"]));
        assert!(args.windows(2).any(|w| w == ["--tools", ""]));
        assert!(joined.contains("--safe-mode"));
        assert!(joined.contains("--no-session-persistence"));

        // empty model/effort → the flags are omitted entirely
        let bare = claude_prepare_args("SYS", "", "");
        assert!(!bare.contains(&"--model".to_string()));
        assert!(!bare.contains(&"--effort".to_string()));
    }

    #[test]
    fn codex_args_carry_model_effort_and_the_sandbox_flags() {
        let args = codex_prepare_args("/tmp/wd", "/tmp/wd/out.txt", "gpt-x", "xhigh");
        assert_eq!(args[0], "exec");
        assert!(args.windows(2).any(|w| w == ["--sandbox", "read-only"]));
        assert!(args.contains(&"--skip-git-repo-check".to_string()));
        assert!(args.contains(&"--ephemeral".to_string()));
        assert!(args.windows(2).any(|w| w == ["-C", "/tmp/wd"]));
        assert!(args.windows(2).any(|w| w == ["--output-last-message", "/tmp/wd/out.txt"]));
        assert!(args.windows(2).any(|w| w == ["--model", "gpt-x"]));
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"model_reasoning_effort=\"xhigh\"".to_string()));

        let bare = codex_prepare_args("/w", "/w/o", "", "");
        assert!(!bare.contains(&"--model".to_string()));
        assert!(!bare.contains(&"-c".to_string()));
    }

    // ── invocation, parsing, and error mapping ─────────────
    fn run_fake(provider: &str, bin: &str, timeout_secs: u64) -> Result<String, String> {
        let workdir = temp_workdir(&format!("{provider}-{bin}"));
        let slot = Mutex::new(None);
        let out = run_provider_cli(
            provider, &fixture(bin), &workdir,
            "SYSTEM PROMPT", "USER PROMPT", "modelname", "high",
            Duration::from_secs(timeout_secs), &slot,
        );
        let _ = fs::remove_dir_all(&workdir);
        out
    }

    #[test]
    fn claude_success_returns_the_result_text() {
        with_env(&[("FAKE_CLAUDE_MODE", "success")], || {
            let text = run_fake("claude-code", "fake-claude", 15).unwrap();
            assert!(text.contains("prepared line one"));
        });
    }

    #[test]
    fn claude_prompt_arrives_on_stdin_and_args_are_as_built() {
        let args_file = std::env::temp_dir().join(format!("ai-tp-argsfile-{}", std::process::id()));
        let _ = fs::remove_file(&args_file);
        with_env(&[
            ("FAKE_CLAUDE_MODE", "success"),
            ("FAKE_CLI_ARGS_FILE", args_file.to_str().unwrap()),
        ], || {
            run_fake("claude-code", "fake-claude", 15).unwrap();
            let argv = fs::read_to_string(&args_file).unwrap();
            let lines: Vec<&str> = argv.lines().collect();
            assert_eq!(lines, claude_prepare_args("SYSTEM PROMPT", "modelname", "high"));
        });
        let _ = fs::remove_file(&args_file);
    }

    #[test]
    fn claude_json_error_body_maps_to_a_rate_limit_with_the_cli_message() {
        with_env(&[("FAKE_CLAUDE_MODE", "error_json")], || {
            let err = run_fake("claude-code", "fake-claude", 15).unwrap_err();
            assert!(err.starts_with("cli_rate_limit:"), "{err}");
            assert!(err.contains("usage limit reached"));
        });
    }

    #[test]
    fn claude_stderr_rate_limit_is_surfaced() {
        with_env(&[("FAKE_CLAUDE_MODE", "rate_limit")], || {
            let err = run_fake("claude-code", "fake-claude", 15).unwrap_err();
            assert!(err.starts_with("cli_rate_limit:"), "{err}");
            assert!(err.contains("resets at 3pm"));
        });
    }

    #[test]
    fn claude_malformed_output_maps_to_a_parse_error() {
        with_env(&[("FAKE_CLAUDE_MODE", "malformed")], || {
            let err = run_fake("claude-code", "fake-claude", 15).unwrap_err();
            assert!(err.starts_with("parse:"), "{err}");
        });
    }

    #[test]
    fn a_hung_cli_times_out_and_is_killed() {
        with_env(&[("FAKE_CLAUDE_MODE", "sleep"), ("FAKE_SLEEP", "30")], || {
            let started = std::time::Instant::now();
            let err = run_fake("claude-code", "fake-claude", 1).unwrap_err();
            assert!(err.starts_with("timeout:"), "{err}");
            assert!(started.elapsed() < Duration::from_secs(5)); // killed, not waited out
        });
    }

    #[test]
    fn codex_success_reads_the_last_message_file() {
        with_env(&[("FAKE_CODEX_MODE", "success")], || {
            let text = run_fake("codex", "fake-codex", 15).unwrap();
            assert!(text.contains("prepared by codex"));
        });
    }

    #[test]
    fn codex_rate_limit_stderr_is_surfaced() {
        with_env(&[("FAKE_CODEX_MODE", "rate_limit")], || {
            let err = run_fake("codex", "fake-codex", 15).unwrap_err();
            assert!(err.starts_with("cli_rate_limit:"), "{err}");
            assert!(err.contains("usage limit"));
        });
    }

    #[test]
    fn codex_missing_output_file_maps_to_a_parse_error() {
        with_env(&[("FAKE_CODEX_MODE", "no_output")], || {
            let err = run_fake("codex", "fake-codex", 15).unwrap_err();
            assert!(err.starts_with("parse:"), "{err}");
        });
    }

    // ── real-CLI verification (consumes plan usage — run explicitly) ──
    // cargo test real_cli -- --ignored --nocapture
    fn real_prepare(provider: &str, bin_name: &str) -> Result<String, String> {
        let bin = find_cli(bin_name).expect("CLI not installed");
        let workdir = temp_workdir(&format!("real-{provider}"));
        let slot = Mutex::new(None);
        let system = "You prepare scripts for a teleprompter with a narrow display. \
            Rewrite the raw script into short lines of 4-8 words, one clause per line. \
            Insert [PAUSE] markers sparingly. Output ONLY the prepared script text.";
        let prompt = "Prepare the following script for the teleprompter. Output only the prepared script.\n\n\
            Welcome to the AI Teleprompter demo. Our launch goes live today, so stay tuned. \
            Take a breath and keep a calm, even pace.";
        let out = run_provider_cli(
            provider, &bin, &workdir, system, prompt, "", "low",
            std::time::Duration::from_secs(120), &slot,
        );
        let _ = fs::remove_dir_all(&workdir);
        out
    }

    #[test]
    #[ignore = "invokes the real Claude Code CLI and consumes plan usage"]
    fn real_cli_claude_prepare() {
        let text = real_prepare("claude-code", "claude").expect("claude prepare failed");
        println!("--- claude-code prepared output ---\n{text}\n---");
        assert!(text.lines().filter(|l| !l.trim().is_empty()).count() >= 3);
        assert!(text.to_lowercase().contains("teleprompter"));
    }

    #[test]
    #[ignore = "invokes the real Codex CLI and consumes plan usage"]
    fn real_cli_codex_prepare() {
        let text = real_prepare("codex", "codex").expect("codex prepare failed");
        println!("--- codex prepared output ---\n{text}\n---");
        assert!(text.lines().filter(|l| !l.trim().is_empty()).count() >= 3);
    }

    #[test]
    fn cancellation_kills_the_running_cli() {
        use std::sync::Arc;
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("FAKE_CLAUDE_MODE", "sleep");
        std::env::set_var("FAKE_SLEEP", "30");
        let slot: Arc<Mutex<Option<std::process::Child>>> = Arc::new(Mutex::new(None));
        let slot2 = slot.clone();
        let workdir = temp_workdir("cancel");
        let wd = workdir.clone();
        let handle = std::thread::spawn(move || {
            run_provider_cli(
                "claude-code", &fixture("fake-claude"), &wd,
                "S", "P", "", "", Duration::from_secs(30), &slot2,
            )
        });
        // Wait for the child to appear in the slot, then cancel it.
        for _ in 0..100 {
            if slot.lock().unwrap().is_some() { break; }
            std::thread::sleep(Duration::from_millis(20));
        }
        if let Some(mut child) = slot.lock().unwrap().take() {
            kill_child_tree(&mut child);
        }
        let err = handle.join().unwrap().unwrap_err();
        std::env::remove_var("FAKE_CLAUDE_MODE");
        std::env::remove_var("FAKE_SLEEP");
        let _ = fs::remove_dir_all(&workdir);
        assert!(err.starts_with("canceled:"), "{err}");
    }
}
