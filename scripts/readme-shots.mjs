// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
/**
 * readme-shots.mjs — renders the README screenshots (docs/screenshots/) at
 * 2x DPI using the same URL demo hooks as the visual snapshot suite.
 *
 * Usage: npm run dev:react   (dev server on :1420)
 *        node scripts/readme-shots.mjs
 *
 * Note: these are UI renders via headless Chrome. Capturing the live app
 * window instead (screencapture + TELEPROMPTER_ALLOW_CAPTURE=1) requires the
 * invoking terminal to hold a current macOS Screen Recording permission.
 */

import puppeteer from 'puppeteer-core'
import fs from 'fs'
import path from 'path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE_URL = 'http://localhost:1420'
const OUT_DIR = path.resolve('docs/screenshots')

const SHOTS = [
  { file: 'pill-idle.png', url: '?view=idle&mode=notch&theme=dark&hoverdemo=1', pad: 24 },
  { file: 'word-tracking.png', url: '?view=read&mode=notch&theme=dark&trackdemo=1', pad: 28 },
  { file: 'editor.png', url: '?view=edit&mode=notch&theme=dark', pad: 28 },
  { file: 'ai-review.png', url: '?view=edit&mode=notch&theme=dark&aireview=1', pad: 28 },
]

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})

fs.mkdirSync(OUT_DIR, { recursive: true })

for (const { file, url, pad } of SHOTS) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  await page.goto(`${BASE_URL}/${url}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#island')
  await new Promise(r => setTimeout(r, 700))

  const box = await page.$eval('#island', el => {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  })
  const clip = {
    x: Math.max(0, box.x - pad),
    y: 0,
    width: box.width + pad * 2,
    height: box.height + pad,
  }
  await page.screenshot({ clip, type: 'png', path: path.join(OUT_DIR, file) })
  console.log(`  ✅  ${file}`)
  await page.close()
}

await browser.close()
console.log(`\n✨  Wrote ${SHOTS.length} screenshots to ${OUT_DIR}`)
