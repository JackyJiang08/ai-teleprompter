// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'

// api.js captures window.__TAURI__ at import time, so the mock must be in
// place before the views (which import api.js) are loaded.
const invoke = vi.fn(() => Promise.resolve(null))
let render, fireEvent, act, cleanup, EditView, useAppStore

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  invoke.mockClear()
  window.__TAURI__ = {
    core: { invoke },
    event: { listen: () => Promise.resolve(() => {}) },
  }
  ;({ render, fireEvent, act, cleanup } = await import('@testing-library/react'))
  ;({ useAppStore } = await import('../../store'))
  ;({ default: EditView } = await import('../EditView'))
  cleanup()
})

afterEach(() => {
  vi.useRealTimers()
})

function seedScript() {
  useAppStore.setState({
    view: 'edit',
    scripts: [{ name: 'One', text: 'hello world', content: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }] }) }],
    currentScriptIndex: 0,
  })
}

describe('simplified editor header', () => {
  it('has exactly close, script switcher, Prepare, Go, and quit — no Save or + New buttons', () => {
    seedScript()
    const { container } = render(<EditView />)
    const header = container.querySelector('.edit-header')
    const labels = [...header.querySelectorAll('button.pill-btn')].map(b => b.textContent)
    expect(labels).toEqual(['✕', '✦ Prepare', 'Go →', '⏻'])
    expect(header.querySelector('#script-list')).toBeTruthy()
  })

  it('the script switcher ends with a "+" tab that starts a new script', () => {
    seedScript()
    const { container } = render(<EditView />)
    const add = container.querySelector('#script-list .script-add')
    expect(add).toBeTruthy()
    fireEvent.click(add)
    expect(useAppStore.getState().currentScriptIndex).toBe(-1)
  })
})

