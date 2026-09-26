// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'

// api.js captures window.__TAURI__ at import time, so the mock must be in place
// before the views (which import api.js) load.
const invoke = vi.fn(() => Promise.resolve(null))
let render, fireEvent, cleanup, IdleView

beforeEach(async () => {
  vi.resetModules()
  invoke.mockClear()
  window.__TAURI__ = {
    core: { invoke },
    event: { listen: () => Promise.resolve(() => {}) },
  }
  ;({ render, fireEvent, cleanup } = await import('@testing-library/react'))
  ;({ default: IdleView } = await import('../IdleView'))
  cleanup()
})

describe('sharing mode from the idle pill', () => {
  it('the go-dark control hides windows via set_sharing_mode(on:true)', () => {
    const { container } = render(<IdleView isHovered={true} />)
    const btn = container.querySelector('.idle-godark')
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    expect(invoke).toHaveBeenCalledWith('set_sharing_mode', { on: true })
  })

  it('go-dark is hidden until hover (notch mode)', () => {
    const { container } = render(<IdleView isHovered={false} />)
    expect(container.querySelector('.idle-godark')).toBeNull()
  })

  it('go-dark does not also open the editor', async () => {
    const { useAppStore } = await import('../../store')
    useAppStore.setState({ view: 'idle' })
    const { container } = render(<IdleView isHovered={true} />)
    fireEvent.click(container.querySelector('.idle-godark'))
    expect(useAppStore.getState().view).toBe('idle')
  })
})
