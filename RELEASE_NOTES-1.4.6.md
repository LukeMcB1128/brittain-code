Brittain Code 1.4.6 — a local-first coding agent for Ollama-compatible models. Inference, chats, project memory, and ordinary tools stay on your machine; online research stays off unless you turn it on.

***Note: this covers everything since 1.4.1. The README has the full picture.***

## Downloads

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Brittain Code-1.4.6-arm64.dmg` |
| macOS (Intel) | `Brittain Code-1.4.6.dmg` |
| Windows x64 | `Brittain Code Setup 1.4.6.exe` |

Ollama must be running (`ollama serve`). These builds are unsigned, so macOS wants right-click → **Open** on the first launch and Windows shows SmartScreen → **More info** → **Run anyway**.

## Auto-updates, on Windows

Windows release builds now check GitHub Releases for a newer stable version, download it in the background, show progress, and offer **RESTART TO UPDATE** when it is ready. If a run or mission is going, the restart is refused rather than killing the work. This is the first release carrying the updater, so 1.4.6 itself has to be installed by hand; later versions can update themselves.

macOS updates stay manual. Squirrel.Mac will not replace an app whose Developer ID signature it cannot verify, and these builds are ad-hoc signed, so a mac updater would download an update it could never install. Rather than ship that, the updater is off on macOS and the app says so instead of pretending to check. Grab the new dmg when there is one.

Updates are also off for `npm start`, ordinary local `dist` builds, and `npm run deploy`. The release job runs the tests, builds both macOS architectures and a Windows x64 installer, uploads them into a draft, and publishes only when both platforms succeed.

## New commands

`/plan <goal>` runs a read-only planning pass first. The planner returns a summary and up to six tasks, each with an objective, acceptance criteria, relevant files, and constraints. That comes back as an editable card — change the fields, add or drop tasks, then press RUN and the exact plan you approved goes to the coder. The planner does not get a second turn.

`/auto <request>` replaces `/best`. It looks at what you actually have installed, picks a model based on Code or Chat mode, tool support, image support if there are attachments, memory fit, Brittainmark results, measured speed, and recommendation order, switches to it, and runs the request. Reference models you have not installed are never chosen.

`/review [base]` now asks for structured findings instead of prose. Each finding carries a severity, a confidence, a file and line, evidence, and a suggested fix. The list is sorted in the UI, and you tick the ones you want and send only those to the coder. Review and implementation stay separate, and which fixes happen is your call.

`/recs` (the old `/recommendations`, renamed because nobody wants to type that) reads your installed models from Ollama and shows quantization, parameter count, requested and native context, estimated or measured memory use, whether it fits, tool/image/thinking support, measured tokens per second, Brittainmark score, and preset labels like STRONG AGENT, CODE, and FAST.

Context controls: `/context`, `/pin list`, `/pin message <n>`, `/pin file <path>`, `/unpin message <n>`, `/unpin file <path>`, `/exclude <n>`, `/include <n>`. Pinned messages survive context construction. Pinned files have to live inside the selected project, symlink escapes are rejected, they are re-read before every request, they have per-file and total size limits, and they persist with the chat. Excluding a tool result leaves it in your history but sends a short placeholder to the model, so you can drop 4,000 lines of test output without deleting the record of it.

## Memory estimates that are actually correct

The old estimator treated a quantized model as if it were full-precision weights, which made the memory numbers wrong in the direction that matters. It now starts from the real quantized size Ollama reports, and it understands Ollama KV cache types (`f16`, `q8_0`, `q4_0`), hybrid attention, sliding-window layers, per-layer KV head arrays, multi-head latent attention, tensor dimensions from verbose Ollama metadata, and the loaded footprint from `/api/ps`.

Hardware detection uses `systeminformation` for GPU and VRAM, `process.getSystemMemoryInfo()` for system memory, unified-memory rules on Apple Silicon, and normal RAM plus dedicated VRAM everywhere else. Speed samples come from saved chats and benchmark runs, with the model digest, hardware, and context used to throw out comparisons that are not comparable.

The math lives in `recommendations.js`; the Electron side is `src/main/recommendations-service.js`.

## Recommendations before you own any models

If Ollama is running but empty, `/recs` shows recorded results from an M3 Max with 36 GB of unified memory: `qwen3.6:27b`, `gpt-oss:20b`, `qwen3-coder:30b`, `gemma4:26b`, `gemma4:latest`, and `qwen3:8b`, each with quantization, measured speed, capabilities, and Brittainmark numbers. They are labelled as not installed, reference results, recorded on another device — a speed measured on someone else's machine is not an estimate for yours, and the UI does not pretend otherwise.

For those entries the USE action becomes INSTALL, which runs `ollama pull <model>` with the model name validated, no shell interpolation, local Ollama endpoints only, `OLLAMA_HOST` respected for alternate local ports, live percentage updates, duplicate installs blocked, child processes cleaned up on exit, and the model list refreshed when it finishes. The data is in `model-baselines.json`.

## Agent tools

**`apply_patch`** takes a standard unified diff across several files at once. Dry run is the default. Every path and hunk is validated before anything is written, paths are confined to the project directory, JavaScript and JSON are syntax-checked, creation and deletion work, binary patches and renames are rejected, temp files and backups are used, and a failure rolls the whole batch back. The point is that a half-applied edit cannot survive a failure, which is exactly what a sequence of independent writes cannot promise.

**Semantic navigation** adds `project_outline`, `find_symbol`, and `find_references`, covering common JavaScript, TypeScript, Python, Go, Rust, Ruby, C, C++, and Java patterns. They return project-relative paths with symbol types and line numbers, skip dependencies and generated directories, enforce file and result limits, and do not follow symlinks. `find_references` is lexical — it is navigation, not a language server, and it will not resolve what a compiler would.

**Local browser tools** let the coding agent test a web app you are running locally: `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_console`, `browser_screenshot`, `browser_close`. These are hidden sandboxed Electron windows restricted to `localhost`, `127.0.0.0/8`, and `::1`. External navigation, external resources, new windows, and credentials in URLs are all blocked; sessions get temporary isolated partitions and close with the app. This is an application-testing tool, not general web browsing.

## Mission recovery

A mission can now survive the app closing. The recovery record holds the canonical project path, the current commit, a fingerprint of the staged and unstaged diff, untracked file contents, the checkpoint reference and commit, and the mission phase and evidence.

`/mission resume` only works when all of that still matches. It refuses if the project changed, if HEAD moved, if the working tree changed, if an untracked file changed, if the checkpoint is gone, or if you are in a different chat. A resumed mission acting on a project that moved underneath it is worse than no resume at all.

Mission cards also stay where they belong: a card shows up only when you have the right chat open, in Code mode, with the mission's project selected. No more missions appearing in unrelated conversations.

## Diff v2

`/diff` was rebuilt. Staged, unstaged, and untracked are separate sections now, with per-file navigation, addition and deletion counts, patch line numbers, collapsible files, text previews for untracked files, binary handling, and bounded previews for large files. Still read-only.

## Live formatting

Assistant responses render Markdown while the tokens are still arriving, so headings, lists, and code blocks stop showing up as raw text until the response lands. Workflow reports got the same attention: clear success and failure markers, shortened paths, changed files and verification split apart, and better orchestration, loop, and mission summaries.

## Benchmark fixes

The Ollama benchmark provider was hitting a hidden five-minute `fetch` header timeout, which quietly capped long generations. It now uses a Node HTTP request driven by the benchmark's own abort signal.

`--run-timeout <minutes>` was added, defaulting to 15, and resumed batches reuse the saved value. A real model timeout scores zero. An Ollama crash or a dropped connection is infrastructure, stays a retryable error, and is not held against the model.

## Repo structure

`main.js`, `tools.js`, and the renderer were broken up. Main-process services are now separate modules for hardware profiling, recommendations, benchmark access, history storage, checkpoints, model routing, diffs, code review, mission recovery, context controls, model installation, and updates. Renderer features and their CSS are split for recommendations, plan drafts, the diff viewer, and review findings. Tool code moved out into `src/tools/policy.js` for role-specific permissions, `src/tools/apply-patch.js` for atomic patching, and `src/tools/semantic-navigation.js` for navigation.

`tools.js` is still there and still needed — it holds the central registry, a lot of the existing tool implementations, and the routing into the extracted modules. It is not ready to delete and this release does not pretend otherwise.

## Housekeeping

64 files changed, roughly 6,800 lines added and 500 removed. All 137 product tests pass. The production dependency audit is clean; the older dev and build dependency tree still has npm audit warnings that predate this work and were left alone.

**Full changelog**: https://github.com/LukeMcB1128/brittain-code/compare/v1.4.1...v1.4.6
