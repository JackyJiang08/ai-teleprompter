// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// "Prepare with AI" — prompt construction, response parsing, and error
// mapping for the script-preparation feature. Transport lives in Rust
// (ai_complete in src-tauri/src/lib.rs); everything testable lives here.
//
// All AI calls are explicit user actions (the Prepare button); nothing in
// this module runs automatically.

import { API } from './api'
import { CJK_RE } from './tokenizer'

// ── Language detection ─────────────────────────────────────
// Fraction of non-whitespace characters that are CJK ideographs.
export function cjkRatio(text) {
  let cjk = 0
  let total = 0
  for (const ch of text || '') {
    if (/\s/.test(ch)) continue
    total++
    if (CJK_RE.test(ch)) cjk++
  }
  return total === 0 ? 0 : cjk / total
}

// ── Prompt construction ────────────────────────────────────
const BASE_SYSTEM = `You prepare scripts for a teleprompter with a narrow display. Rewrite the raw script into teleprompter-ready form while preserving its meaning.

Rules:
- Keep the original language(s). Never translate. In mixed Chinese-English text, keep each part in its original language.
- Use natural spoken phrasing: break up long written sentences, smooth constructions that are awkward to say aloud. Do not change the meaning.
- Short lines suited to a narrow panel: one clause or phrase per line, roughly 4-8 English words or 6-14 Chinese characters per line. One line per row.
- Insert cue markers sparingly at rhetorically appropriate points: [PAUSE] after a key statement or before a transition, [BREATHE] before a long or demanding passage, [SLOW] before dense or emphatic material. Markers are literal bracketed tokens placed between words. Use at most one marker every few lines.
- Separate paragraphs or sections with one blank line.
- Keep all substantive content. Do not summarize, add new content, add headings, or add numbering.
- Output ONLY the prepared script text: no preamble, no explanation, no code fences.`

const CHINESE_ADDENDUM = `
- This script contains Chinese. Break Chinese lines at natural prosodic boundaries — after complete phrases, at punctuation, between clauses — never in the middle of a word or a tightly bound phrase.`

export function buildPrepareMessages(scriptText) {
  const hasChinese = cjkRatio(scriptText) > 0.05
  const system = hasChinese ? BASE_SYSTEM + CHINESE_ADDENDUM : BASE_SYSTEM
  const prompt = `Prepare the following script for the teleprompter. Output only the prepared script.\n\n${scriptText}`
  return { system, prompt }
}

// ── Response parsing ───────────────────────────────────────
// Normalizes marker casing, strips accidental code fences, collapses
// excessive blank lines. Throws { code: 'empty_response' } on empty output.
export function parsePreparedResponse(raw) {
  let text = (raw || '').trim()

  // Strip a wrapping code fence if the model added one despite instructions
  const fence = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  if (fence) text = fence[1].trim()

  // Normalize marker casing: [pause] → [PAUSE]
  text = text.replace(/\[\s*(pause|slow|breathe)\s*\]/gi, (_, m) => `[${m.toUpperCase()}]`)

  // Collapse 3+ consecutive newlines to a single blank line
  text = text.replace(/\n{3,}/g, '\n\n')

  if (!text) {
    const err = new Error('AI returned an empty response')
    err.code = 'empty_response'
    throw err
  }
  return text
}

// ── Prepared text → Tiptap document ────────────────────────
// Each line becomes a paragraph; blank lines become empty paragraphs
// (spacing). This is the shape EditView's editor and the tokenizer consume.
export function preparedTextToDoc(text) {
  const lines = (text || '').split('\n')
  return {
    type: 'doc',
    content: lines.map((line) => {
      const trimmed = line.trim()
      return trimmed
        ? { type: 'paragraph', content: [{ type: 'text', text: trimmed }] }
        : { type: 'paragraph' }
    }),
  }
}

// ── Error mapping ──────────────────────────────────────────
// Rust rejects with "code:detail" strings. Map to actionable messages.
export function mapAiError(err) {
  const raw = typeof err === 'string' ? err : err?.message || String(err)
  const sep = raw.indexOf(':')
  const code = err?.code || (sep > 0 ? raw.slice(0, sep) : 'unknown')
  const detail = sep > 0 ? raw.slice(sep + 1) : raw

  switch (code) {
    case 'no_provider':
      return { code, needsSetup: true, message: 'No AI provider configured. Choose one in Settings → Prepare with AI.' }
    case 'no_api_key':
      return { code, needsSetup: true, message: 'No Anthropic API key saved. Add one in Settings → Prepare with AI (stored in the macOS Keychain).' }
    case 'no_model':
      return { code, needsSetup: true, message: 'No model set for the local provider. Enter a model name in Settings (e.g. llama3.1).' }
    case 'auth':
      return { code, message: 'The API key was rejected. Check the key in Settings → Prepare with AI.' }
    case 'rate_limit': {
      const [retryAfter] = detail.split('|')
      const wait = retryAfter && /^\d+$/.test(retryAfter) ? ` Try again in ~${retryAfter}s.` : ' Try again in a moment.'
      return { code, message: `The provider is rate-limiting requests.${wait}` }
    }
    case 'model_not_found':
      return { code, message: 'Model not found. Check the model name in Settings → Prepare with AI.' }
    case 'network':
      return { code, message: 'Could not reach the AI provider. Check your connection — for a local provider, make sure the server is running (e.g. `ollama serve`).' }
    case 'refusal':
      return { code, message: 'The model declined to process this script. Edit the script and try again.' }
    case 'keychain':
      return { code, message: `Could not access the macOS Keychain: ${detail}` }
    case 'empty_response':
    case 'parse':
      return { code, message: 'The AI returned an unusable response. Try again, or try a different model.' }
    case 'server':
      return { code, message: `The provider returned an error (${detail.trim()}). Try again in a moment.` }
    default:
      return { code: 'unknown', message: `AI request failed: ${raw}` }
  }
}

// ── Orchestration ──────────────────────────────────────────
// complete(system, prompt) is injectable for tests; defaults to the Tauri
// command. Returns the cleaned prepared text or throws (see mapAiError).
export async function prepareScript(scriptText, complete = API.aiComplete) {
  const { system, prompt } = buildPrepareMessages(scriptText)
  const raw = await complete(system, prompt)
  return parsePreparedResponse(raw)
}
