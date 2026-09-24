import { useEffect, useRef, useState } from 'react'
import { EFFORT_LABELS, EFFORT_LEVELS, PROVIDER_ORDER, PROVIDERS } from '../lib/ai'
import { captureExcluded } from '../lib/capture'

const tauriInvoke = window.__TAURI__?.core?.invoke ?? (() => Promise.resolve(null))
const tauriListen = window.__TAURI__?.event?.listen ?? (() => Promise.resolve(() => {}))

const API = {
  getConfig:      () => tauriInvoke('get_config'),
  setConfig:      (patch) => tauriInvoke('set_config', { patch }),
  switchMode:     (mode) => tauriInvoke('switch_mode', { mode }),
  onConfigUpdate: (cb) => tauriListen('config-update', (e) => cb(e.payload)),
  togglePrompter: () => tauriInvoke('toggle_prompter'),
  resizeSettings: (dims) => tauriInvoke('resize_settings', { dims }),
  quit:           () => tauriInvoke('quit_app'),
  openDevTools:   () => tauriInvoke('open_devtools'),
  hideSettings:   () => tauriInvoke('hide_settings'),
  getSpeechStatus:() => tauriInvoke('get_speech_status'),
  onSpeechMsg:    (cb) => tauriListen('speech-msg', (e) => cb(e.payload)),
  getSpeechNotice:() => tauriInvoke('get_speech_notice'),
  onSpeechNotice: (cb) => tauriListen('speech-notice', (e) => cb(e.payload)),
  setAiKey:       (key) => tauriInvoke('set_ai_key', { key }),
  hasAiKey:       () => tauriInvoke('has_ai_key'),
  captureDebug:   () => tauriInvoke('capture_debug'),
  onCaptureDebug: (cb) => tauriListen('capture-debug', (e) => cb(e.payload)),
}

const AI_BADGE = {
  checking: 'Checking…',
  available: 'Available',
  not_installed: 'Not installed',
  not_logged_in: 'Not logged in',
  not_configured: 'No API key',
  not_running: 'Not running',
}

const POLICY_LINKS = [
  { label: 'Anthropic policy', url: 'https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan' },
  { label: 'OpenAI policy', url: 'https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan' },
]

