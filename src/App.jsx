import { useEffect, useRef, useState } from 'react'
import { useAppStore } from './store'
import { API } from './lib/api'
import IdleView from './views/IdleView'
import EditView from './views/EditView'
import ReadView from './views/ReadView'

// Island sizes — 20px side + bottom bleed so box-shadow renders fully.
// The idle pill matches the physical notch (runtime metrics from NSScreen via
// get_notch_metrics); the fallback 200×35 keeps browser tests and non-notch
// displays on the previous fixed geometry. Window = island + slack so the
// CSS-centered island never clips.
const SB = 20
const BB = 20
export function islandSizes(notch) {
  const nw = notch?.width ?? 200
  const nh = notch?.height ?? 35
  return {
    // 14pt slack (even, so window x = centerX − w/2 stays integral and the
    // CSS-centered island lands exactly on the notch — no half-point shift)
    idle:      { w: nw + 14,      h: nh + 3   },
    idleHover: { w: nw + 36,      h: nh + 13  },
    edit:      { w: 560 + SB * 2, h: 340 + BB },
    read:      { w: 440 + SB * 2, h: 205 + BB },
  }
}
// Classic: window = island size exactly, OS handles shadow
const CLASSIC_SIZES = {
  idle:      { w: 240, h: 80  },
  idleHover: { w: 260, h: 88  },
  edit:      { w: 580, h: 360 },
  read:      { w: 460, h: 240 },
}

// Sample script for browser-only visual tests (?view=read): exercises
// word rendering plus cue markers
const DEMO_DOC = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Welcome to the AI Teleprompter demo.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Our launch goes live today [PAUSE] stay tuned.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Take a breath [BREATHE] and keep a calm, even pace.' }] },
  ],
}

