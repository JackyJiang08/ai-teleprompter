// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// Guided one-time setup for Prepare with AI, shown inline in the editor the
// first time ✦ Prepare is clicked without a working provider. Four ways in,
// subscriptions first: Claude subscription (Claude Code CLI), ChatGPT
// subscription (Codex CLI), Anthropic API key, local Ollama. CLI providers
// are detected live (installed? logged in?); the key/local providers are
// validated with a real "Test connection" request (ai_test). On success the
// choice is saved and the originally requested Prepare continues.

import { useEffect, useState } from 'react'
import { API } from '../lib/api'
import { mapAiError, PROVIDER_ORDER, PROVIDERS } from '../lib/ai'

const CARD_DESC = {
  'claude-code': 'Use your existing Claude plan through the official Claude Code CLI — no API key. The app only runs the CLI you are already signed into.',
  codex: 'Use your existing ChatGPT plan through the official Codex CLI — no API key. The app only runs the CLI you are already signed into.',
  'anthropic-api': "Anthropic's API with your own key from console.anthropic.com, stored only in the macOS Keychain. Pay-per-use.",
  ollama: 'Any OpenAI-compatible server on your Mac — fully offline. Run `ollama serve`, then `ollama pull` a model.',
}

const CARD_TITLE = {
  'claude-code': 'Claude subscription',
  codex: 'ChatGPT subscription',
  'anthropic-api': 'Claude API key',
  ollama: 'Local (Ollama)',
}

const BADGE = {
  checking: 'Checking…',
  available: 'Available',
  not_installed: 'Not installed',
  not_logged_in: 'Not logged in',
  not_configured: 'No API key',
  not_running: 'Not running',
}

export default function AiSetupPanel({ onCancel, onReady }) {
  const [provider, setProvider] = useState('claude-code')
  const [key, setKey] = useState('')
  const [model, setModel] = useState('')
  const [localUrl, setLocalUrl] = useState('http://localhost:11434')
  // 'idle' | 'testing' | 'ok' | { error }
  const [status, setStatus] = useState('idle')
  const [detect, setDetect] = useState({})

  function refreshDetection() {
    for (const id of ['claude-code', 'codex']) {
      setDetect(d => ({ ...d, [id]: { state: 'checking' } }))
      PROVIDERS[id].detect().then(res =>
        setDetect(d => ({ ...d, [id]: res || { state: 'error' } })))
    }
  }
  useEffect(() => { refreshDetection() }, [])

  const isCli = provider === 'claude-code' || provider === 'codex'
  const cliState = detect[provider]?.state

  // CLI providers: nothing to type — confirm the detected CLI and go.
  async function useCliProvider() {
    if (cliState !== 'available') return
    await API.setConfig({ aiProvider: provider })
    setStatus('ok')
    onReady?.(provider)
  }

  // Key/local providers: validate the typed values first (ai_test), then save.
  async function testAndContinue() {
    if (status === 'testing') return
    setStatus('testing')
    try {
      await API.aiTest({ provider, model: model.trim(), localUrl: localUrl.trim(), key: key.trim() })
      if (provider === 'anthropic-api' && key.trim()) await API.setAiKey(key.trim())
      await API.setConfig({
        aiProvider: provider,
        aiModel: model.trim(),
        ...(provider === 'ollama' ? { aiLocalUrl: localUrl.trim() } : {}),
      })
      setStatus('ok')
      onReady?.(provider)
    } catch (e) {
      setStatus({ error: mapAiError(e).message })
    }
  }

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="edit-header">
        <button className="pill-btn ghost" onClick={onCancel}>✕</button>
        <span className="view-title">Set up Prepare with AI</span>
      </div>

      <div id="ai-setup">
        <p className="setup-intro">
          One-time setup. ✦ Prepare rewrites your script into teleprompter-ready
          lines — your script is only ever sent when you click it.
        </p>

        <div className="setup-options">
          {PROVIDER_ORDER.map(id => (
            <button
              key={id}
              className={`setup-card${provider === id ? ' active' : ''}`}
              onClick={() => { setProvider(id); setStatus('idle') }}
            >
              <span className="setup-card-title">
                {CARD_TITLE[id]}
                {(id === 'claude-code' || id === 'codex') && BADGE[detect[id]?.state] && (
                  <span className={`setup-badge ${detect[id].state === 'available' ? 'ok' : 'warn'}`}>
                    {BADGE[detect[id].state]}
                  </span>
                )}
              </span>
              <span className="setup-card-desc">{CARD_DESC[id]}</span>
            </button>
          ))}
        </div>

        {isCli ? (
          <div className="setup-fields">
            {cliState === 'available' && (
              <span className="setup-status ok">
                {PROVIDERS[provider].via} detected{detect[provider]?.version ? ` (${detect[provider].version})` : ''} and signed in.
              </span>
            )}
            {PROVIDERS[provider].instructions[cliState] && (
              <span className="setup-status error">
                {PROVIDERS[provider].instructions[cliState]}
              </span>
            )}
            <span className="setup-status">
              Runs on your own plan's usage. The CLI is run with tools disabled
              in an empty folder; your key and login stay with the CLI.
            </span>
          </div>
        ) : provider === 'anthropic-api' ? (
          <div className="setup-fields">
            <input
              className="setup-input"
              type="password"
              placeholder="API key (sk-ant-…)"
              value={key}
              onChange={e => { setKey(e.target.value); setStatus('idle') }}
              onKeyDown={e => { if (e.key === 'Enter') testAndContinue() }}
            />
            <input
              className="setup-input"
              placeholder="Model — optional, claude-opus-5 by default"
              value={model}
              onChange={e => { setModel(e.target.value); setStatus('idle') }}
            />
          </div>
        ) : (
          <div className="setup-fields">
            <input
              className="setup-input"
              placeholder="Server URL"
              value={localUrl}
              onChange={e => { setLocalUrl(e.target.value); setStatus('idle') }}
            />
            <input
              className="setup-input"
              placeholder="Model — required, e.g. llama3.1"
              value={model}
              onChange={e => { setModel(e.target.value); setStatus('idle') }}
              onKeyDown={e => { if (e.key === 'Enter') testAndContinue() }}
            />
          </div>
        )}

        <div className="setup-actions">
          {isCli ? (
            <>
              <button
                className="pill-btn accent"
                onClick={useCliProvider}
                disabled={cliState !== 'available'}
                title={cliState !== 'available' ? 'Install and sign in to the CLI first' : undefined}
              >
                {status === 'ok' ? '✓ Ready' : 'Use this provider'}
              </button>
              <button className="pill-btn ghost" onClick={refreshDetection}>Re-check</button>
            </>
          ) : (
            <button className="pill-btn accent" onClick={testAndContinue} disabled={status === 'testing'}>
              {status === 'testing' ? 'Testing…' : status === 'ok' ? '✓ Connected' : 'Test connection'}
            </button>
          )}
          {status === 'ok' && <span className="setup-status ok">Ready — preparing your script…</span>}
          {typeof status === 'object' && <span className="setup-status error">{status.error}</span>}
        </div>
      </div>
    </div>
  )
}
