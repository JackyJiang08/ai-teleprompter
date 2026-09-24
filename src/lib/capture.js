// SPDX-License-Identifier: MIT
// Part of AI Teleprompter, a fork of openTeleprompt (MIT).
//
// Interprets a `capture_debug` snapshot from the backend (each window's live
// NSWindow.sharingType plus the config gate) into a single "are the app's
// windows excluded from screen capture right now?" boolean for the UI. True
// only when protection is effective (config on, not overridden by the dev
// escape hatch) AND every window actually reports sharingType none.

export function captureExcluded(status, fallback = false) {
  if (!status || typeof status !== 'object') return fallback
  const windows = Object.values(status.windows || {})
  return !!status.effective && windows.length > 0 && windows.every(w => w && w.protected)
}
