# Contributing to AI Teleprompter

Thanks for your interest! Here's how to contribute.

## Ground rules

- **No direct pushes to `main`** — all changes go through a Pull Request
- Every PR requires **1 approving review** from [@JackyJiang08](https://github.com/JackyJiang08)
- Keep PRs focused — one feature or fix per PR
- Test on macOS before submitting

## Getting started

```bash
git clone https://github.com/JackyJiang08/ai-teleprompter
cd ai-teleprompter
npm install
npm run dev   # requires Rust + Cargo, Node 18+, Xcode Command Line Tools (Swift)
```

## Word-tracking scripts (macOS)

- `npm test` — the full unit + fixture-replay suite (runs in CI, no speech dependency).
- `npm run smoke` — end-to-end live-chain smoke test: builds the sidecar and feeds a clip through it, asserting session rotation, real timestamps, VAD edges, and first-word recall (needs macOS on-device dictation; skips cleanly if unavailable).
- `npm run replay` — replays the committed tracking fixtures through the matcher and prints the metrics table (cross-sentence jumps, overshoot, final error, first-word recall, display stall).
- `npm run fixtures` — regenerates the synthesized-voice fixtures from macOS `say` through the real recognizer (~15 min, not run in CI; needs a built sidecar).

## Submitting a PR

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-feature`
3. Make your changes
4. Test thoroughly on macOS
5. Open a PR against `main` with a clear description

## What we welcome

- Bug fixes
- Performance improvements
- New features that fit the app's minimal philosophy
- Accessibility improvements
- Documentation improvements

## What we'll likely decline

- Breaking the single-file renderer architecture
- Adding heavy dependencies
- Features that compromise privacy (no cloud, no tracking — ever)
