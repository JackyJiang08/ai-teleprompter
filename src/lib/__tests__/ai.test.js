// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
import { describe, expect, it, vi } from 'vitest'
import {
  buildPrepareMessages,
  mapAiError,
  parsePreparedResponse,
  preparedTextToDoc,
  prepareScript,
} from '../ai'

describe('buildPrepareMessages', () => {
  it('includes the cue-marker convention and output constraints', () => {
    const { system, prompt } = buildPrepareMessages('Hello world, this is my speech.')
    expect(system).toContain('[PAUSE]')
    expect(system).toContain('[SLOW]')
    expect(system).toContain('[BREATHE]')
    expect(system).toContain('no code fences')
    expect(prompt).toContain('Hello world, this is my speech.')
  })

  it('never asks for translation', () => {
    const { system } = buildPrepareMessages('A plain speech about testing.')
    expect(system).toContain('Never translate')
  })
})

describe('parsePreparedResponse', () => {
  it('trims and passes through clean text', () => {
    expect(parsePreparedResponse('  line one\nline two\n')).toBe('line one\nline two')
  })

  it('strips a wrapping code fence', () => {
    expect(parsePreparedResponse('```\nline one\nline two\n```')).toBe('line one\nline two')
    expect(parsePreparedResponse('```text\nhello\n```')).toBe('hello')
  })

  it('normalizes marker casing', () => {
    expect(parsePreparedResponse('go on [pause] then [Slow] here [ BREATHE ]'))
      .toBe('go on [PAUSE] then [SLOW] here [BREATHE]')
  })

  it('collapses runs of blank lines', () => {
    expect(parsePreparedResponse('a\n\n\n\nb')).toBe('a\n\nb')
  })

  it('throws a coded error on empty output', () => {
    expect(() => parsePreparedResponse('   ')).toThrowError(
      expect.objectContaining({ code: 'empty_response' })
    )
    expect(() => parsePreparedResponse('```\n\n```')).toThrowError(
      expect.objectContaining({ code: 'empty_response' })
    )
  })
})

describe('preparedTextToDoc', () => {
  it('maps lines to paragraphs and blank lines to empty paragraphs', () => {
    const doc = preparedTextToDoc('line one\n\nline two [PAUSE]')
    expect(doc.type).toBe('doc')
    expect(doc.content).toHaveLength(3)
    expect(doc.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'line one' }] })
    expect(doc.content[1]).toEqual({ type: 'paragraph' })
    expect(doc.content[2].content[0].text).toBe('line two [PAUSE]')
  })
})

describe('prepareScript with mocked providers', () => {
  it('sends built messages to the provider and returns parsed text', async () => {
    const complete = vi.fn().mockResolvedValue('```\nshort line [pause]\nnext line\n```')
    const result = await prepareScript('A long rambling script that needs preparation.', complete)

    expect(complete).toHaveBeenCalledOnce()
    const [system, prompt] = complete.mock.calls[0]
    expect(system).toContain('teleprompter')
    expect(prompt).toContain('A long rambling script')
    expect(result).toBe('short line [PAUSE]\nnext line')
  })

  it('propagates provider errors for the UI to map', async () => {
    const complete = vi.fn().mockRejectedValue('rate_limit:30|Too many requests')
    await expect(prepareScript('text', complete)).rejects.toBe('rate_limit:30|Too many requests')
  })

  it('rejects an empty provider response with a coded error', async () => {
    const complete = vi.fn().mockResolvedValue('')
    await expect(prepareScript('text', complete)).rejects.toMatchObject({ code: 'empty_response' })
  })
})

describe('mapAiError', () => {
  it('flags setup-needed codes', () => {
    expect(mapAiError('no_provider:No AI provider configured').needsSetup).toBe(true)
    expect(mapAiError('no_api_key:No API key saved').needsSetup).toBe(true)
    expect(mapAiError('no_model:Set a model name in Settings').needsSetup).toBe(true)
  })

  it('surfaces retry-after on rate limits', () => {
    const m = mapAiError('rate_limit:30|Too many requests')
    expect(m.code).toBe('rate_limit')
    expect(m.message).toContain('~30s')
    // missing retry-after still gives an actionable message
    expect(mapAiError('rate_limit:|Too many requests').message).toContain('a moment')
  })

  it('maps auth, network, and model errors to actionable messages', () => {
    expect(mapAiError('auth:invalid x-api-key').message).toContain('Settings')
    expect(mapAiError('network:connection refused').message).toContain('ollama serve')
    expect(mapAiError('model_not_found:model llama9 not found').message).toContain('model name')
  })

  it('handles Error objects with codes and unknown strings', () => {
    const err = new Error('AI returned an empty response')
    err.code = 'empty_response'
    expect(mapAiError(err).code).toBe('empty_response')
    expect(mapAiError('total gibberish').code).toBe('unknown')
  })
})

// ── WS4: AI-prepared output inherits the default style ─────
describe('preparedTextToDoc default styling', () => {
  it('produces text nodes with no marks, so output uses the theme default color', () => {
    const out = preparedTextToDoc('line one [PAUSE]\n\nline two')
    for (const p of out.content) {
      for (const n of p.content || []) {
        expect(n.marks).toBeUndefined()
      }
    }
  })
})
