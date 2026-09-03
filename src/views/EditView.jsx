import { useEffect, useRef, useState, useCallback } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import { useAppStore } from '../store'
import { API } from '../lib/api'
import { describePrepareTarget, mapAiError, preparedTextToDoc, prepareScript } from '../lib/ai'
import { sanitizeDocColors } from '../lib/tokenizer'
import AiSetupPanel from './AiSetupPanel'

const COLORS = [
  { label: 'Yellow', value: '#facc15' },
  { label: 'Green',  value: '#4ade80' },
  { label: 'Blue',   value: '#60a5fa' },
  { label: 'Red',    value: '#f87171' },
]
const MARKERS = ['[PAUSE]', '[SLOW]', '[BREATHE]']
const AUTOSAVE_MS = 800

// Demo/test sessions (?view=… via scripts/snap.mjs or the dev-only
// TELEPROMPTER_DEMO_PARAMS hook) run on a seeded in-memory library — they
// must never write the user's real one. Demo navigation is a full page
// reload, so the params are present at import time.
const IS_DEMO_SESSION = new URLSearchParams(window.location.search).has('view')

function computeStats(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  if (!words) return ''
  const secs = Math.round((words / 130) * 60)
  const timeStr = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${words} words · ~${timeStr} at 130 WPM`
}

export default function EditView() {
  const {
    setView, scripts, setScripts,
    currentScriptIndex, setCurrentScriptIndex,
    setScriptText, setScriptDoc, config,
  } = useAppStore()

  const isClassic = config?.mode === 'classic'
  const [stats, setStats] = useState('')
  // 'idle' → nothing shown; 'saved' → subtle indicator, cleared on next edit
  const [saveState, setSaveState] = useState('idle')
  // 'cue' | 'format' | null — the open footer menu
  const [openMenu, setOpenMenu] = useState(null)
  // Prepare-with-AI state: explicit user action only, never automatic.
  // aiBusy is falsy when idle, else the provider/model/effort description.
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [review, setReview] = useState(null) // { originalDoc, originalText, prepared }
  // Guided one-time provider setup (?aisetup=1 is the snapshot demo hook)
  const [setupOpen, setSetupOpen] = useState(() =>
    new URLSearchParams(window.location.search).has('aisetup'))

  const autosaveTimer = useRef(null)
  const saveRef = useRef(() => {})

  const editor = useEditor({
    extensions: [StarterKit, TextStyle, Color],
    content: '<p></p>',
    editorProps: {
      attributes: { class: 'tiptap-editor', spellcheck: 'true' },
    },
    onUpdate({ editor }) {
      setStats(computeStats(editor.getText()))
      // Autosave: debounce on edit; the indicator resets while typing
      setSaveState('idle')
      clearTimeout(autosaveTimer.current)
      autosaveTimer.current = setTimeout(() => saveRef.current(), AUTOSAVE_MS)
    },
  })

  // Demo/test hook (snap.mjs + TELEPROMPTER_DEMO_PARAMS): ?aireview=1 renders
  // the Prepare-with-AI review panel with fixed sample content
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('aireview')) return
    const originalText =
      'Hello everyone, today I want to give you an update on our project. ' +
      'Over the past six months the team has finished building the core features and we are right on track for launch.'
    setReview({
      originalDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: originalText }] }] },
      originalText,
      prepared:
        'Hello everyone [PAUSE]\ntoday I want to give you\nan update on our project\n\n' +
        'over the past six months [SLOW]\nthe team has finished building\nthe core features\nand we are right on track for launch',
    })
  }, [])

  // Load script when editor is ready. Loading is not an edit: Tiptap v3's
  // setContent emits an update by default, which would arm the autosave and
  // immediately rewrite the library with what was just read from it — so
  // both load paths suppress the update event.
  useEffect(() => {
    if (!editor) return
    const script = scripts[currentScriptIndex]
    if (!script) return
    try {
      editor.commands.setContent(sanitizeDocColors(JSON.parse(script.content)), { emitUpdate: false })
    } catch {
      editor.commands.setContent(`<p>${script.text || ''}</p>`, { emitUpdate: false })
    }
    setStats(computeStats(script.text || ''))
    setSaveState('idle')
  }, [editor])

  const saveCurrentScript = useCallback(() => {
    if (!editor) return
    const text = editor.getText().trim()
    if (!text) return
    const name = text.split('\n')[0].substring(0, 40) || 'Untitled'
    const content = JSON.stringify(editor.getJSON())
    const updated = [...scripts]
    if (currentScriptIndex >= 0) {
      updated[currentScriptIndex] = { ...updated[currentScriptIndex], name, text, content }
    } else {
      updated.unshift({ name, text, content })
      setCurrentScriptIndex(0)
    }
    setScripts(updated)
    if (!IS_DEMO_SESSION) API.saveScripts(updated)
    setSaveState('saved')
  }, [editor, scripts, currentScriptIndex])

  // Keep the debounced autosave pointed at the latest save closure
  useEffect(() => { saveRef.current = saveCurrentScript }, [saveCurrentScript])

  // ⌘S: manual save trigger (autosave already covers editing)
  useEffect(() => {
    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        clearTimeout(autosaveTimer.current)
        saveRef.current()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      clearTimeout(autosaveTimer.current)
    }
  }, [])

  function handleStart() {
    if (!editor) return
    const text = editor.getText().trim()
    if (!text) return
    saveCurrentScript()
    setScriptText(text)
    setScriptDoc(editor.getJSON())
    setView('read')
  }

  function handleCollapse() {
    API.setIgnoreMouse(false)
    setView('idle')
  }

  function handleNew() {
    setCurrentScriptIndex(-1)
    editor?.commands.setContent('<p></p>')
    editor?.commands.focus()
    setStats('')
    setSaveState('idle')
  }

  function loadScript(i) {
    setCurrentScriptIndex(i)
    if (!editor) return
    const script = scripts[i]
    if (!script) return
    try {
      editor.commands.setContent(sanitizeDocColors(JSON.parse(script.content)), { emitUpdate: false })
    } catch {
      editor.commands.setContent(`<p>${script.text || ''}</p>`, { emitUpdate: false })
    }
    setStats(computeStats(script.text || ''))
    setSaveState('idle')
    editor.commands.focus()
  }

  function deleteScript(e, i) {
    e.stopPropagation()
    const updated = scripts.filter((_, idx) => idx !== i)
    setScripts(updated)
    if (!IS_DEMO_SESSION) API.saveScripts(updated)
    if (currentScriptIndex >= i) setCurrentScriptIndex(Math.max(-1, currentScriptIndex - 1))
  }

  function insertMarker(marker) {
    editor?.chain().focus().insertContent(` ${marker} `).run()
    setOpenMenu(null)
  }

  // ── Prepare with AI ─────────────────────────────────────
  // The actual run, assuming a provider is configured on the Rust side.
  // Called directly after guided setup completes so the originally requested
  // Prepare continues without a second click.
  // overrideProvider: the guided setup hands back the provider it just
  // configured — the store's config mirror may not have synced yet.
  async function runPrepare(overrideProvider) {
    if (!editor || aiBusy) return
    const text = editor.getText().trim()
    if (!text) return
    const provider = overrideProvider || config?.aiProvider || ''
    const prefs = (config?.aiPrefs || {})[provider] || {}
    setAiError('')
    setAiBusy(describePrepareTarget(provider, prefs) || 'AI')
    try {
      const prepared = await prepareScript(text, { provider, model: prefs.model, effort: prefs.effort })
      setReview({ originalDoc: editor.getJSON(), originalText: text, prepared })
    } catch (e) {
      const mapped = mapAiError(e)
      if (!mapped.canceled) {
        setAiError(mapped.message)
        // Missing key/CLI/provider → guided setup instead of raw settings
        if (mapped.needsSetup) setSetupOpen(true)
      }
    } finally {
      setAiBusy(false)
    }
  }

  function handlePrepare() {
    if (!editor || aiBusy) return
    if (!editor.getText().trim()) return
    if (!config?.aiProvider) {
      // First use: guided one-time setup; Prepare continues on success
      setSetupOpen(true)
      return
    }
    runPrepare()
  }

  function acceptReview() {
    if (!editor || !review) return
    // Never silently overwrite: the pre-preparation script is saved to the
    // library as its own entry before the editor content is replaced.
    const firstLine = review.originalText.split('\n')[0].substring(0, 32) || 'Untitled'
    const backup = {
      name: `${firstLine} · original`,
      text: review.originalText,
      content: JSON.stringify(review.originalDoc),
    }
    const updated = [...scripts, backup]
    setScripts(updated)
    if (!IS_DEMO_SESSION) API.saveScripts(updated)

    editor.commands.setContent(preparedTextToDoc(review.prepared))
    setStats(computeStats(editor.getText()))
    setReview(null)
  }

  function rejectReview() {
    setReview(null)
  }

  function setColor(color) {
    editor?.chain().focus().setColor(color).run()
    setOpenMenu(null)
  }

  // ── Guided AI setup (first Prepare click, or missing key/model) ──
  if (setupOpen) {
    return (
      <AiSetupPanel
        onCancel={() => setSetupOpen(false)}
        onReady={(provider) => { setSetupOpen(false); runPrepare(provider) }}
      />
    )
  }

  // ── Review mode: side-by-side original vs prepared ──────
  if (review) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="edit-header">
          <button className="pill-btn ghost" onClick={rejectReview}>✕</button>
          <span className="view-title">Review AI Prep</span>
          <button className="pill-btn ghost" onClick={rejectReview}>Reject</button>
          <button className="pill-btn accent" onClick={acceptReview}>Accept</button>
        </div>
        <div id="ai-review">
          <div className="ai-col">
            <div className="ai-col-title">Original (kept in library)</div>
            <div className="ai-original">{review.originalText}</div>
          </div>
          <div className="ai-col">
            <div className="ai-col-title">Prepared — edit before accepting</div>
            <textarea
              className="ai-prepared"
              value={review.prepared}
              onChange={e => setReview({ ...review, prepared: e.target.value })}
              spellCheck={false}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Header: close · script switcher (with "+" tab) · Prepare · Go · quit */}
      <div className="edit-header">
        <button className="pill-btn ghost" onClick={handleCollapse}>✕</button>
        <div id="script-list">
          {scripts.map((s, i) => (
            <div key={i} className={`script-item${i === currentScriptIndex ? ' active' : ''}`}>
              <span className="script-name" onClick={() => loadScript(i)}>{s.name}</span>
              <button className="script-del" onClick={(e) => deleteScript(e, i)}>✕</button>
            </div>
          ))}
          <button className="script-item script-add" onClick={handleNew} title="New script" aria-label="New script">+</button>
        </div>
        <button className="pill-btn ghost" onClick={handlePrepare} disabled={aiBusy} title="Prepare for Prompter with AI">
          {aiBusy ? 'Preparing…' : '✦ Prepare'}
        </button>
        <button className="pill-btn accent" onClick={handleStart}>Go →</button>
        <button className="pill-btn ghost edit-quit" onClick={() => API.quit()} title="Quit app" aria-label="Quit app">⏻</button>
      </div>

      {aiError && <div id="ai-error">{aiError}</div>}

      {/* Visible progress while the provider prepares the script */}
      {aiBusy && (
        <div id="ai-progress" role="status">
          <span className="ai-spinner" aria-hidden="true" />
          Preparing with {typeof aiBusy === 'string' ? aiBusy : 'AI'}…
          <button
            className="pill-btn ghost ai-cancel"
            onClick={() => API.cancelAiCli()}
            title="Cancel Prepare"
          >Cancel</button>
        </div>
      )}

      {/* Editor */}
      <div className="tiptap-wrap">
        <EditorContent editor={editor} />
      </div>

      {/* Footer: stats · saved indicator · cue-marker menu · format menu */}
      <div id="edit-footer">
        <span id="script-stats">{stats}</span>
        <span className={`save-indicator${saveState === 'saved' ? ' visible' : ''}`} aria-live="polite">Saved</span>

        <div className="footer-menu-wrap">
          <button
            className={`tb-btn${openMenu === 'cue' ? ' active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); setOpenMenu(openMenu === 'cue' ? null : 'cue') }}
            title="Insert cue marker"
          >+ Cue</button>
          {openMenu === 'cue' && (
            <div className="footer-menu" role="menu">
              {MARKERS.map((m) => (
                <button key={m} className="tb-marker" onMouseDown={(e) => { e.preventDefault(); insertMarker(m) }}>
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="footer-menu-wrap">
          <button
            className={`tb-btn${openMenu === 'format' ? ' active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); setOpenMenu(openMenu === 'format' ? null : 'format') }}
            title="Text format"
          >⋯</button>
          {openMenu === 'format' && (
            <div className="footer-menu" role="menu">
              <button
                className={`tb-btn${editor?.isActive('bold') ? ' active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); editor?.chain().focus().toggleBold().run() }}
                title="Bold (⌘B)"
              ><strong>B</strong></button>
              <div className="tb-divider" />
              {COLORS.map((c) => (
                <button
                  key={c.value}
                  className="tb-color"
                  style={{ background: c.value }}
                  onMouseDown={(e) => { e.preventDefault(); setColor(c.value) }}
                  title={c.label}
                />
              ))}
              <button
                className="tb-btn"
                onMouseDown={(e) => { e.preventDefault(); editor?.chain().focus().unsetColor().run(); setOpenMenu(null) }}
                title="Default color"
              >✕</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
