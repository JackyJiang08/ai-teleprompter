import { useAppStore } from '../store'
import { API } from '../lib/api'

export default function IdleView({ isHovered }) {
  const { setView, isSpeaking, isPaused, config } = useAppStore()
  const isClassic = config.mode === 'classic'

  function handleQuit(e) {
    e.stopPropagation() // don't also open the editor
    API.quit()
  }

  function handleOpen() {
    setView('edit')
  }

  function handleChevronClick(e) {
    e.stopPropagation()
    setView('edit')
  }

  const isActive  = isSpeaking
  const isPausedS = isPaused && !isSpeaking

  // Theme-aware dot color via CSS vars (set inline only for active states)
  const dotColor = isActive  ? '#22c55e'
                 : isPausedS ? '#f59e0b'
                 : 'var(--text-muted)'
  const dotGlow  = isActive  ? '0 0 8px #22c55ecc'
                 : isPausedS ? '0 0 8px #f59e0baa'
                 : 'none'

  const label    = isActive  ? 'Recording'
                 : isPausedS ? 'Paused'
                 : 'Teleprompter'

  return (
    <div
      className="idle-notch-wrap"
      onClick={isClassic ? undefined : handleOpen}
    >
      <div className={`idle-pill-content${isHovered ? ' hovered' : ''}`}>

        {/* Status dot */}
        <span
          className={`idle-status-dot${isActive ? ' pulse' : ''}`}
          style={{ background: dotColor, boxShadow: dotGlow }}
        />

        {/* Label */}
        <span className="idle-pill-label" aria-hidden="true">
          {label}
        </span>

        {/* Chevron — classic: always visible + clickable; notch: hover reveal */}
        <svg
          className="idle-chevron"
          width={isClassic ? '16' : '9'}
          height={isClassic ? '16' : '9'}
          viewBox="0 0 9 9"
          fill="none"
          aria-hidden="true"
          onClick={isClassic ? handleChevronClick : undefined}
          style={isClassic ? { cursor: 'pointer', padding: '4px', margin: '-4px' } : {}}
        >
          <path
            d="M2 3.5L4.5 6L7 3.5"
            stroke="var(--text-secondary)"
            strokeWidth={isClassic ? '2' : '1.5'}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        {/* Quit — hover reveal in notch mode; always visible in classic
            (same pattern as the chevron). See issue #1. */}
        {(isHovered || isClassic) && (
          <button
            className="idle-quit"
            onClick={handleQuit}
            title="Quit AI Teleprompter"
            aria-label="Quit"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M6 1v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M3.2 3.2a4 4 0 1 0 5.6 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}

      </div>
    </div>
  )
}
