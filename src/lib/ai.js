// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
// "Prepare with AI" — prompt construction, response parsing, and error
// mapping for the script-preparation feature. Transport lives in Rust
// (ai_complete in src-tauri/src/lib.rs); everything testable lives here.
//
// All AI calls are explicit user actions (the Prepare button); nothing in
// this module runs automatically.

import { API } from './api'

// ── Providers ──────────────────────────────────────────────
// Four ways to reach a model, all funnelled through prepareScript():
//
//   claude-code    the user's Claude subscription, via the official Claude
//                  Code CLI (`claude -p`) they have installed and logged into
//   codex          the user's ChatGPT subscription, via the official OpenAI
//                  Codex CLI (`codex exec`)
//   anthropic-api  their own Anthropic API key (macOS Keychain)
//   ollama         any local OpenAI-compatible server — fully offline
//
// The subscription providers ONLY delegate to the official CLIs — the app
// never reads or proxies credentials and never calls the vendors'
// subscription endpoints itself (rationale: docs/ARCHITECTURE.md §4.4a).
// Each provider exposes detect() / listModels() / supportsEffort(model) /
// prepare(system, prompt, {model, effort}).

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh']
export const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' }

export const PROVIDER_ORDER = ['claude-code', 'codex', 'anthropic-api', 'ollama']

export const PROVIDERS = {
  'claude-code': {
    label: 'Claude subscription',
    via: 'Claude Code CLI',
    detect: () => API.detectAiProvider('claude-code'),
    listModels: () => ['', 'opus', 'sonnet', 'haiku', 'fable'],
    supportsEffort: () => true,
    instructions: {
      not_installed: 'Install Claude Code (claude.com/claude-code), then run `claude` once to sign in.',
      not_logged_in: 'Run `claude` in a terminal and sign in with your Claude account.',
    },
    prepare: (system, prompt, { model, effort } = {}) =>
      API.aiCliPrepare('claude-code', system, prompt, model || '', effort || ''),
  },
  codex: {
    label: 'ChatGPT subscription',
    via: 'OpenAI Codex CLI',
    detect: () => API.detectAiProvider('codex'),
    listModels: () => [''],
    supportsEffort: () => true,
    instructions: {
      not_installed: 'Install the Codex CLI: npm i -g @openai/codex, then codex login.',
      not_logged_in: 'Run `codex login` in a terminal and sign in with your ChatGPT account.',
    },
    prepare: (system, prompt, { model, effort } = {}) =>
      API.aiCliPrepare('codex', system, prompt, model || '', effort || ''),
  },
  'anthropic-api': {
    label: 'Claude API key',
    via: 'Anthropic API',
    detect: () => API.detectAiProvider('anthropic-api'),
    listModels: () => ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    // output_config.effort is rejected by models that don't support it
    // (e.g. Haiku 4.5) — omit it there rather than surface a 400.
    supportsEffort: (model) => !String(model || '').includes('haiku'),
    instructions: {
      not_configured: 'Save an Anthropic API key below (console.anthropic.com).',
    },
    prepare: (system, prompt, { model, effort } = {}) => API.aiComplete(
      system, prompt, model || '',
      PROVIDERS['anthropic-api'].supportsEffort(model) ? (effort || '') : ''),
  },
  ollama: {
    label: 'Ollama (local)',
    via: 'any OpenAI-compatible server',
    detect: () => API.detectAiProvider('ollama'),
    listModels: () => [],
    supportsEffort: () => false,
    instructions: {
      not_running: 'Start your local server (`ollama serve`) and set a model name.',
    },
    prepare: (system, prompt, { model } = {}) => API.aiComplete(system, prompt, model || '', ''),
  },
}

// Human-readable description of what a Prepare run will use, for the
// progress state ("Claude subscription · opus · High effort").
export function describePrepareTarget(provider, prefs = {}) {
  const def = PROVIDERS[provider]
  if (!def) return ''
  const parts = [def.label]
  if (prefs.model) parts.push(prefs.model)
  if (prefs.effort && def.supportsEffort(prefs.model)) {
    parts.push(`${EFFORT_LABELS[prefs.effort] || prefs.effort} effort`)
  }
  return parts.join(' · ')
}

// ── Prompt construction ────────────────────────────────────
const BASE_SYSTEM = `You prepare scripts for a teleprompter with a narrow display. Rewrite the raw script into teleprompter-ready form while preserving its meaning.

Rules:
- Keep the script's original language. Never translate.
- Use natural spoken phrasing: break up long written sentences, smooth constructions that are awkward to say aloud. Do not change the meaning.
- Short lines suited to a narrow panel: one clause or phrase per line, roughly 4-8 words per line. One line per row.
- Insert cue markers sparingly at rhetorically appropriate points: [PAUSE] after a key statement or before a transition, [BREATHE] before a long or demanding passage, [SLOW] before dense or emphatic material. Markers are literal bracketed tokens placed between words. Use at most one marker every few lines.
- Separate paragraphs or sections with one blank line.
- Keep all substantive content. Do not summarize, add new content, add headings, or add numbering.
- Output ONLY the prepared script text: no preamble, no explanation, no code fences.`

export function buildPrepareMessages(scriptText) {
  const prompt = `Prepare the following script for the teleprompter. Output only the prepared script.\n\n${scriptText}`
  return { system: BASE_SYSTEM, prompt }
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
    case 'cli_not_installed':
      return { code, needsSetup: true, message: `The provider's CLI is not installed. ${detail}`.trim() }
    case 'cli_not_logged_in':
      return { code, needsSetup: true, message: `The provider's CLI is not signed in. ${detail}`.trim() }
    case 'cli_rate_limit':
      return { code, message: `The provider reports a usage limit: ${detail.trim()}` }
    case 'cli_failed':
      return { code, message: `The provider CLI failed: ${detail.trim()}` }
    case 'timeout':
      return { code, message: `${detail.trim()} Try a lower effort level, or try again.` }
    case 'canceled':
      return { code, canceled: true, message: 'Prepare was cancelled.' }
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
// prepareScript(text, {provider, model, effort}) routes through the selected
// provider; `transport(system, prompt)` is injectable for tests. Returns the
// cleaned prepared text or throws (see mapAiError).
export async function prepareScript(scriptText, opts = {}, transport = null) {
  const { system, prompt } = buildPrepareMessages(scriptText)
  let send = transport
  if (!send) {
    const def = PROVIDERS[opts.provider]
    if (!def) {
      const err = new Error('No AI provider configured')
      err.code = 'no_provider'
      throw err
    }
    send = (s, p) => def.prepare(s, p, opts)
  }
  const raw = await send(system, prompt)
  return parsePreparedResponse(raw)
}
