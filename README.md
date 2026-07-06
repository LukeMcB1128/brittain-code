# Brittain Code

A fully offline coding agent desktop app, in the style of Claude Code / Codex, powered by your local Ollama models. No internet, no API keys, no backend server — the app talks directly to Ollama at `localhost:11434`.

## Run it

```
npm install   # first time only
npm start
```

Ollama must be running (`ollama serve`, or the menu bar app).

## The double-clickable app (.app)

The standalone app lives at `dist/mac-arm64/Brittain Code.app`. Drag it into Applications or the Dock to launch it without a terminal.

The `.app` is a snapshot of the code at build time — editing `main.js` or the `renderer/` files does **not** change it. After making changes, rebuild it:

```
npm run dist
```

Then replace the old copy in Applications with the fresh one from `dist/mac-arm64/`. (During development, `npm start` always runs the live code — only rebuild when you want the packaged app updated.)

To give it a custom icon: put an `icon.icns` in a `build/` folder, add `"icon": "build/icon.icns"` under the `"mac"` section of `package.json`, and rebuild.

## Using it

1. Pick a model from the dropdown (top left). Models that support tool calling work best — **qwen3-coder:30b** is your strongest, **qwen3:8b** is a fast fallback. Gemma models don't support tool calls and will chat only.
2. Click **DIR** and choose the project folder the agent should work in.
3. Type a task and hit Enter.

The agent can read files, write files, list directories, search (grep), and run shell commands. By default it asks before **writes and shell commands** (approve/deny bar appears above the input). Flip **AUTO-APPROVE** in the top bar to let it run unattended.

The status bar shows: current state, context usage (tokens used vs the model's context window, with a fill bar), elapsed time for the current run, and total tool calls.

**NEW SESSION** clears the conversation (context resets to zero).

## Code layout — where to modify things

| File | What it does |
|---|---|
| `main.js` | Everything important: the agent loop, tool definitions (`TOOL_DEFS`), tool implementations (`executeTool`), the system prompt (`systemPrompt`), Ollama streaming. Add a new tool here in two places: a definition and a `case` in `executeTool`. |
| `renderer/app.js` | UI behavior: sending, streaming display, timers, approval buttons. |
| `renderer/style.css` | All styling. Colors are CSS variables at the top. |
| `renderer/index.html` | The layout skeleton. |
| `preload.js` | The IPC bridge — only touch when adding a new message channel. |

Knobs at the top of `main.js`: `MAX_TOOL_OUTPUT` (chars of tool output the model sees), `MAX_AGENT_STEPS` (tool-loop cap), `RISKY_TOOLS` (which tools need approval).
