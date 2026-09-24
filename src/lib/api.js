// Guard `window` so modules importing this are loadable in Node (vitest)
const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined
const tauriInvoke = tauri?.core?.invoke ?? (() => Promise.resolve(null))
const tauriListen = tauri?.event?.listen ?? (() => Promise.resolve(() => {}))

export const API = {
  elevateNotchWindow: () => invoke('elevate_notch_window'),
  platform: navigator.platform.toLowerCase().includes('win') ? 'win32' : 'darwin',
  getConfig: () => tauriInvoke('get_config'),
  getNotchMetrics: () => tauriInvoke('get_notch_metrics'),
  setConfig: (patch) => tauriInvoke('set_config', { patch }),
  onConfigUpdate: (cb) => tauriListen('config-update', (e) => cb(e.payload)),
  getScripts: () => tauriInvoke('get_scripts'),
  saveScripts: (scripts) => tauriInvoke('save_scripts', { scripts }),
  setIgnoreMouse: (ignore) => tauriInvoke('set_ignore_mouse', { ignore }),
  resizePrompter: (dims) => tauriInvoke('resize_prompter', { dims }),
  resizeSettings: (dims) => tauriInvoke('resize_settings', { dims }),
  quit: () => tauriInvoke('quit_app'),
  openDevTools: () => tauriInvoke('open_devtools'),
  setMovable: (v) => tauriInvoke('set_movable', { movable: v }),
  moveWindow: (pos) => tauriInvoke('move_window', { pos }),
  getWindowPos: () => tauriInvoke('get_window_pos'),
  startDrag: () => tauriInvoke('start_drag'),
  onShortcut: (cb) => tauriListen('shortcut', (e) => cb(e.payload)),
  focusPrompter: () => tauriInvoke('focus_prompter'),
  startSpeech: (locale, scriptText, contextual, tricky) => tauriInvoke('start_speech', {
    locale,
    scriptText: scriptText ?? null,
    contextual: contextual ?? null,
    tricky: tricky ?? null,
  }),
  stopSpeech: () => tauriInvoke('stop_speech'),
  saveTrackingFixture: (json) => tauriInvoke('save_tracking_fixture', { json }),
  getSpeechStatus: () => tauriInvoke('get_speech_status'),
  onSpeechMsg: (cb) => tauriListen('speech-msg', (e) => cb(e.payload)),
  setSpeechNotice: (message) => tauriInvoke('set_speech_notice', { message }),
  getSpeechNotice: () => tauriInvoke('get_speech_notice'),
  onSpeechNotice: (cb) => tauriListen('speech-notice', (e) => cb(e.payload)),
  openSettings: () => tauriInvoke('open_settings'),
  // Screen-capture protection diagnostic (sharingType per window + config gate)
  captureDebug: () => tauriInvoke('capture_debug'),
  onCaptureDebug: (cb) => tauriListen('capture-debug', (e) => cb(e.payload)),
  aiComplete: (system, prompt, model, effort) => tauriInvoke('ai_complete', {
    system, prompt, model: model || null, effort: effort || null,
  }),
  aiTest: (cfg) => tauriInvoke('ai_test', { cfg }),
  setAiKey: (key) => tauriInvoke('set_ai_key', { key }),
  detectAiProvider: (provider) => tauriInvoke('detect_ai_provider', { provider }),
  aiCliPrepare: (provider, system, prompt, model, effort) => tauriInvoke('ai_cli_prepare', {
    provider, system, prompt, model: model || null, effort: effort || null, timeoutSecs: null,
  }),
  cancelAiCli: () => tauriInvoke('cancel_ai_cli'),
}
