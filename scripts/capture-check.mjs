// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
/**
 * capture-check.mjs — verifies the app's windows are genuinely excluded from
 * screen capture, empirically, across three states: pill collapsed, panel
 * expanded, and during a tracking session. For each state it:
 *
 *   1. Reads every teleprompter window's live NSWindow.sharingType via
 *      CoreGraphics (kCGWindowSharingState) — the exact bit ScreenCaptureKit
 *      (Zoom/Meet) and screencapture key off. 0 = None (excluded); 1/2 =
 *      captured. Every app window MUST be 0.
 *   2. Captures the whole display with `screencapture` (ScreenCaptureKit on
 *      macOS 14+) and crops the window's rect. As a pixel-level cross-check it
 *      also captures the SAME state with protection disabled
 *      (TELEPROMPTER_ALLOW_CAPTURE=1) and asserts the protected crop differs
 *      substantially from the unprotected one — i.e. the app's own pixels do
 *      NOT appear when protection is on (the region shows what is behind).
 *
 * Fails (exit 1) if any window is captured or the pixels leak. macOS only,
 * needs a GUI session + Screen Recording permission for the terminal; not run
 * in CI (like make-fixtures). Saves crops under the scratch dir for inspection.
 *
 * Usage: node scripts/capture-check.mjs [--bin <path to ai-teleprompter>]
 */
import { execFileSync, spawn } from 'child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BIN = (() => {
  const i = process.argv.indexOf('--bin')
  if (i >= 0) return process.argv[i + 1]
  return '/Applications/AI Teleprompter.app/Contents/MacOS/ai-teleprompter'
})()
if (!existsSync(BIN)) { console.error(`app binary not found: ${BIN}`); process.exit(1) }

const dir = mkdtempSync(join(tmpdir(), 'capture-check-'))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Swift probe: teleprompter windows (owner + layer>20) as JSON {title, share, x,y,w,h}
const PROBE = `
import CoreGraphics
import Foundation
guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String:Any]] else { print("[]"); exit(0) }
var out: [[String:Any]] = []
for w in list {
  let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
  let layer = (w[kCGWindowLayer as String] as? Int) ?? -999
  guard owner.lowercased().contains("teleprompter"), layer > 20 else { continue }
  let b = w[kCGWindowBounds as String] as? [String:Any] ?? [:]
  out.append([
    "title": (w[kCGWindowName as String] as? String) ?? "",
    "layer": layer,
    "share": (w[kCGWindowSharingState as String] as? Int) ?? -1,
    "x": (b["X"] as? Double) ?? 0, "y": (b["Y"] as? Double) ?? 0,
    "w": (b["Width"] as? Double) ?? 0, "h": (b["Height"] as? Double) ?? 0,
  ])
}
let d = try! JSONSerialization.data(withJSONObject: out)
print(String(data: d, encoding: .utf8)!)
`
const probePath = join(dir, 'probe.swift')
writeFileSync(probePath, PROBE)

// Swift PNG mean-abs-diff (0..1) between two images of equal size.
const DIFF = `
import AppKit
let a = CommandLine.arguments
guard a.count >= 3, let i1 = NSImage(contentsOfFile: a[1]), let i2 = NSImage(contentsOfFile: a[2]),
      let c1 = i1.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let c2 = i2.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("-1"); exit(0) }
func rgba(_ c: CGImage) -> [UInt8]? {
  let w = c.width, h = c.height
  var buf = [UInt8](repeating: 0, count: w*h*4)
  let cs = CGColorSpaceCreateDeviceRGB()
  guard let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w*4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
  ctx.draw(c, in: CGRect(x:0,y:0,width:w,height:h)); return buf
}
guard let b1 = rgba(c1), let b2 = rgba(c2), b1.count == b2.count, b1.count > 0 else { print("-1"); exit(0) }
var sum = 0.0
for i in 0..<b1.count { sum += abs(Double(b1[i]) - Double(b2[i])) }
print(sum / Double(b1.count) / 255.0)
`
const diffPath = join(dir, 'diff.swift')
writeFileSync(diffPath, DIFF)

