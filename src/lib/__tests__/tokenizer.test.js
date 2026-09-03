// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
import { describe, expect, it } from 'vitest'
import { splitCJK, tokenizeDoc } from '../tokenizer'

function doc(...paragraphs) {
  return {
    type: 'doc',
    content: paragraphs.map(content => ({ type: 'paragraph', content })),
  }
}
const text = (t, marks) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const words = tokens => tokens.filter(t => t.type === 'word').map(t => t.text)

describe('splitCJK', () => {
  it('keeps pure Latin chunks together', () => {
    expect(splitCJK('hello')).toEqual(['hello'])
    expect(splitCJK("don't")).toEqual(["don't"])
  })

  it('splits CJK runs per character', () => {
    expect(splitCJK('今天天气')).toEqual(['今', '天', '天', '气'])
  })

  it('handles mixed Chinese-English chunks', () => {
    expect(splitCJK('我们的React项目')).toEqual(['我', '们', '的', 'React', '项', '目'])
  })

  it('keeps CJK punctuation attached to the Latin run (not split as CJK)', () => {
    // 。and ， are not ideographs; they ride along and are stripped later
    // by matcher normalization.
    expect(splitCJK('好。')).toEqual(['好', '。'])
  })
})

describe('tokenizeDoc', () => {
  it('tokenizes English on whitespace', () => {
    const tokens = tokenizeDoc(doc([text('Hello brave new world')]))
    expect(words(tokens)).toEqual(['Hello', 'brave', 'new', 'world'])
    expect(tokens.at(-1)).toEqual({ type: 'newline' })
  })

  it('tokenizes Chinese per character with cjk flag', () => {
    const tokens = tokenizeDoc(doc([text('今天天气很好')]))
    expect(words(tokens)).toEqual(['今', '天', '天', '气', '很', '好'])
    expect(tokens.filter(t => t.type === 'word').every(t => t.cjk)).toBe(true)
  })

  it('handles mixed-language text, flagging only CJK tokens', () => {
    const tokens = tokenizeDoc(doc([text('我们的React项目 launches 今天')]))
    expect(words(tokens)).toEqual(['我', '们', '的', 'React', '项', '目', 'launches', '今', '天'])
    const react = tokens.find(t => t.text === 'React')
    const launches = tokens.find(t => t.text === 'launches')
    const jin = tokens.find(t => t.text === '今')
    expect(react.cjk).toBe(false)
    expect(launches.cjk).toBe(false)
    expect(jin.cjk).toBe(true)
  })

  it('marks spaceAfter only where the source had whitespace', () => {
    const tokens = tokenizeDoc(doc([text('我们的React项目 launches')]))
    const w = tokens.filter(t => t.type === 'word')
    // 我/们/的/React/项 are mid-chunk → no space; 目 ends chunk 1; launches ends chunk 2
    expect(w.map(t => t.spaceAfter)).toEqual([false, false, false, false, false, true, true])
    // pure English: every word had whitespace after it
    const en = tokenizeDoc(doc([text('hello world')])).filter(t => t.type === 'word')
    expect(en.every(t => t.spaceAfter)).toBe(true)
  })

  it('preserves cue markers as marker tokens, never split', () => {
    const tokens = tokenizeDoc(doc([text('breathe [PAUSE] now')]))
    expect(tokens.map(t => t.type)).toEqual(['word', 'marker', 'word', 'newline'])
    expect(tokens[1].marker).toBe('PAUSE')
  })

  it('propagates bold and color marks to every split token', () => {
    const tokens = tokenizeDoc(doc([
      text('重点内容', [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#4ade80' } }]),
    ]))
    const w = tokens.filter(t => t.type === 'word')
    expect(w).toHaveLength(4)
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
