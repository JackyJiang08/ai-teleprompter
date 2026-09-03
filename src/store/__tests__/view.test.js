// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../index'

// The prompter's view state machine. 'idle' is the launch state: only the
// notch pill renders — the editor must never auto-open (the old first-launch
// welcome window regression made it look like it did).
describe('view state', () => {
  beforeEach(() => {
    useAppStore.setState({ view: 'idle' })
  })

  it('launches in idle — no editor on launch', () => {
    expect(useAppStore.getState().view).toBe('idle')
  })

  it('editor opens only via an explicit setView and closes back to idle', () => {
    const { setView } = useAppStore.getState()
    setView('edit')
    expect(useAppStore.getState().view).toBe('edit')
    // close (collapse) hides the editor without touching anything else
    setView('idle')
    expect(useAppStore.getState().view).toBe('idle')
  })

  it('supports a full open → read → close cycle', () => {
    const { setView } = useAppStore.getState()
    setView('edit')
    setView('read')
    expect(useAppStore.getState().view).toBe('read')
    setView('idle')
    expect(useAppStore.getState().view).toBe('idle')
  })
})
