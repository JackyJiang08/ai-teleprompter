import { useEffect, useRef, useState } from 'react'
import { tokenizeDoc } from '../lib/tokenizer'
import { useAppStore } from '../store'
import { API } from '../lib/api'
import { createMicEngine, SPEEDS, SCROLL_SPEED_BASE } from '../lib/mic'
import { createSpeechTracker } from '../lib/speech'

// When word tracking drives the scroll, the current word is eased toward
// this fraction of the viewport height (the "reading line").
const READING_LINE = 0.35
// Per-16.7ms-frame smoothing factor for cursor-following scroll. 0.16 ≈
// a ~100ms time constant: recognition partials arrive ~every 250ms, so the
// scroll settles well before the next partial and the highlight (which marks
// the next *expected* word) reads as slightly ahead of the voice instead of
// dragging behind it (was 0.06 ≈ 280ms — visibly trailing).
const FOLLOW_SMOOTHING = 0.16

export default function ReadView() {
  const { scriptText, scriptDoc, config, setView, setRecognition } = useAppStore()
  const tokens = scriptDoc ? tokenizeDoc(scriptDoc) : []

  // Live config refs — updated whenever config changes, used inside RAF/mic without remount
  const configRef = useRef(config)
  useEffect(() => { configRef.current = config }, [config])

  // Local state for everything playback-related (avoids stale closure issues)
  const [isPaused, setIsPaused] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [speedIdx, setSpeedIdx] = useState(
    SPEEDS.indexOf(config.scrollSpeed) !== -1 ? SPEEDS.indexOf(config.scrollSpeed) : 3
  )
  const [fontSize, setFontSize] = useState(config.fontSize || 16)
  const [micStatus, setMicStatus] = useState('Waiting…')
  // Word-tracking cursor for rendering: active + token index of next expected word
  const [track, setTrack] = useState({ active: false, cursor: -1, done: false })
  // Dev-only tracking-quality overlay (?trackdebug=1): raw partials vs
  // matched position, for debugging recognition/matcher behavior
  const trackDebug = new URLSearchParams(window.location.search).has('trackdebug')
  const [debug, setDebug] = useState(null)

  // Refs for values used inside RAF/interval (must not be stale)
  const isPausedRef = useRef(false)
  const isSpeakingRef = useRef(false)
  const isHoverPausedRef = useRef(false)
  const speedIdxRef = useRef(speedIdx)
  const scrollPosRef = useRef(0)
  const lastFrameRef = useRef(0)
  const rafRef = useRef(null)
  const scrollVPRef = useRef(null)
  const scriptTextRef = useRef(null)
  const markerRefs = useRef({})     // token index → DOM el (markers)
  const wordRefs = useRef({})       // token index → DOM el (words)
  const firedMarkers = useRef(new Set()) // indices already fired
  const micEngineRef = useRef(null)
  const speechTrackerRef = useRef(null)
  const trackRef = useRef({ active: false, cursor: -1, done: false })
  const silenceTimer = useRef(null)

  // Keep refs in sync
  useEffect(() => { isPausedRef.current = isPaused }, [isPaused])
  useEffect(() => { isSpeakingRef.current = isSpeaking }, [isSpeaking])
  useEffect(() => { speedIdxRef.current = speedIdx }, [speedIdx])

  function setTrackBoth(next) {
    trackRef.current = next
    setTrack(next)
  }

  // ── Engines ────────────────────────────────────────────────
  function startVadEngine() {
    if (micEngineRef.current) return
    const engine = createMicEngine({
      threshold: configRef.current.threshold,
      onSpeaking: () => { isSpeakingRef.current = true; setIsSpeaking(true); setMicStatus('Speaking') },
      onSilence:  () => { isSpeakingRef.current = false; setIsSpeaking(false); setMicStatus('Waiting…') },
      onError:    () => setMicStatus('Mic error'),
    })
    micEngineRef.current = engine
    engine.start(configRef.current.micDeviceId)
  }

  function startSpeechTracker() {
    const firstWord = tokens.findIndex(t => t.type === 'word')
    setTrackBoth({ active: true, cursor: firstWord, done: firstWord === -1 })
    setRecognition({ engine: 'speech', status: 'starting', message: '', cursorTokenIndex: firstWord })

    const tracker = createSpeechTracker({
      // English-only scope: recognition always runs en-US. The sidecar keeps
      // its --locale parameter for future use, but no UI selects another.
      locale: 'en-US',
      tokens,
      scriptText,
      trickyWords: configRef.current.trackingHints || '',
      onDebug: trackDebug ? (msg) => {
        if (msg.type === 'partial' || msg.type === 'final') {
          setDebug(d => ({ ...d, text: msg.text, session: msg.session, confidence: msg.confidence, at: Date.now(), emitted: msg.t }))
        } else if (msg.type === 'lm') {
          setDebug(d => ({ ...d, lm: msg.state }))
        }
      } : undefined,
      onUpdate: (pos) => {
        setTrackBoth({ active: true, cursor: pos.cursorTokenIndex, done: pos.done })
        isSpeakingRef.current = pos.speaking
        setIsSpeaking(pos.speaking)
        setRecognition({
          cursorTokenIndex: pos.cursorTokenIndex,
          matchedCount: pos.matchedCount,
          total: pos.total,
          confidence: pos.confidence,
        })
        if (pos.speaking) setMicStatus('Tracking')
      },
      onStatus: (status, message) => {
        setRecognition({ status, message })
        if (status === 'listening') setMicStatus('Listening (on-device)')
        else if (status === 'starting') setMicStatus('Starting…')
      },
      onFallback: (message) => {
        // Word tracking unavailable → frequency-based activation, old behavior
        speechTrackerRef.current = null
        setTrackBoth({ active: false, cursor: -1, done: false })
        setRecognition({ engine: 'vad', status: 'error', message })
        setMicStatus('Voice detection')
        startVadEngine()
      },
    })
    speechTrackerRef.current = tracker
    tracker.start()
  }

  function stopEngines() {
    speechTrackerRef.current?.stop()
    speechTrackerRef.current = null
    micEngineRef.current?.stop()
    micEngineRef.current = null
  }

  // React to live config changes while ReadView is mounted (VAD engine only —
  // the speech tracker takes locale at start and is restarted per session)
  useEffect(() => {
    if (config.scrollSpeed !== undefined) {
      const i = SPEEDS.reduce((best, s, idx) =>
        Math.abs(s - config.scrollSpeed) < Math.abs(SPEEDS[best] - config.scrollSpeed) ? idx : best
      , 0)
      setSpeedIdx(i)
    }
    micEngineRef.current?.setThreshold(config.threshold)
    if (micEngineRef.current && configRef.current.micDeviceId !== config.micDeviceId) {
      micEngineRef.current.stop()
      micEngineRef.current = null
      startVadEngine()
    }
  }, [config.threshold, config.micDeviceId, config.autoScroll, config.scrollSpeed])

  // On mount: set content, start engines, start scroll loop
  useEffect(() => {
    // Cue marker checker — fires actions when markers enter reading zone
    function checkMarkers() {
      if (!scrollVPRef.current) return
      const vpRect = scrollVPRef.current.getBoundingClientRect()
      const readingZoneBottom = vpRect.top + vpRect.height * 0.4

      Object.entries(markerRefs.current).forEach(([idxStr, el]) => {
        if (!el) return
        const idx = Number(idxStr)
        if (firedMarkers.current.has(idx)) return
        const rect = el.getBoundingClientRect()
        if (rect.top < readingZoneBottom) {
          firedMarkers.current.add(idx)
          const marker = el.dataset.marker
          if (marker === 'PAUSE') {
            isPausedRef.current = true
            setIsPaused(true)
            setMicStatus('Paused')
            setTimeout(() => {
              isPausedRef.current = false
              setIsPaused(false)
              setMicStatus('Waiting…')
            }, 1200)
          } else if (marker === 'BREATHE') {
            isPausedRef.current = true
            setIsPaused(true)
            setMicStatus('Breathe…')
            setTimeout(() => {
              isPausedRef.current = false
              setIsPaused(false)
              setMicStatus('Waiting…')
            }, 2500)
          } else if (marker === 'SLOW') {
            setSpeedIdx(prev => {
              const n = Math.max(0, prev - 1)
              API.setConfig({ scrollSpeed: SPEEDS[n] })
              return n
            })
          }
        }
      })
    }

    // Scroll RAF — two modes:
    //  • word tracking: ease scroll toward the current word's reading line
    //  • legacy: constant speed while the VAD hears speech (or autoScroll)
    // Demo/test hook (?trackdemo=1): scroll snaps instantly instead of
    // easing, so snapshot captures are deterministic
    const demoInstantScroll = new URLSearchParams(window.location.search).has('trackdemo')

    function loop(ts) {
      const paused = isPausedRef.current || isHoverPausedRef.current
      const delta = lastFrameRef.current ? Math.min((ts - lastFrameRef.current) / 16.667, 3) : 1
      lastFrameRef.current = ts
      const vp = scrollVPRef.current
      const st = scriptTextRef.current
      const t = trackRef.current

      if (vp && st && !paused) {
        const maxScroll = Math.max(0, st.scrollHeight - vp.clientHeight)
        if (t.active) {
          // Follow the reader's position
          let target = scrollPosRef.current
          if (t.done) {
            target = maxScroll
          } else {
            const el = t.cursor >= 0 ? wordRefs.current[t.cursor] : null
            if (el) target = el.offsetTop - vp.clientHeight * READING_LINE
          }
          target = Math.max(0, Math.min(target, maxScroll))
          const k = demoInstantScroll ? 1 : 1 - Math.pow(1 - FOLLOW_SMOOTHING, delta)
          const next = scrollPosRef.current + (target - scrollPosRef.current) * k
          if (Math.abs(next - scrollPosRef.current) > 0.01) {
            scrollPosRef.current = next
            st.style.transform = `translateY(${-scrollPosRef.current}px)`
          }
          checkMarkers()
        } else {
          const shouldScroll = configRef.current.autoScroll ? true : isSpeakingRef.current
          if (shouldScroll && scrollPosRef.current < maxScroll - 1) {
            scrollPosRef.current += SCROLL_SPEED_BASE * SPEEDS[speedIdxRef.current] * delta
            scrollPosRef.current = Math.min(scrollPosRef.current, maxScroll)
            st.style.transform = `translateY(${-scrollPosRef.current}px)`
            checkMarkers()
          }
        }
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)

    // Start recognition: word tracking when enabled (and running inside
    // Tauri), otherwise the frequency-based VAD engine
    const wantSpeech = configRef.current.wordTracking !== false && !!window.__TAURI__
    const trackDemo = new URLSearchParams(window.location.search).has('trackdemo')
    if (trackDemo) {
      // Demo/test hook (snap.mjs + TELEPROMPTER_DEMO_PARAMS): render the
      // spoken/current/upcoming word states without a live recognizer
      const wordIdxs = tokens.map((t, i) => (t.type === 'word' ? i : -1)).filter(i => i >= 0)
      const cursor = wordIdxs[Math.floor(wordIdxs.length * 0.4)] ?? -1
      setTrackBoth({ active: true, cursor, done: false })
      setMicStatus('Tracking')
    } else if (wantSpeech && tokens.some(t => t.type === 'word')) {
      startSpeechTracker()
    } else {
      setRecognition({ engine: 'vad', status: 'idle', message: '' })
      startVadEngine()
    }

    // Shortcuts — capture unlisten fn for cleanup
    let unlistenShortcut
    API.onShortcut((action) => {
      if (action === 'pause') togglePause()
      if (action === 'faster') setSpeedIdx(i => Math.min(SPEEDS.length - 1, i + 1))
      if (action === 'slower') setSpeedIdx(i => Math.max(0, i - 1))
      if (action === 'reset') handleReset()
      if (action === 'stop') handleDone()
    }).then(fn => { unlistenShortcut = fn })

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (silenceTimer.current) clearTimeout(silenceTimer.current)
      stopEngines()
      setRecognition({ engine: 'none', status: 'idle', message: '', cursorTokenIndex: -1, matchedCount: 0, confidence: 0 })
      unlistenShortcut?.()
    }
  }, [])

  function togglePause() {
    const next = !isPausedRef.current
    isPausedRef.current = next
    setIsPaused(next)
    setMicStatus(next ? 'Paused' : 'Waiting…')
    if (next) { isSpeakingRef.current = false; setIsSpeaking(false) }
  }

  function handleDone() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (silenceTimer.current) clearTimeout(silenceTimer.current)
    stopEngines()
    API.setIgnoreMouse(false)
    setView('idle') // App.jsx resize effect handles window resize on view change
  }

  function handleReset() {
    scrollPosRef.current = 0
    if (scriptTextRef.current) scriptTextRef.current.style.transform = 'translateY(0px)'
    firedMarkers.current.clear() // reset so markers fire again on replay
    speechTrackerRef.current?.reset()
  }

  function handleMouseEnter() {
    isHoverPausedRef.current = true
    setMicStatus('Hover pause')
  }

  function handleMouseLeave() {
    isHoverPausedRef.current = false
    if (!isPausedRef.current) setMicStatus(isSpeakingRef.current ? 'Speaking' : 'Waiting…')
  }

  function handleWheel(e) {
    e.preventDefault()
    if (!scrollVPRef.current || !scriptTextRef.current) return
    const maxScroll = scriptTextRef.current.scrollHeight - scrollVPRef.current.clientHeight
    scrollPosRef.current = Math.max(0, Math.min(scrollPosRef.current + e.deltaY, maxScroll))
    scriptTextRef.current.style.transform = `translateY(${-scrollPosRef.current}px)`
  }

  const micRingClass = `mic-ring${isSpeaking ? '' : ' paused'}`

  // Word-tracking display state for a token index: '' | 'spoken' | 'current'
  function tokenTrackClass(i) {
    if (!track.active) return ''
    if (track.done || i < track.cursor) return ' tok-spoken'
    if (i === track.cursor) return ' tok-current'
    return ''
  }

  return (
    <div
      style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div id="progress-bar" />

      <div
        ref={scrollVPRef}
        id="scroll-viewport"
        onWheel={handleWheel}
        style={{ flex: 1, overflowY: 'hidden', position: 'relative' }}
      >
        <div
          ref={scriptTextRef}
          id="script-text"
          style={{ fontSize: `${fontSize}px` }}
        >
          {tokens.length > 0 ? tokens.map((token, i) => {
            if (token.type === 'newline') return <br key={i} />
            if (token.type === 'marker') return (
              <span
                key={i}
                ref={el => { markerRefs.current[i] = el }}
                data-marker={token.marker}
                className={`read-marker read-marker-${token.marker.toLowerCase()}${tokenTrackClass(i) === ' tok-spoken' ? ' tok-spoken' : ''}`}
              >
                {token.text}
              </span>
            )
            return (
              <span
                key={i}
                ref={el => { wordRefs.current[i] = el }}
                className={`tok${tokenTrackClass(i)}`}
                style={{
                  fontWeight: token.bold ? 700 : undefined,
                  color: token.color || undefined,
                }}
              >
                {token.text}{' '}
              </span>
            )
          }) : scriptText}
        </div>
      </div>

      {trackDebug && (
        <div id="track-debug">
          <div>engine: speech · session {debug?.session ?? '–'} · lm: {debug?.lm ?? 'stock'}</div>
          <div>raw: {(debug?.text || '').slice(-64) || '–'}</div>
          <div>
            cursor {track.cursor} / matched {useAppStore.getState().recognition.matchedCount}
            /{useAppStore.getState().recognition.total}
            {' · conf '}{(debug?.confidence ?? 0).toFixed(2)}
            {debug?.at ? ` · ${Date.now() - debug.at}ms ago` : ''}
          </div>
        </div>
      )}

      <div id="read-controls">
        <div className="ctrl-left">
          <span className={micRingClass}>
            <span className="mic-core" />
          </span>
          <span id="status-text">{micStatus}</span>
        </div>
        <div className="ctrl-right">
          <button className="ctrl-btn" onClick={() => setFontSize(f => Math.max(11, f - 2))}>A−</button>
          <button className="ctrl-btn" onClick={() => setFontSize(f => Math.min(32, f + 2))}>A+</button>
          <button className="ctrl-btn" onClick={() => setSpeedIdx(i => { const n = Math.max(0, i - 1); API.setConfig({ scrollSpeed: SPEEDS[n] }); return n })}>−</button>
          <span id="speed-val">{SPEEDS[speedIdx]}×</span>
          <button className="ctrl-btn" onClick={() => setSpeedIdx(i => { const n = Math.min(SPEEDS.length - 1, i + 1); API.setConfig({ scrollSpeed: SPEEDS[n] }); return n })}>+</button>
          <button className="ctrl-btn" onClick={togglePause}>{isPaused ? '▶' : '⏸'}</button>
          <button className="ctrl-btn" onClick={handleReset}>↺</button>
          <button className="ctrl-btn" onClick={handleDone}>✕</button>
        </div>
      </div>
    </div>
  )
}