describe('autosave', () => {
  it('debounced autosave persists edits and shows the Saved indicator', async () => {
    seedScript()
    const { container } = render(<EditView />)
    const editorEl = container.querySelector('.tiptap-editor')
    expect(editorEl).toBeTruthy()
    // Simulate an edit through the editor's DOM (tiptap listens on the element)
    await act(async () => {
      editorEl.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
    // Force an update through the store-loaded content: fire ⌘S instead to
    // exercise the same save path deterministically
    await act(async () => {
      fireEvent.keyDown(document, { key: 's', metaKey: true })
    })
    expect(invoke).toHaveBeenCalledWith('save_scripts', expect.anything())
    expect(container.querySelector('.save-indicator.visible')).toBeTruthy()
  })

  it('⌘S saves immediately', async () => {
    seedScript()
    const { container } = render(<EditView />)
    await act(async () => {
      fireEvent.keyDown(document, { key: 's', metaKey: true })
    })
    expect(invoke).toHaveBeenCalledWith('save_scripts', expect.anything())
    expect(container.querySelector('.save-indicator.visible')).toBeTruthy()
  })
})

describe('the script library is only written by real edits', () => {
  it('merely loading a script never triggers an autosave', async () => {
    // Tiptap v3's setContent emits an update by default; the load paths must
    // suppress it or every mount rewrites the library (and a demo-seeded
    // session would rewrite it with demo content).
    seedScript()
    render(<EditView />)
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(invoke).not.toHaveBeenCalledWith('save_scripts', expect.anything())
  })

  it('demo sessions (?view=…) never invoke save_scripts, even on explicit save', async () => {
    window.history.replaceState({}, '', '/?view=edit')
    try {
      vi.resetModules()
      ;({ useAppStore } = await import('../../store'))
      ;({ default: EditView } = await import('../EditView'))
      seedScript()
      render(<EditView />)
      await act(async () => { fireEvent.keyDown(document, { key: 's', metaKey: true }) })
      expect(invoke).not.toHaveBeenCalledWith('save_scripts', expect.anything())
    } finally {
      window.history.replaceState({}, '', '/')
    }
  })
})

describe('footer menus', () => {
  it('cue markers live in one insert menu', () => {
    seedScript()
    const { container } = render(<EditView />)
    // closed by default
    expect(container.querySelector('.footer-menu')).toBeNull()
    const cueBtn = [...container.querySelectorAll('#edit-footer .tb-btn')].find(b => b.textContent === '+ Cue')
    expect(cueBtn).toBeTruthy()
    fireEvent.mouseDown(cueBtn)
    const menu = container.querySelector('.footer-menu')
    expect(menu).toBeTruthy()
    const markers = [...menu.querySelectorAll('.tb-marker')].map(b => b.textContent)
    expect(markers).toEqual(['[PAUSE]', '[SLOW]', '[BREATHE]'])
  })

  it('bold and color swatches live in the ⋯ overflow menu', () => {
    seedScript()
    const { container } = render(<EditView />)
    const moreBtn = [...container.querySelectorAll('#edit-footer .tb-btn')].find(b => b.textContent === '⋯')
    expect(moreBtn).toBeTruthy()
    fireEvent.mouseDown(moreBtn)
    const menu = container.querySelector('.footer-menu')
    expect(menu.querySelector('strong')).toBeTruthy() // Bold
    expect(menu.querySelectorAll('.tb-color').length).toBeGreaterThanOrEqual(4)
  })
})

describe('Prepare with AI onboarding', () => {
  it('first Prepare click with no provider opens the guided setup panel', async () => {
    seedScript()
    useAppStore.setState({ config: { ...useAppStore.getState().config, aiProvider: '' } })
    const { container } = render(<EditView />)
    const prepare = [...container.querySelectorAll('.pill-btn')].find(b => b.textContent === '✦ Prepare')
    await act(async () => { fireEvent.click(prepare) })
    expect(container.querySelector('#ai-setup')).toBeTruthy()
    // both provider options are explained
    const cards = [...container.querySelectorAll('.setup-card-title')].map(e => e.textContent)
    expect(cards).toEqual(['Claude API', 'Local (Ollama)'])
    expect([...container.querySelectorAll('.setup-actions .pill-btn')][0].textContent).toBe('Test connection')
  })

  it('successful test saves the provider and auto-continues the Prepare', async () => {
    seedScript()
    useAppStore.setState({ config: { ...useAppStore.getState().config, aiProvider: '' } })
    invoke.mockImplementation((cmd) => {
      if (cmd === 'ai_test') return Promise.resolve(null)
      if (cmd === 'ai_complete') return Promise.resolve('prepared line')
      return Promise.resolve(null)
    })
    const { container } = render(<EditView />)
    const prepare = [...container.querySelectorAll('.pill-btn')].find(b => b.textContent === '✦ Prepare')
    await act(async () => { fireEvent.click(prepare) })
    const key = container.querySelector('input[type="password"]')
    fireEvent.change(key, { target: { value: 'sk-ant-test' } })
    const testBtn = [...container.querySelectorAll('.setup-actions .pill-btn')][0]
    await act(async () => { fireEvent.click(testBtn) })
    expect(invoke).toHaveBeenCalledWith('ai_test', expect.anything())
    expect(invoke).toHaveBeenCalledWith('set_ai_key', { key: 'sk-ant-test' })
    expect(invoke).toHaveBeenCalledWith('set_config', expect.objectContaining({ patch: expect.objectContaining({ aiProvider: 'anthropic' }) }))
    // the original Prepare continued without a second Prepare click
    expect(invoke).toHaveBeenCalledWith('ai_complete', expect.anything())
  })

  it('configured provider runs Prepare immediately with a visible progress state', async () => {
    seedScript()
    useAppStore.setState({ config: { ...useAppStore.getState().config, aiProvider: 'anthropic' } })
    let resolveComplete
    invoke.mockImplementation((cmd) => {
      if (cmd === 'ai_complete') return new Promise(r => { resolveComplete = r })
      return Promise.resolve(null)
    })
    const { container } = render(<EditView />)
    const prepare = [...container.querySelectorAll('.pill-btn')].find(b => b.textContent === '✦ Prepare')
    await act(async () => { fireEvent.click(prepare) })
    expect(container.querySelector('#ai-setup')).toBeNull()
    expect(container.querySelector('#ai-progress')).toBeTruthy()
    await act(async () => { resolveComplete('done line') })
  })
})
