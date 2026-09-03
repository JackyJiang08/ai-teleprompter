// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'

// api.js captures window.__TAURI__ at import time, so the mock must be in
// place before the views (which import api.js) are loaded.
const invoke = vi.fn(() => Promise.resolve(null))
let render, fireEvent, cleanup, IdleView, EditView, useAppStore

beforeEach(async () => {
  vi.resetModules()
  invoke.mockClear()
  window.__TAURI__ = {
    core: { invoke },
    event: { listen: () => Promise.resolve(() => {}) },
  }
  ;({ render, fireEvent, cleanup } = await import('@testing-library/react'))
  ;({ useAppStore } = await import('../../store'))
  ;({ default: IdleView } = await import('../IdleView'))
  ;({ default: EditView } = await import('../EditView'))
  cleanup()
})

describe('quit from the idle pill', () => {
  it('shows a quit control on hover that invokes quit_app', () => {
    const { container } = render(<IdleView isHovered={true} />)
    const quit = container.querySelector('.idle-quit')
    expect(quit).toBeTruthy()
    fireEvent.click(quit)
    expect(invoke).toHaveBeenCalledWith('quit_app')
  })

  it('quit click does not also open the editor', () => {
    useAppStore.setState({ view: 'idle' })
    const { container } = render(<IdleView isHovered={true} />)
    fireEvent.click(container.querySelector('.idle-quit'))
    expect(useAppStore.getState().view).toBe('idle')
  })

  it('hides the quit control when not hovered (notch mode)', () => {
    const { container } = render(<IdleView isHovered={false} />)
    expect(container.querySelector('.idle-quit')).toBeNull()
  })
})

describe('quit from the editor header', () => {
  it('renders a quit button that invokes quit_app', () => {
    const { container } = render(<EditView />)
    const quit = container.querySelector('.edit-quit')
    expect(quit).toBeTruthy()
    fireEvent.click(quit)
    expect(invoke).toHaveBeenCalledWith('quit_app')
  })

  it('the header ✕ collapses to idle without quitting', () => {
    useAppStore.setState({ view: 'edit' })
    const { container } = render(<EditView />)
    const closeBtn = container.querySelector('.edit-header .pill-btn')
    fireEvent.click(closeBtn) // first header button is ✕ (collapse)
    expect(useAppStore.getState().view).toBe('idle')
    expect(invoke).not.toHaveBeenCalledWith('quit_app')
  })
})
