// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// Guided one-time setup for Prepare with AI, shown inline in the editor the
// first time ✦ Prepare is clicked without a configured provider. Explains the
// two provider options, validates them with a real "Test connection" request
// (ai_test), saves on success, and hands control back so the originally
// requested Prepare continues automatically.

import { useState } from 'react'
import { API } from '../lib/api'
import { mapAiError } from '../lib/ai'

export default function AiSetupPanel({ onCancel, onReady }) {
  const [provider, setProvider] = useState('anthropic')
  const [key, setKey] = useState('')
  const [model, setModel] = useState('')
  const [localUrl, setLocalUrl] = useState('http://localhost:11434')
  // 'idle' | 'testing' | 'ok' | { error }
  const [status, setStatus] = useState('idle')

  async function testAndContinue() {
    if (status === 'testing') return
    setStatus('testing')
    try {
      await API.aiTest({ provider, model: model.trim(), localUrl: localUrl.trim(), key: key.trim() })
      // Validated — persist: key to the Keychain, the rest to config
      if (provider === 'anthropic' && key.trim()) await API.setAiKey(key.trim())
      await API.setConfig({
        aiProvider: provider,
        aiModel: model.trim(),
        ...(provider === 'local' ? { aiLocalUrl: localUrl.trim() } : {}),
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
          <button
            className={`setup-card${provider === 'anthropic' ? ' active' : ''}`}
            onClick={() => { setProvider('anthropic'); setStatus('idle') }}
          >
            <span className="setup-card-title">Claude API</span>
            <span className="setup-card-desc">
              Anthropic's hosted models — best quality. Needs an API key from
              console.anthropic.com, stored only in the macOS Keychain.
            </span>
          </button>
          <button
            className={`setup-card${provider === 'local' ? ' active' : ''}`}
            onClick={() => { setProvider('local'); setStatus('idle') }}
          >
            <span className="setup-card-title">Local (Ollama)</span>
            <span className="setup-card-desc">
              Any OpenAI-compatible server on your Mac — fully offline. Run
              `ollama serve`, then `ollama pull` a model.
            </span>
          </button>
        </div>

        {provider === 'anthropic' ? (
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
          <button className="pill-btn accent" onClick={testAndContinue} disabled={status === 'testing'}>
            {status === 'testing' ? 'Testing…' : status === 'ok' ? '✓ Connected' : 'Test connection'}
          </button>
          {status === 'ok' && <span className="setup-status ok">Connected — preparing your script…</span>}
          {typeof status === 'object' && <span className="setup-status error">{status.error}</span>}
        </div>
      </div>
    </div>
  )
}
