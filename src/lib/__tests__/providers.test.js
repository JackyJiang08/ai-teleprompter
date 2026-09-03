// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// @vitest-environment jsdom
// The four Prepare-with-AI providers: detection plumbing, per-provider
// argument construction (model/effort), routing, and error mapping.
import { beforeEach, describe, expect, it, vi } from 'vitest'

// api.js captures window.__TAURI__ at import time, so the mock must be in
// place before ai.js (which imports api.js) is loaded.
const invoke = vi.fn(() => Promise.resolve(null))
let ai

beforeEach(async () => {
  vi.resetModules()
  invoke.mockClear()
  invoke.mockImplementation(() => Promise.resolve(null))
  window.__TAURI__ = {
    core: { invoke },
    event: { listen: () => Promise.resolve(() => {}) },
  }
  ai = await import('../ai')
})

describe('provider detection', () => {
  it('each provider asks the backend about itself', async () => {
    for (const id of ai.PROVIDER_ORDER) {
      await ai.PROVIDERS[id].detect()
      expect(invoke).toHaveBeenCalledWith('detect_ai_provider', { provider: id })
    }
  })

  it('provider order leads with the subscription providers', () => {
    expect(ai.PROVIDER_ORDER).toEqual(['claude-code', 'codex', 'anthropic-api', 'ollama'])
  })
})

describe('argument construction', () => {
  it('claude-code passes model and effort to the CLI command', async () => {
    await ai.PROVIDERS['claude-code'].prepare('SYS', 'PROMPT', { model: 'opus', effort: 'high' })
    expect(invoke).toHaveBeenCalledWith('ai_cli_prepare', expect.objectContaining({
      provider: 'claude-code', system: 'SYS', prompt: 'PROMPT', model: 'opus', effort: 'high',
    }))
  })

  it('codex passes model and effort to the CLI command', async () => {
    await ai.PROVIDERS.codex.prepare('SYS', 'PROMPT', { model: 'gpt-x', effort: 'xhigh' })
    expect(invoke).toHaveBeenCalledWith('ai_cli_prepare', expect.objectContaining({
      provider: 'codex', model: 'gpt-x', effort: 'xhigh',
    }))
  })

  it('anthropic-api passes effort for models that support it', async () => {
    await ai.PROVIDERS['anthropic-api'].prepare('SYS', 'PROMPT', { model: 'claude-opus-5', effort: 'xhigh' })
    expect(invoke).toHaveBeenCalledWith('ai_complete', expect.objectContaining({
      model: 'claude-opus-5', effort: 'xhigh',
    }))
  })

  it('anthropic-api drops effort for haiku (the API rejects it there)', async () => {
    await ai.PROVIDERS['anthropic-api'].prepare('SYS', 'PROMPT', { model: 'claude-haiku-4-5', effort: 'high' })
    expect(invoke).toHaveBeenCalledWith('ai_complete', expect.objectContaining({
      model: 'claude-haiku-4-5', effort: null,
    }))
  })

  it('ollama never sends an effort', async () => {
    await ai.PROVIDERS.ollama.prepare('SYS', 'PROMPT', { model: 'llama3.1', effort: 'high' })
    expect(invoke).toHaveBeenCalledWith('ai_complete', expect.objectContaining({
      model: 'llama3.1', effort: null,
    }))
  })
})

describe('effort support', () => {
  it('matches each provider', () => {
    expect(ai.PROVIDERS['claude-code'].supportsEffort()).toBe(true)
    expect(ai.PROVIDERS.codex.supportsEffort()).toBe(true)
    expect(ai.PROVIDERS['anthropic-api'].supportsEffort('claude-opus-5')).toBe(true)
    expect(ai.PROVIDERS['anthropic-api'].supportsEffort('claude-haiku-4-5')).toBe(false)
    expect(ai.PROVIDERS.ollama.supportsEffort()).toBe(false)
  })

  it('offers four labelled tiers', () => {
    expect(ai.EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(ai.EFFORT_LABELS.xhigh).toBe('Extra high')
  })
})

describe('prepareScript routing', () => {
  it('routes through the selected provider and parses the output', async () => {
    invoke.mockImplementation((cmd) =>
      Promise.resolve(cmd === 'ai_cli_prepare' ? '```\nline one [pause]\nline two\n```' : null))
    const out = await ai.prepareScript('raw script', { provider: 'claude-code', effort: 'low' })
    expect(out).toBe('line one [PAUSE]\nline two')
    expect(invoke).toHaveBeenCalledWith('ai_cli_prepare', expect.objectContaining({
      provider: 'claude-code', effort: 'low',
    }))
  })

  it('throws a needs-setup error when no provider is configured', async () => {
    await expect(ai.prepareScript('text', { provider: '' })).rejects.toMatchObject({ code: 'no_provider' })
  })
})

describe('CLI error mapping', () => {
  it('missing or logged-out CLIs are setup problems', () => {
    expect(ai.mapAiError('cli_not_installed:claude is not installed').needsSetup).toBe(true)
    expect(ai.mapAiError('cli_not_logged_in:Run codex login').needsSetup).toBe(true)
  })

  it("usage limits surface the CLI's own message", () => {
    const m = ai.mapAiError('cli_rate_limit:Your usage limit resets at 3pm.')
    expect(m.message).toContain('resets at 3pm')
  })

  it('timeouts and failures are actionable', () => {
    expect(ai.mapAiError('timeout:The provider CLI did not answer within 120s').message).toContain('effort')
    expect(ai.mapAiError('cli_failed:claude exited with 1 — boom').message).toContain('boom')
  })

  it('cancellation is flagged so the UI can stay silent', () => {
    const m = ai.mapAiError('canceled:Prepare was cancelled')
    expect(m.canceled).toBe(true)
  })
})

describe('describePrepareTarget', () => {
  it('names provider, model, and effort when set and supported', () => {
    expect(ai.describePrepareTarget('claude-code', { model: 'opus', effort: 'high' }))
      .toBe('Claude subscription · opus · High effort')
    expect(ai.describePrepareTarget('ollama', { model: 'llama3.1', effort: 'high' }))
      .toBe('Ollama (local) · llama3.1') // effort unsupported → not shown
    expect(ai.describePrepareTarget('codex', {})).toBe('ChatGPT subscription')
  })
})
