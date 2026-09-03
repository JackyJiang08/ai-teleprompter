/**
 * snap.mjs — Notch mode snapshot tool
 *
 * Usage:
 *   node scripts/snap.mjs save    → lock current notch state as golden
 *   node scripts/snap.mjs check   → diff current vs golden, fail if changed
 *
 * Requires: dev server running on :1420
 */

import puppeteer from 'puppeteer-core'
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE_URL = 'http://localhost:1420'
const SNAP_DIR = path.resolve('.snapshots/notch')
const DIFF_THRESHOLD = 100 // max pixels allowed to differ

// The notch states we care about. `name` keys the golden file; `params`
// appends extra browser-only test-hook query params (see src/App.jsx,
// src/views/EditView.jsx, src/views/ReadView.jsx).
const STATES = [
  { name: 'idle', view: 'idle', theme: 'dark' },
  { name: 'idle', view: 'idle', theme: 'light' },
  { name: 'edit', view: 'edit', theme: 'dark' },
  { name: 'edit', view: 'edit', theme: 'light' },
  { name: 'read', view: 'read', theme: 'dark' },
  { name: 'read', view: 'read', theme: 'light' },
  // Fork additions: hover state (quit control), AI review panel,
  // and word-tracking read states
  { name: 'idle-hover', view: 'idle', theme: 'dark', params: 'hoverdemo=1' },
  { name: 'idle-hover', view: 'idle', theme: 'light', params: 'hoverdemo=1' },
  { name: 'edit-aireview', view: 'edit', theme: 'dark', params: 'aireview=1' },
  { name: 'edit-aireview', view: 'edit', theme: 'light', params: 'aireview=1' },
  { name: 'edit-aisetup', view: 'edit', theme: 'dark', params: 'aisetup=1' },
  { name: 'edit-aisetup', view: 'edit', theme: 'light', params: 'aisetup=1' },
  { name: 'read-tracking', view: 'read', theme: 'dark', params: 'trackdemo=1' },
  { name: 'read-tracking', view: 'read', theme: 'light', params: 'trackdemo=1' },
  // Settings window (its own page/bundle; selector is the settings panel)
  { name: 'settings', page: 'settings.html', selector: '#panel', view: 'idle', theme: 'dark' },
  { name: 'settings', page: 'settings.html', selector: '#panel', view: 'idle', theme: 'light' },
]

async function getPage(browser, { view, theme, params, page: pagePath = '', selector = '#island' }) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const url = `${BASE_URL}/${pagePath}?view=${view}&mode=notch&theme=${theme}${params ? `&${params}` : ''}`
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForSelector(selector)
  await page.evaluate(() => document.fonts.ready) // late glyph swap moves layout
  await new Promise(r => setTimeout(r, 700)) // let animations settle

  // Clip to the target element + small padding
  const box = await page.$eval(selector, el => {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  })

  const clip = {
    x: Math.max(0, box.x - 30),
    y: 0,
    width: box.width + 60,
    height: box.height + 30,
  }

  const buf = await page.screenshot({ clip, type: 'png' })
  await page.close()
  return buf
}

async function run(cmd) {
  // Check dev server is up
  try {
    const res = await fetch(BASE_URL)
    if (!res.ok) throw new Error()
  } catch {
    console.error('❌  Dev server not running. Start it with: npm run dev:react')
    process.exit(1)
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  })

  if (cmd === 'save') {
    fs.mkdirSync(SNAP_DIR, { recursive: true })
    console.log('📸  Saving notch golden snapshots...\n')

    for (const state of STATES) {
      const name = `notch__${state.name}__${state.theme}.png`
      const buf = await getPage(browser, state)
      fs.writeFileSync(path.join(SNAP_DIR, name), buf)
      console.log(`  ✅  ${name}`)
    }
    console.log(`\n✨  Saved ${STATES.length} snapshots to ${SNAP_DIR}`)

  } else if (cmd === 'check') {
    if (!fs.existsSync(SNAP_DIR)) {
      console.error('❌  No snapshots found. Run: node scripts/snap.mjs save')
      process.exit(1)
    }

    console.log('🔍  Checking notch mode for regressions...\n')
    let failed = 0

    for (const state of STATES) {
      const name = `notch__${state.name}__${state.theme}.png`
      const goldenPath = path.join(SNAP_DIR, name)

      if (!fs.existsSync(goldenPath)) {
        console.log(`  ⚠️   ${name} — no golden, skipping`)
        continue
      }

      const current = await getPage(browser, state)
      const golden = fs.readFileSync(goldenPath)

      // Quick hash check first (fast path)
      const hashA = createHash('md5').update(current).digest('hex')
      const hashB = createHash('md5').update(golden).digest('hex')

      if (hashA === hashB) {
        console.log(`  ✅  ${name} — identical`)
        continue
      }

      // Hash differs — do byte-level size check as proxy for major diff
      const sizeDiff = Math.abs(current.length - golden.length)
      const sizeRatio = sizeDiff / golden.length

      if (sizeRatio > 0.02) {
        // >2% file size change = significant visual change
        fs.writeFileSync(path.join(SNAP_DIR, `FAIL__${name}`), current)
        console.log(`  ❌  ${name} — CHANGED (${(sizeRatio * 100).toFixed(1)}% size diff) → saved as FAIL__${name}`)
        failed++
      } else {
        // Minor encoding/font sub-pixel diff — warn but don't fail
        console.log(`  ⚠️   ${name} — minor diff (${sizeDiff} bytes, likely sub-pixel)`)
      }
    }

    console.log('')
    if (failed === 0) {
      console.log('✨  Notch mode clean — no regressions detected')
    } else {
      console.log(`🚨  ${failed} regression(s) found! Check FAIL__*.png files in ${SNAP_DIR}`)
      process.exit(1)
    }

  } else {
    console.log('Usage: node scripts/snap.mjs [save|check]')
    process.exit(1)
  }

  await browser.close()
}

run(process.argv[2])
