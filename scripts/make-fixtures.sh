#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Part of AI Teleprompter, a fork of openTeleprompt (MIT).
#
# make-fixtures.sh — regenerates the synthetic-voice tracking fixtures under
# tests/fixtures/tracking/. For each source script it synthesizes audio with
# macOS `say`, converts it to the canonical feed format, runs the real speech
# sidecar in --audio-file mode with the matching --script/--contextual
# inputs, and saves the full NDJSON stream as a gzipped fixture (the same
# shape ?trackrecord=1 records). Voice/rate/alteration metadata is embedded
# in each fixture.
#
# Needs macOS with `say`, `afconvert`, on-device en-US speech recognition,
# and a built sidecar (scripts/build-sidecar.sh). Takes ~15 minutes — audio
# feeds at real-time pace. NOT run in CI; CI replays the committed fixtures
# (src/lib/__tests__/tracking-suite.test.js).
#
# Usage: scripts/make-fixtures.sh [--only <name-substring>]
set -euo pipefail
cd "$(dirname "$0")/.."

command -v say >/dev/null || { echo "needs macOS 'say'" >&2; exit 1; }
command -v afconvert >/dev/null || { echo "needs macOS 'afconvert'" >&2; exit 1; }
[ -x src-tauri/binaries/speech-sidecar-aarch64-apple-darwin ] || {
  echo "sidecar not built — run scripts/build-sidecar.sh first" >&2
  exit 1
}

exec node scripts/make-fixtures.mjs "$@"
