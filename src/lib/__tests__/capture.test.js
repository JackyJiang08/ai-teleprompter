// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
import { describe, expect, it } from 'vitest'
import { captureExcluded } from '../capture.js'

describe('captureExcluded — Settings status derivation', () => {
  const win = (p) => ({ sharingType: p ? 0 : 1, protected: p })

  it('true when effective and every window is protected', () => {
    expect(captureExcluded({
      effective: true, windows: { prompter: win(true), settings: win(true) },
    })).toBe(true)
  })

  it('false if any single window is captured', () => {
    expect(captureExcluded({
      effective: true, windows: { prompter: win(true), settings: win(false) },
    })).toBe(false)
  })

  it('false when the config gate is not effective (e.g. capture allowed)', () => {
    expect(captureExcluded({
      effective: false, windows: { prompter: win(true) },
    })).toBe(false)
  })

  it('false when there are no windows to protect', () => {
    expect(captureExcluded({ effective: true, windows: {} })).toBe(false)
  })

  it('returns the fallback when no snapshot has loaded yet', () => {
    expect(captureExcluded(null, true)).toBe(true)
    expect(captureExcluded(undefined, false)).toBe(false)
  })
})