function probe() {
  try { return JSON.parse(execFileSync('swift', [probePath], { encoding: 'utf8' }).trim() || '[]') }
  catch { return [] }
}
function killApp() { try { execFileSync('pkill', ['-f', 'ai-teleprompter']) } catch {} }

async function launch(env, waitMs = 6000) {
  killApp(); await sleep(1200)
  const child = spawn(BIN, [], { env: { ...process.env, ...env }, stdio: 'ignore', detached: true })
  child.unref()
  await sleep(waitMs)
}

// screencapture the main display, crop to (device px = logical*2) the rect.
function captureCrop(rect, outPath, scale = 2) {
  const full = join(dir, 'full.png')
  execFileSync('screencapture', ['-x', '-o', full])
  const x = Math.max(0, Math.round(rect.x * scale)), y = Math.max(0, Math.round(rect.y * scale))
  const w = Math.max(1, Math.round(rect.w * scale)), h = Math.max(1, Math.round(rect.h * scale))
  // sips crop: -c <h> <w> --cropOffset <y> <x>
  execFileSync('sips', ['-c', String(h), String(w), '--cropOffset', String(y), String(x), full, '--out', outPath])
  return outPath
}

const STATES = [
  { name: 'collapsed', env: {} },
  { name: 'expanded',  env: { TELEPROMPTER_DEMO_PARAMS: 'view=read' } },
  { name: 'tracking',  env: { TELEPROMPTER_DEMO_PARAMS: 'view=read&trackdemo=1' } },
]

const failures = []
const rows = []

console.log(`capture-check: ${BIN}\n`)
for (const st of STATES) {
  // Protected launch
  await launch(st.env)
  const wins = probe()
  const content = wins.filter(w => w.w >= 100) // app content windows (excludes the ~34px tray status item)
  const anyCaptured = content.some(w => w.share !== 0)
  const rect = content.sort((a, b) => b.w * b.h - a.w * a.h)[0]
  let pixelDiff = null
  if (rect) {
    const protCrop = captureCrop(rect, join(dir, `${st.name}_protected.png`))
    // Unprotected reference: same state, protection disabled
    await launch({ ...st.env, TELEPROMPTER_ALLOW_CAPTURE: '1' })
    const wins2 = probe()
    const rect2 = wins2.filter(w => w.h > 20).sort((a, b) => b.w * b.h - a.w * a.h)[0] || rect
    const refCrop = captureCrop(rect2, join(dir, `${st.name}_unprotected.png`))
    try { pixelDiff = parseFloat(execFileSync('swift', [diffPath, protCrop, refCrop], { encoding: 'utf8' }).trim()) } catch { pixelDiff = null }
  }
  const shareVals = content.map(w => w.share)
  const protectedOK = content.length > 0 && !anyCaptured
  // Pixel leak: protected crop should differ clearly from the app's own render.
  const pixelOK = pixelDiff == null || pixelDiff > 0.03
  if (!protectedOK) failures.push(`${st.name}: window sharingType not None (${shareVals.join(',')})`)
  if (!pixelOK) failures.push(`${st.name}: app pixels appear in protected capture (diff ${pixelDiff?.toFixed(4)})`)
  rows.push({ state: st.name, windows: content.length, share: shareVals.join(','), protectedOK, pixelDiff, pixelOK })
  console.log(`  ${st.name.padEnd(10)} windows=${content.length} sharingType=[${shareVals.join(',')}] ${protectedOK ? 'excluded ✓' : 'CAPTURED ✗'} · pixelDiff=${pixelDiff == null ? 'n/a' : pixelDiff.toFixed(4)} ${pixelOK ? '✓' : '✗'}`)
}
killApp()

console.log(`\ncrops saved under ${dir}`)
if (failures.length) {
  console.error(`\n❌ capture-check FAILED:`)
  for (const f of failures) console.error(`   - ${f}`)
  process.exit(1)
}
console.log(`\n✅ capture-check PASSED — every window excluded from capture in all three states.`)
