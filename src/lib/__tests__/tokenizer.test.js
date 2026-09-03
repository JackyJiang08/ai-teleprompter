// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
import { describe, expect, it } from 'vitest'
import { tokenizeDoc } from '../tokenizer'

function doc(...paragraphs) {
  return {
    type: 'doc',
    content: paragraphs.map(content => ({ type: 'paragraph', content })),
  }
}
const text = (t, marks) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const words = tokens => tokens.filter(t => t.type === 'word').map(t => t.text)

describe('tokenizeDoc', () => {
  it('tokenizes on whitespace', () => {
    const tokens = tokenizeDoc(doc([text('Hello brave new world')]))
    expect(words(tokens)).toEqual(['Hello', 'brave', 'new', 'world'])
    expect(tokens.at(-1)).toEqual({ type: 'newline' })
  })

  it('keeps punctuation attached to its word', () => {
    const tokens = tokenizeDoc(doc([text("Don't stop, keep going.")]))
    expect(words(tokens)).toEqual(["Don't", 'stop,', 'keep', 'going.'])
  })

  it('preserves cue markers as marker tokens, never split', () => {
    const tokens = tokenizeDoc(doc([text('breathe [PAUSE] now')]))
    expect(tokens.map(t => t.type)).toEqual(['word', 'marker', 'word', 'newline'])
    expect(tokens[1].marker).toBe('PAUSE')
  })

  it('propagates bold and color marks to every token', () => {
    const tokens = tokenizeDoc(doc([
      text('key launch details', [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#4ade80' } }]),
    ]))
    const w = tokens.filter(t => t.type === 'word')
    expect(w).toHaveLength(3)
    expect(w.every(t => t.bold && t.color === '#4ade80')).toBe(true)
  })

  it('emits a newline token per paragraph', () => {
    const tokens = tokenizeDoc(doc([text('one')], [text('two')]))
    expect(tokens.map(t => t.type)).toEqual(['word', 'newline', 'word', 'newline'])
  })
})

// ── WS4: theme-safe color defaults ─────────────────────────
import { sanitizeColor, sanitizeDocColors } from '../tokenizer'

describe('sanitizeColor', () => {
  it('drops invisible-risk neutrals in any common notation', () => {
    for (const c of ['#ffffff', '#fff', '#FFFFFF', 'white', '#000', '#000000', 'black', 'transparent', 'rgb(255,255,255)', 'rgba(0, 0, 0, 0.9)']) {
      expect(sanitizeColor(c)).toBeNull()
    }
  })
  it('keeps real colors and empty values', () => {
    expect(sanitizeColor('#facc15')).toBe('#facc15')
    expect(sanitizeColor('#4ade80')).toBe('#4ade80')
    expect(sanitizeColor(null)).toBeNull()
  })
})

describe('sanitizeDocColors', () => {
  const doc = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'legacy', marks: [{ type: 'textStyle', attrs: { color: '#ffffff' } }] },
        { type: 'text', text: 'kept', marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#4ade80' } }] },
      ],
    }],
  }
  it('strips neutral color marks but keeps everything else', () => {
    const out = sanitizeDocColors(doc)
    expect(out.content[0].content[0].marks).toBeUndefined()
    expect(out.content[0].content[1].marks).toEqual([{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#4ade80' } }])
    // input untouched
    expect(doc.content[0].content[0].marks.length).toBe(1)
  })
})

describe('tokenizeDoc color sanitising', () => {
  it('white-marked words tokenize with no explicit color', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello', marks: [{ type: 'textStyle', attrs: { color: '#fff' } }] }] }],
    }
    const tokens = tokenizeDoc(doc)
    expect(tokens[0].color).toBeNull()
  })
})