export default function App() {
  const { view, config, setConfig, setScripts, setView, setScriptDoc, setScriptText, setCurrentScriptIndex } = useAppStore()
  // ?hoverdemo=1 (demo/test hook) starts the pill in its hover state.
  // Params are only ever present via the snapshot harness (browser) or the
  // dev-only TELEPROMPTER_DEMO_PARAMS env var (screenshot captures in Tauri).
  const [isHovered, setIsHovered] = useState(() =>
    new URLSearchParams(window.location.search).has('hoverdemo'))
  // Physical notch geometry (null = no notch / browser: fixed fallback sizes)
  const [notch, setNotch] = useState(null)
  const isClassic = config.mode === 'classic'

  // ── Bootstrap ──────────────────────────────────────────────
  useEffect(() => {
    // Load config
    API.getConfig().then((cfg) => {
      if (!cfg) return
      setConfig({
        mode:        cfg.mode        ?? 'notch',
        theme:       cfg.theme       ?? 'dark',
        scrollSpeed: cfg.scrollSpeed ?? cfg.scroll_speed ?? 1,
        fontSize:    cfg.fontSize    ?? cfg.font_size    ?? 16,
        opacity:     cfg.opacity     ?? 1,
        threshold:   cfg.threshold   ?? 0.018,
        autoScroll:  cfg.autoScroll  ?? cfg.auto_scroll  ?? false,
        micDeviceId: cfg.micDeviceId ?? cfg.mic_device_id ?? 'default',
        wordTracking: cfg.wordTracking ?? cfg.word_tracking ?? true,
        trackingHints: cfg.trackingHints ?? cfg.tracking_hints ?? '',
        aiProvider:   cfg.aiProvider   ?? cfg.ai_provider   ?? '',
        aiModel:      cfg.aiModel      ?? cfg.ai_model      ?? '',
        aiLocalUrl:   cfg.aiLocalUrl   ?? cfg.ai_local_url  ?? 'http://localhost:11434',
      })
      API.setIgnoreMouse(false)
    })

    // Physical notch metrics — the collapsed pill matches the notch exactly
    // (width, height, x-position); CSS reads the same values via vars.
    API.getNotchMetrics().then((m) => {
      if (!m?.hasNotch) return
      setNotch(m)
      document.documentElement.style.setProperty('--notch-w', `${m.width}px`)
      document.documentElement.style.setProperty('--notch-h', `${m.height}px`)
    })

    // Load scripts — skipped when a URL demo param drives the view, so
    // screenshot captures never show the real script library
    const demoView = new URLSearchParams(window.location.search).get('view')
    if (!demoView) API.getScripts().then((s) => { if (s) setScripts(s) })

    // Live config updates from settings window
    API.onConfigUpdate((cfg) => {
      if (!cfg) return
      const patch = {}
      const keys = ['mode','theme','scrollSpeed','scroll_speed','opacity','threshold',
                    'autoScroll','auto_scroll','micDeviceId','mic_device_id','fontSize','font_size',
                    'wordTracking','word_tracking','trackingHints','tracking_hints',
                    'aiProvider','ai_provider','aiModel','ai_model','aiLocalUrl','ai_local_url']
      keys.forEach(k => { if (cfg[k] !== undefined) patch[k] = cfg[k] })
      // Normalise snake_case → camelCase
      if (patch.scroll_speed  !== undefined) { patch.scrollSpeed  = patch.scroll_speed;  delete patch.scroll_speed }
      if (patch.auto_scroll   !== undefined) { patch.autoScroll   = patch.auto_scroll;   delete patch.auto_scroll  }
      if (patch.mic_device_id !== undefined) { patch.micDeviceId  = patch.mic_device_id; delete patch.mic_device_id }
      if (patch.font_size     !== undefined) { patch.fontSize     = patch.font_size;     delete patch.font_size     }
      if (patch.word_tracking !== undefined) { patch.wordTracking = patch.word_tracking; delete patch.word_tracking }
      if (patch.tracking_hints !== undefined) { patch.trackingHints = patch.tracking_hints; delete patch.tracking_hints }
      if (patch.ai_provider   !== undefined) { patch.aiProvider   = patch.ai_provider;   delete patch.ai_provider   }
      if (patch.ai_model      !== undefined) { patch.aiModel      = patch.ai_model;      delete patch.ai_model      }
      if (patch.ai_local_url  !== undefined) { patch.aiLocalUrl   = patch.ai_local_url;  delete patch.ai_local_url  }
      if (Object.keys(patch).length) setConfig(patch)
    })

    // Global shortcut ⌘⇧E: open the script editor (explicit user action).
    // Read-mode shortcuts are handled in ReadView; this one is app-level so
    // it works from the idle pill.
    API.onShortcut((action) => {
      if (action === 'edit' && useAppStore.getState().view === 'idle') {
        setView('edit')
      }
    })

    // Probe mic permission once so browser doesn't ask mid-session
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then(s => s.getTracks().forEach(t => t.stop()))
      .catch(() => {})

    // Demo/test hooks: drive view/mode/theme via URL params, e.g.
    // /?view=read&mode=notch&theme=light. Used by scripts/snap.mjs (browser)
    // and TELEPROMPTER_DEMO_PARAMS (dev-only, Tauri screenshot captures).
    // Normal launches carry no params, so this is inert in production.
    {
      const q = new URLSearchParams(window.location.search)
      const patch = {}
      if (q.get('mode')) patch.mode = q.get('mode')
      if (q.get('theme')) patch.theme = q.get('theme')
      if (Object.keys(patch).length) setConfig(patch)
      const v = q.get('view')
      if (v === 'read') {
        setScriptDoc(DEMO_DOC)
        setScriptText('Welcome to the AI Teleprompter demo.')
      }
      if (v === 'edit') {
        // ?scrolldemo=1 pads the doc so the editor overflows — used to verify
        // overlay scrollbar rendering in the real app
        const doc = q.has('scrolldemo')
          ? { ...DEMO_DOC, content: [...DEMO_DOC.content, ...Array.from({ length: 24 }, (_, i) => (
              { type: 'paragraph', content: [{ type: 'text', text: `Filler line ${i + 1} so the script overflows the editor.` }] }
            ))] }
          : DEMO_DOC
        setScripts([
          { name: 'Product Demo', text: 'Welcome to the AI Teleprompter demo.', content: JSON.stringify(doc) },
          { name: 'Launch Notes', text: '', content: JSON.stringify(doc) },
        ])
        setCurrentScriptIndex(0)
      }
      if (v) setView(v)
    }
  }, [])

  // ── Side-effects from config ───────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', config.theme || 'dark')
  }, [config.theme])

  useEffect(() => {
    document.body.classList.toggle('mode-classic', isClassic)
    API.setIgnoreMouse(false)
  }, [config.mode])

  useEffect(() => {
    document.documentElement.style.opacity = config.opacity ?? 1
  }, [config.opacity])

  // ── Window resize ──────────────────────────────────────────
  useEffect(() => {
    const sizes = isClassic ? CLASSIC_SIZES : islandSizes(notch)
    const size  = view === 'edit' ? sizes.edit
                : view === 'read' ? sizes.read
                : isHovered       ? sizes.idleHover
                : sizes.idle
    API.resizePrompter({ width: size.w, height: size.h })
  }, [view, isHovered, config.mode, notch])

  // ── Event handlers ─────────────────────────────────────────
  function handleMouseEnter() {
    setIsHovered(true)
    if (!isClassic) API.focusPrompter()
  }
  function handleMouseLeave() { setIsHovered(false) }
  function handleMouseDown(e) {
    if (!isClassic) return
    if (e.target.closest('button, input, textarea, select, svg')) return
    e.preventDefault()
    API.startDrag()
  }

  // ── Derived render values ──────────────────────────────────
  const isExpanded   = !isClassic && (view === 'edit' || view === 'read')
  const islandW      = view === 'edit' ? 560 : view === 'read' ? 440 : 0
  const cornerLeft   = isExpanded ? `calc(50% - ${islandW / 2}px - 20px)` : '0'
  const cornerRight  = isExpanded ? `calc(50% + ${islandW / 2}px)` : '0'
  const islandClass  = [
    isClassic       ? 'mode-classic' : '',
    view === 'edit' ? 'state-edit'   : '',
    view === 'read' ? 'state-read'   : '',
  ].filter(Boolean).join(' ')

  const isBrowser = !window.__TAURI__

  return (
    <>
      {/* Concave anti-notch corners (notch mode only) */}
      <div className={`notch-corner notch-corner-left${isExpanded ? ' visible' : ''}`}  style={{ left: cornerLeft }} />
      <div className={`notch-corner notch-corner-right${isExpanded ? ' visible' : ''}`} style={{ left: cornerRight }} />

      <div
        id="island"
        className={islandClass}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleMouseDown}
      >
        {view === 'idle' && <IdleView isHovered={isHovered} />}
        {view === 'edit' && <EditView />}
        {view === 'read' && <ReadView />}
      </div>

      {/* Dev panel — browser only, hidden in Tauri */}
      {isBrowser && (
        <div id="dev-panel">
          <div className="dev-label">DEV</div>
          <div className="dev-row">
            <span>View</span>
            <select value={view} onChange={e => setView(e.target.value)}>
              <option value="idle">Idle</option>
              <option value="edit">Edit</option>
              <option value="read">Read</option>
            </select>
          </div>
          <div className="dev-row">
            <span>Mode</span>
            <select value={config.mode || 'notch'} onChange={e => setConfig({ mode: e.target.value })}>
              <option value="notch">Notch</option>
              <option value="classic">Classic</option>
            </select>
          </div>
          <div className="dev-row">
            <span>Theme</span>
            <select value={config.theme || 'dark'} onChange={e => setConfig({ theme: e.target.value })}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
        </div>
      )}
    </>
  )
}