function speechStatusText(v) {
  if (!v || !v.type) return ''
  switch (v.type) {
    case 'ready':      return `On-device recognition active (${v.locale || ''})`
    case 'starting':   return 'Speech engine starting…'
    case 'error':      return v.message || 'Speech recognition error'
    case 'terminated': return 'Speech engine stopped — voice-level fallback in use'
    case 'stopped':    return 'Idle — starts when you begin reading'
    default:           return ''
  }
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
const MIN_T = 0.003, MAX_T = 0.562
const sliderToThreshold = v => MIN_T * Math.pow(MAX_T / MIN_T, v / 100)
const thresholdToSlider = t => Math.round(Math.log(t / MIN_T) / Math.log(MAX_T / MIN_T) * 100)
const thresholdToDb = t => (20 * Math.log10(Math.max(t, 0.0001))).toFixed(0)
const isWin = navigator.userAgent.includes('Windows')

export default function SettingsView() {
  const [prompterVisible, setPrompterVisible] = useState(true)
  const [mode, setMode] = useState('notch')
  const [opacity, setOpacity] = useState(100)
  const [voiceInput, setVoiceInput] = useState(true)
  const [screenshare, setScreenshare] = useState(false)
  const [captureStatus, setCaptureStatus] = useState(null)  // live sharingType snapshot
  const [theme, setTheme] = useState('dark')
  const [speedIdx, setSpeedIdx] = useState(3)
  const [threshold, setThreshold] = useState(0.018)
  const [thresholdSlider, setThresholdSlider] = useState(24)
  const [mics, setMics] = useState([{ deviceId: 'default', label: 'Default microphone' }])
  const [micId, setMicId] = useState('default')
  const [wordTracking, setWordTracking] = useState(true)
  const [coasting, setCoasting] = useState(true)
  const [trackingHints, setTrackingHints] = useState('')
  const [speechStatus, setSpeechStatus] = useState(null)
  const [speechNotice, setSpeechNotice] = useState('')
  const [aiProvider, setAiProvider] = useState('')
  const [aiPrefs, setAiPrefs] = useState({})
  const [aiDetect, setAiDetect] = useState({})
  const [aiModel, setAiModel] = useState('') // legacy single-model field (fallback)
  const [aiLocalUrl, setAiLocalUrl] = useState('http://localhost:11434')
  const [aiKeyInput, setAiKeyInput] = useState('')
  const [hasAiKey, setHasAiKey] = useState(false)
  const [customModel, setCustomModel] = useState(false)
  const [meterPct, setMeterPct] = useState(0)
  const [meterActive, setMeterActive] = useState(false)

  const panelRef = useRef(null)
  const meterStreamRef = useRef(null)
  const meterIntervalRef = useRef(null)

  // Auto-resize window to panel height
  useEffect(() => {
    if (!panelRef.current) return
    const ro = new ResizeObserver(() => {
      const h = panelRef.current.getBoundingClientRect().height
      API.resizeSettings({ height: Math.ceil(h) + 2 })
    })
    ro.observe(panelRef.current)
    return () => ro.disconnect()
  }, [])

  // Load config + mics on mount
  useEffect(() => {
    // Demo/test hook (scripts/snap.mjs): ?theme= forces the panel theme.
    // Params are never present in normal operation.
    const forcedTheme = new URLSearchParams(window.location.search).get('theme')
    if (forcedTheme) {
      setTheme(forcedTheme)
      document.documentElement.setAttribute('data-theme', forcedTheme)
    }

    API.getConfig().then(cfg => {
      if (cfg) {
        applyConfig(cfg)
        document.documentElement.setAttribute('data-theme', cfg.theme || 'dark')
      }
    })
    populateMics()
    startMeter()

    API.onConfigUpdate(applyConfig)

    // Speech engine status — initial value plus live updates (state changes
    // only; partial transcripts are not status)
    API.getSpeechStatus().then(v => { if (v) setSpeechStatus(v) })
    // Prompter-side advisory (script/recognition language mismatch)
    API.getSpeechNotice().then(v => setSpeechNotice(v || ''))
    API.onSpeechNotice(v => setSpeechNotice(v || ''))
    API.hasAiKey().then(v => setHasAiKey(!!v))
    refreshAiDetection()
    // Screen-capture protection status — initial read plus live updates pushed
    // by the backend after it (re-)applies protection.
    API.captureDebug().then(v => { if (v) setCaptureStatus(v) })
    API.onCaptureDebug(v => { if (v) setCaptureStatus(v) })
    API.onSpeechMsg(v => {
      if (!v || !v.type) return
      if (v.type === 'partial' || v.type === 'final') return
      if (v.type === 'error' && !v.fatal) return
      setSpeechStatus(v)
    })

    const handler = (e) => {
      if (e.metaKey && e.altKey && e.code === 'KeyI') API.openDevTools()
    }
    document.addEventListener('keydown', handler)

    const onBlur = () => {
      setTimeout(() => { if (!document.hasFocus()) API.hideSettings() }, 150)
    }
    window.addEventListener('blur', onBlur)

    return () => {
      document.removeEventListener('keydown', handler)
      window.removeEventListener('blur', onBlur)
      stopMeter()
    }
  }, [])

  function applyConfig(c) {
    if (c.mode)         setMode(c.mode)
    if (c.opacity != null) setOpacity(Math.round(c.opacity * 100))
    if (c.autoScroll != null) setVoiceInput(!c.autoScroll)
    if (c.screenshareHidden != null) setScreenshare(!!c.screenshareHidden)
    if (c.theme) {
      setTheme(c.theme)
      document.documentElement.setAttribute('data-theme', c.theme)
    }
    if (c.scrollSpeed != null) {
      const i = SPEEDS.indexOf(c.scrollSpeed)
      setSpeedIdx(i !== -1 ? i : 3)
    }
    if (c.threshold != null) {
      setThreshold(c.threshold)
      setThresholdSlider(thresholdToSlider(c.threshold))
    }
    if (c.micDeviceId)  setMicId(c.micDeviceId)
    if (c.wordTracking != null) setWordTracking(!!c.wordTracking)
    if (c.coasting != null) setCoasting(!!c.coasting)
    if (c.trackingHints !== undefined) setTrackingHints(c.trackingHints)
    if (c.aiProvider !== undefined) setAiProvider(c.aiProvider)
    if (c.aiPrefs && typeof c.aiPrefs === 'object') setAiPrefs(c.aiPrefs)
    if (c.aiModel !== undefined)    setAiModel(c.aiModel)
    if (c.aiLocalUrl)   setAiLocalUrl(c.aiLocalUrl)
  }

  // Live provider detection for the badges (CLIs, key, local server)
  function refreshAiDetection() {
    for (const id of PROVIDER_ORDER) {
      setAiDetect(d => ({ ...d, [id]: { state: 'checking' } }))
      PROVIDERS[id].detect().then(res =>
        setAiDetect(d => ({ ...d, [id]: res || { state: 'error' } })))
    }
  }

  async function populateMics() {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true })
      tmp.getTracks().forEach(t => t.stop())
      const devices = await navigator.mediaDevices.enumerateDevices()
      const found = devices.filter(d => d.kind === 'audioinput').map(d => ({
        deviceId: d.deviceId,
        label: d.label || `Microphone (${d.deviceId.slice(0, 8)})`,
      }))
      if (found.length) setMics(found)
    } catch(e) {}
  }

  async function startMeter() {
    if (meterStreamRef.current) return
    try {
      meterStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      ctx.createMediaStreamSource(meterStreamRef.current).connect(analyser)
      const data = new Float32Array(analyser.fftSize)
      meterIntervalRef.current = setInterval(() => {
        analyser.getFloatTimeDomainData(data)
        let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        const rms = Math.sqrt(sum / data.length)
        const db = rms > 0 ? 20 * Math.log10(rms) : -100
        const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100))
        setMeterPct(pct)
        setMeterActive(rms > sliderToThreshold(thresholdSlider))
      }, 32)
    } catch(e) {}
  }

  function stopMeter() {
    if (meterIntervalRef.current) { clearInterval(meterIntervalRef.current); meterIntervalRef.current = null }
    if (meterStreamRef.current) { meterStreamRef.current.getTracks().forEach(t => t.stop()); meterStreamRef.current = null }
    setMeterPct(0)
    setMeterActive(false)
  }

  async function handlePrompterToggle(checked) {
    const isVisible = await API.togglePrompter()
    setPrompterVisible(isVisible)
    if (isVisible) startMeter(); else stopMeter()
  }

  function handleMode(m) {
    setMode(m)
    API.switchMode(m)
  }

  function handleOpacity(v) {
    setOpacity(v)
    API.setConfig({ opacity: v / 100 })
  }

  function handleVoiceInput(checked) {
    setVoiceInput(checked)
    API.setConfig({ autoScroll: !checked })
  }

  function handleScreenshare(checked) {
    setScreenshare(checked)
    API.setConfig({ screenshareHidden: checked })
  }

  function handleTheme(checked) {
    const t = checked ? 'light' : 'dark'
    setTheme(t)
    API.setConfig({ theme: t })
  }

  function handleSpeed(v) {
    setSpeedIdx(v)
    API.setConfig({ scrollSpeed: SPEEDS[v] })
  }

  function handleThresholdSlider(v) {
    const t = sliderToThreshold(v)
    setThresholdSlider(v)
    setThreshold(t)
    API.setConfig({ threshold: t })
  }

  function handleMic(deviceId) {
    setMicId(deviceId)
    API.setConfig({ micDeviceId: deviceId })
  }

  function handleCoasting(checked) {
    setCoasting(checked)
    API.setConfig({ coasting: checked })
  }

  function handleWordTracking(checked) {
    setWordTracking(checked)
    API.setConfig({ wordTracking: checked })
  }

  function handleAiProvider(id) {
    setAiProvider(id)
    setCustomModel(false)
    API.setConfig({ aiProvider: id })
  }

  // Per-provider model/effort, persisted as one aiPrefs object.
  function prefFor(p) {
    const base = aiPrefs[p] || {}
    // Legacy fallback: pre-2.1 configs stored one model in aiModel.
    if (base.model === undefined && aiModel && (p === 'anthropic-api' || p === 'ollama')) {
      return { ...base, model: aiModel }
    }
    return base
  }

  function setPref(p, patch) {
    const next = { ...aiPrefs, [p]: { ...prefFor(p), ...patch } }
    setAiPrefs(next)
    API.setConfig({ aiPrefs: next })
  }

  async function handleSaveAiKey() {
    if (!aiKeyInput.trim()) return
    await API.setAiKey(aiKeyInput.trim())
    setAiKeyInput('')
    setHasAiKey(true)
  }

  async function handleClearAiKey() {
    await API.setAiKey('')
    setHasAiKey(false)
  }

  const thresholdPct = thresholdSlider + '%'

  return (
    <div id="panel" ref={panelRef}>
      {/* Header */}
      <div className="s-header">
        <span className="s-title">✦ Teleprompter</span>
        <button className="s-quit" onClick={() => API.quit()}>Quit</button>
      </div>

      <div className="s-body">
        {/* Show Prompter */}
        <Row label="Show Prompter">
          <Toggle checked={prompterVisible} onChange={handlePrompterToggle} />
        </Row>

        {prompterVisible && <>
          <Divider />

          {/* Style — hidden on Windows */}
          {!isWin && <>
            <Row label="Style">
              <div className="s-mode-group">
                {['notch','classic'].map(m => (
                  <button
                    key={m}
                    className={`s-mode-btn${mode === m ? ' active' : ''}`}
                    onClick={() => handleMode(m)}
                  >{m.charAt(0).toUpperCase() + m.slice(1)}</button>
                ))}
              </div>
            </Row>
            <Divider />
          </>}

          {/* Opacity */}
          <Row label="Opacity" val={opacity + '%'}>
            <input type="range" className="s-slider" min="20" max="100" step="5"
              value={opacity} onChange={e => handleOpacity(+e.target.value)} />
          </Row>

          <Divider />

          {/* Voice Input */}
          <Row label="Voice Input">
            <Toggle checked={voiceInput} onChange={handleVoiceInput} />
          </Row>

          <Divider />

          {/* Word Tracking (speech recognition) */}
          <Row label="Word Tracking">
            <Toggle checked={wordTracking} onChange={handleWordTracking} />
          </Row>
          {wordTracking && <>
            {speechNotice && (
              <div className="s-row">
                <span className="s-status error">{speechNotice}</span>
              </div>
            )}
            {speechStatusText(speechStatus) && (
              <div className="s-row">
                <span className={`s-status${speechStatus?.type === 'error' || speechStatus?.type === 'terminated' ? ' error' : ''}`}>
                  {speechStatusText(speechStatus)}
                </span>
              </div>
            )}
            <div className="s-row s-col">
              <span className="s-label">Tricky words</span>
              <textarea
                className="s-input s-textarea"
                rows={2}
                placeholder={'names the recognizer misses, one per line'}
                value={trackingHints}
                onChange={e => setTrackingHints(e.target.value)}
                onBlur={() => API.setConfig({ trackingHints })}
                spellCheck={false}
              />
              <span className="s-note">
                Boosts recognition of proper nouns and jargon while reading.
                Optional pronunciation: word=phonemes (X-SAMPA). Takes effect
                at the next reading session.
              </span>
            </div>
            <Row label="Coasting">
              <Toggle checked={coasting} onChange={handleCoasting} />
            </Row>
            <div className="s-row">
              <span className="s-note">
                Keeps the highlight moving at your reading pace during brief
                recognizer lags, so it never freezes while you speak. Display
                only — it never affects where tracking has confirmed.
              </span>
            </div>
            <div className="s-row">
              <span className="s-note">
                Speech recognition runs entirely on-device (Apple Speech framework).
                No audio or transcripts ever leave your Mac. If recognition is
                unavailable, the prompter falls back to voice-level detection.
              </span>
            </div>
          </>}

          <Divider />

          {/* Hide on screen share */}
          <Row label="Hide on screen share">
            <Toggle checked={screenshare} onChange={handleScreenshare} />
          </Row>
          {/* Live runtime status from the backend's actual NSWindow.sharingType
              check (not just the config value) — deliverable 4. */}
          {(() => {
            const on = captureExcluded(captureStatus, screenshare)
            return (
              <div style={{ padding: '2px 2px 0' }}>
                <span className={on ? 's-note' : 's-status error'}>
                  {on
                    ? 'Excluded from screen capture: on'
                    : 'Excluded from screen capture: off — visible to Zoom, Meet, recordings'}
                </span>
              </div>
            )
          })()}

          <Divider />

          {/* Light Theme */}
          <Row label="Light Theme">
            <Toggle checked={theme === 'light'} onChange={handleTheme} />
          </Row>

          <Divider />

          {/* Microphone */}
          <div className="s-row s-col">
            <span className="s-label">Microphone</span>
            <select className="s-select" value={micId} onChange={e => handleMic(e.target.value)}>
              {mics.map(m => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
            </select>
          </div>

          <Divider />

          {/* Scroll Speed */}
          <Row label="Scroll Speed" val={SPEEDS[speedIdx] + '×'}>
            <input type="range" className="s-slider" min="0" max="7" step="1"
              value={speedIdx} onChange={e => handleSpeed(+e.target.value)} />
          </Row>

          <Divider />

          {/* Voice Sensitivity */}
          <Row label="Voice Sensitivity" val={thresholdToDb(threshold) + ' dB'}>
            <div className="s-meter">
              <div className="s-meter-fill" style={{ width: meterPct.toFixed(1) + '%', background: meterActive ? '#22c55e' : 'rgba(255,255,255,0.15)' }} />
              <div className="s-meter-mark" style={{ left: thresholdPct }} />
            </div>
            <input type="range" className="s-slider" min="0" max="100" step="1"
              value={thresholdSlider} onChange={e => handleThresholdSlider(+e.target.value)} />
          </Row>

          <Divider />

          {/* Prepare with AI — provider list with live detection badges */}
          <div className="s-row s-col">
            <div className="s-provider-head">
              <span className="s-label">Prepare with AI</span>
              <button className="s-mode-btn" onClick={refreshAiDetection} title="Re-run provider detection">↻</button>
            </div>
            <div className="s-provider-list">
              <button
                className={`s-provider${aiProvider === '' ? ' active' : ''}`}
                onClick={() => handleAiProvider('')}
              >
                <span className="s-provider-name">Off</span>
              </button>
              {PROVIDER_ORDER.map(id => {
                const det = aiDetect[id] || {}
                const ok = det.state === 'available'
                return (
                  <button
                    key={id}
                    className={`s-provider${aiProvider === id ? ' active' : ''}`}
                    onClick={() => handleAiProvider(id)}
                  >
                    <span className="s-provider-name">{PROVIDERS[id].label}</span>
                    <span className={`s-badge ${ok ? 'ok' : 'warn'}`}>{AI_BADGE[det.state] || '…'}</span>
                    {!ok && PROVIDERS[id].instructions?.[det.state] && (
                      <span className="s-provider-hint">{PROVIDERS[id].instructions[det.state]}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Unified model + effort selector, persisted per provider */}
          {aiProvider && PROVIDERS[aiProvider] && (() => {
            const def = PROVIDERS[aiProvider]
            const prefs = prefFor(aiProvider)
            const models = def.listModels()
            const inList = models.includes(prefs.model || '')
            const showCustom = customModel || (!inList && (prefs.model || '') !== '') || models.length === 0
            const effortOk = def.supportsEffort(prefs.model)
            return (<>
              <div className="s-row s-col">
                <span className="s-label">Model</span>
                {!showCustom ? (
                  <select
                    className="s-select"
                    value={prefs.model || ''}
                    onChange={e => {
                      if (e.target.value === '__custom__') setCustomModel(true)
                      else setPref(aiProvider, { model: e.target.value })
                    }}
                  >
                    {models.map(m => <option key={m || 'default'} value={m}>{m === '' ? 'Default' : m}</option>)}
                    <option value="__custom__">Custom…</option>
                  </select>
                ) : (
                  <input
                    className="s-input"
                    placeholder={aiProvider === 'ollama' ? 'llama3.1 (required)' : 'model name — empty for default'}
                    value={prefs.model || ''}
                    onChange={e => setPref(aiProvider, { model: e.target.value })}
                  />
                )}
              </div>
              <div className="s-row s-col">
                <span className="s-label">Effort</span>
                <div
                  className="s-mode-group s-effort-group"
                  title={effortOk ? 'Higher effort thinks longer and costs more of your plan or budget' : `${def.label} does not take an effort setting — requests run at the provider's default`}
                >
                  {EFFORT_LEVELS.map(l => (
                    <button
                      key={l}
                      disabled={!effortOk}
                      className={`s-mode-btn${(prefs.effort || '') === l ? ' active' : ''}`}
                      onClick={() => setPref(aiProvider, { effort: prefs.effort === l ? '' : l })}
                    >{EFFORT_LABELS[l]}</button>
                  ))}
                </div>
                {!effortOk && (
                  <span className="s-note">
                    {aiProvider === 'ollama'
                      ? 'Local models do not take an effort setting.'
                      : 'This model does not take an effort setting.'}
                  </span>
                )}
              </div>
            </>)
          })()}

          {aiProvider === 'anthropic-api' && (
            <div className="s-row s-col">
              <span className="s-label">API Key{hasAiKey ? ' · saved in Keychain ✓' : ''}</span>
              <div className="s-key-row">
                <input
                  className="s-input"
                  type="password"
                  placeholder={hasAiKey ? '••••••••••••••••' : 'sk-ant-…'}
                  value={aiKeyInput}
                  onChange={e => setAiKeyInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveAiKey() }}
                />
                {aiKeyInput.trim()
                  ? <button className="s-mode-btn active" onClick={handleSaveAiKey}>Save</button>
                  : hasAiKey && <button className="s-mode-btn" onClick={handleClearAiKey}>Clear</button>}
              </div>
              <span className="s-note">
                Stored in the macOS Keychain — never in config files. Get a key
                at console.anthropic.com.
              </span>
            </div>
          )}
          {aiProvider === 'ollama' && (
            <div className="s-row s-col">
              <span className="s-label">Server URL</span>
              <input
                className="s-input"
                placeholder="http://localhost:11434"
                value={aiLocalUrl}
                onChange={e => setAiLocalUrl(e.target.value)}
                onBlur={() => API.setConfig({ aiLocalUrl: aiLocalUrl.trim() })}
              />
              <span className="s-note">
                Any OpenAI-compatible server, e.g. Ollama (`ollama serve`, then
                `ollama pull` a model). Runs fully offline.
              </span>
            </div>
          )}
          {aiProvider !== '' && (
            <div className="s-row">
              <span className="s-note">
                Your script text is sent to the selected provider for rewriting
                — only when you click ✦ Prepare, never automatically.
                Subscription providers run through the official CLI on your own
                plan's usage limits. Vendor policies on subscription use in
                third-party apps changed several times in 2026 and may change
                again: see{' '}
                <a href="#" onClick={e => { e.preventDefault(); tauriInvoke('open_url', { url: POLICY_LINKS[0].url }) }}>
                  {POLICY_LINKS[0].label}
                </a>{' '}and{' '}
                <a href="#" onClick={e => { e.preventDefault(); tauriInvoke('open_url', { url: POLICY_LINKS[1].url }) }}>
                  {POLICY_LINKS[1].label}
                </a>.
              </span>
            </div>
          )}

          <Divider />

          {/* Shortcuts */}
          <Shortcut label="Pause / Resume"   keys="⌘⇧Space" />
          <Shortcut label="Speed Up / Down"  keys="⌘⇧↑↓" />
          <Shortcut label="Reset to Top"     keys="⌘⇧R" />
          <Shortcut label="Open Editor"      keys="⌘⇧E" />
          <Shortcut label="Save Script"      keys="⌘S" />
        </>}

        <Divider />

        {/* Author */}
        <div className="s-author">
          <div>
            <div className="s-built-by">Built by</div>
            <div className="s-name">Arun Kumar</div>
          </div>
          <a
            className="s-github"
            href="#"
            onClick={e => { e.preventDefault(); tauriInvoke('open_url', { url: 'https://github.com/ArunNGun/openTeleprompt' }) }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
            ArunNGun
          </a>
        </div>
      </div>
    </div>
  )
}

function Row({ label, val, children }) {
  return (
    <div className={`s-row${val !== undefined ? ' s-slider-row' : ''}`}>
      <div className="s-row-top">
        <span className="s-label">{label}</span>
        {val && <span className="s-val">{val}</span>}
        {!val && children}
      </div>
      {val && <div className="s-row-control">{children}</div>}
    </div>
  )
}

function Toggle({ checked, onChange }) {
  return (
    <label className="s-switch">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="s-sw" />
    </label>
  )
}

function Divider() { return <div className="s-divider" /> }

function Shortcut({ label, keys }) {
  return (
    <div className="s-shortcut">
      <span className="s-sc-label">{label}</span>
      <span className="s-sc-key">{keys}</span>
    </div>
  )
}
