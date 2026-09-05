#!/bin/bash
# SPDX-License-Identifier: MIT
# Part of AI Teleprompter, a fork of openTeleprompt (MIT).
#
# readme-shots-real.sh — captures the README screenshots from the LIVE app
# (docs/screenshots/), replacing the headless-Chrome renders made by
# readme-shots.mjs. Launches the installed app once per UI state using the
# dev-only demo hooks (see docs/ARCHITECTURE.md), reads the prompter window
# bounds via CGWindowList, and region-captures it with `screencapture`.
#
# Requires: the invoking terminal app must hold macOS Screen Recording
# permission (System Settings → Privacy & Security → Screen & System Audio
# Recording). Prefers per-window capture (`screencapture -l`, clean window +
# alpha); if that fails it falls back to full-desktop region capture, which
# also grabs whatever is behind the window — close/hide anything sensitive
# near the top-center of the main display in that case.
set -euo pipefail

APP="${TELEPROMPTER_APP:-/Applications/AI Teleprompter.app}/Contents/MacOS/ai-teleprompter"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/docs/screenshots"
TMP_DIR="$(mktemp -d)"
trap 'pkill -f ai-teleprompter 2>/dev/null || true; rm -rf "$TMP_DIR"' EXIT

[ -x "$APP" ] || { echo "app not found at $APP — install the DMG first" >&2; exit 1; }

cat > "$TMP_DIR/preflight.swift" <<'EOF'
import CoreGraphics
exit(CGPreflightScreenCaptureAccess() ? 0 : 1)
EOF
if ! swift "$TMP_DIR/preflight.swift"; then
  echo "no Screen Recording permission for this terminal app." >&2
  echo "grant it in System Settings → Privacy & Security → Screen & System Audio Recording," >&2
  echo "then FULLY quit (⌘Q) and reopen the terminal app and re-run this script." >&2
  exit 1
fi

# Prints "id x y w h" (points) for the prompter window: owned by the app,
# not the status-bar item, widest wins.
cat > "$TMP_DIR/bounds.swift" <<'EOF'
import CoreGraphics
import Foundation
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
var best: [String: Any]? = nil
var bestW = 0.0
for w in list {
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    guard owner.contains("Teleprompter") else { continue }
    let name = w[kCGWindowName as String] as? String ?? ""
    guard name != "Item-0" else { continue }
    guard let b = w[kCGWindowBounds as String] as? [String: Double] else { continue }
    if (b["Width"] ?? 0) > bestW { best = w; bestW = b["Width"]! }
}
guard let w = best, let b = w[kCGWindowBounds as String] as? [String: Double],
      let id = w[kCGWindowNumber as String] as? Int else { exit(1) }
print("\(id) \(Int(b["X"]!)) \(Int(b["Y"]!)) \(Int(b["Width"]!)) \(Int(b["Height"]!))")
EOF

# name|demo params|side pad (points). Same states as readme-shots.mjs; the
# window is top-anchored in notch mode, so capture from y=0 through h+pad.
SHOTS=(
  'pill-idle|view=idle&mode=notch&theme=dark&hoverdemo=1|24'
  'word-tracking|view=read&mode=notch&theme=dark&trackdemo=1|28'
  'editor|view=edit&mode=notch&theme=dark|28'
  'ai-review|view=edit&mode=notch&theme=dark&aisetup=1|28'
)

mkdir -p "$OUT_DIR"
for shot in "${SHOTS[@]}"; do
  IFS='|' read -r name params pad <<< "$shot"
  pkill -f ai-teleprompter 2>/dev/null || true
  sleep 1
  TELEPROMPTER_ALLOW_CAPTURE=1 TELEPROMPTER_DEMO_PARAMS="$params" "$APP" >/dev/null 2>&1 &
  sleep 6  # window creation + 1.5s delayed demo navigation + settle
  read -r id x y w h <<< "$(swift "$TMP_DIR/bounds.swift")"
  if screencapture -x -o -l "$id" "$OUT_DIR/$name.png" 2>/dev/null; then
    echo "  ✅  $name.png (window $id, ${w}x${h})"
  else
    screencapture -x -R"$((x - pad)),0,$((w + pad * 2)),$((y + h + pad))" "$OUT_DIR/$name.png"
    echo "  ✅  $name.png (region fallback, ${w}x${h} @ ${x},${y})"
  fi
done

pkill -f ai-teleprompter 2>/dev/null || true
echo
echo "✨  Wrote ${#SHOTS[@]} screenshots to $OUT_DIR — review them before committing."
