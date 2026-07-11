# Brittain Code

A local-first coding agent desktop app, in the style of Claude Code / Codex, powered by your local Ollama models. Inference, chats, project memory, and ordinary tools stay on your Mac; optional online research is disabled by default. No backend server or model API key is required — the app talks directly to Ollama at `localhost:11434`.

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
npm run deploy
```

This rebuilds and copies the app straight into /Applications — no dragging. (`npm run dist` builds without deploying; during development, `npm start` always runs the live code.)

To give it a custom icon: put an `icon.icns` in a `build/` folder, add `"icon": "build/icon.icns"` under the `"mac"` section of `package.json`, and rebuild.

## Using it

1. Pick a model from the dropdown (top left). Models that support tool calling work best — **qwen3.6:27b** and **gemma4:26b** are the strongest for agent tasks, **qwen3:8b** and **gemma4:latest** are fast fallbacks. qwen3-coder:30b sometimes emits malformed tool calls; tiny models (qwen2.5-coder:1.5b) are chat-only.
2. Click **DIR** and choose the project folder the agent should work in.
3. Type a task and hit Enter.

The agent can inspect and edit files, search source and locally installed documentation, run declared project checks, inspect Git state, manage local development processes, verify loopback HTTP servers, and run shell commands. File tools are confined to the selected project directory. It asks before writes, commands, and other risky operations. **AUTO-APPROVE** can make ordinary risky tools unattended, but online requests and sensitive reads always require explicit approval.

Coordinated edits can use an atomic multi-file batch: every exact match and syntax check must pass before target files are replaced. Managed background processes receive opaque IDs, keep bounded logs, and are stopped when the app quits.

`revert_to_last_commit` can return selected paths or the whole working tree to `HEAD`. It previews by default and always requires explicit approval to execute. Before changing the working tree it creates a named Git stash, allowing recovery with the command returned in the tool result. Untracked files require an explicit option; ignored files and submodule contents are preserved.

The status bar shows: current state, context usage (tokens used vs the model's context window, with a fill bar), elapsed time for the current run, and total tool calls.

**NEW SESSION** clears the conversation (context resets to zero).

Chats are saved automatically as individual JSON files in `~/Library/Application Support/Brittain Code/chats/` (with an `index.json` for the sidebar). They survive app updates and rebuilds, and are never included in the built app. The sidebar groups chats by project folder. Loading a chat restores its model, directory, THINK, and AUTO-APPROVE states, but never restores ONLINE RESEARCH.

## Online research

**ONLINE RESEARCH** is an explicit session-only switch. Enabling it warns that search queries and requested URLs leave the Mac. It exposes two additional model tools:

- `web_search` sends a redacted, length-limited query to DuckDuckGo's no-JavaScript HTML search. Optional domain filters and result caps are supported.
- `web_fetch` retrieves a public HTTPS page as sanitized plain text. It rejects local/private/reserved destinations and URL credentials, validates every redirect, refuses non-text content, strips scripts and styles, and caps both downloads and returned text.

Every online tool call shows its exact query or URL and asks for approval, even if AUTO-APPROVE is enabled. Results are marked as untrusted external content in both the tool output and model instructions. The no-key HTML search provider is best-effort and may occasionally return a challenge page or change its markup.

The inference model remains local while online research is enabled, but the session is no longer fully offline. Shell commands are normal host processes and may also use installed network-capable programs when the user approves them; Brittain Code is not an operating-system network sandbox.

Sensitive file reads (`.env`, private-key formats, credential files), process listings, and environment inspection also bypass AUTO-APPROVE. Environment values are redacted by default; explicitly revealed values and all other tool results become part of persisted chat history.

## Slash commands

Type these in the message box:

| Command | What it does |
|---|---|
| `/help` | List all commands |
| `/clear` | New session |
| `/compact` | Summarize the conversation to free up context (great for long agent sessions on small-context models) |
| `/diff` | Show the git diff of the working directory in an overlay |
| `/commit <message>` | Stage everything and commit |
| `/model <name>` | Switch model (partial match) |
| `/coder [name]` | Show or set the writable coding-worker model (default qwen3-coder:30b when installed) |
| `/subagent [name]` | Show or set the subagent/verifier model (default qwen3:8b) |
| `/loop [n] <goal>` | Work toward a goal for up to n iterations (default 8); a verifier subagent judges completion, and context auto-compacts between iterations. Turn AUTO-APPROVE on for unattended runs |
| `/orchestrate <goal>` | Use the selected model as a read-only planner, delegate sequential tasks to the coder model, and verify each task with the subagent model |
| `/usage` | Show context remaining and token spend across planner/main agent, scouts, coders, and verifier |
| `/memory` | View what the agent has remembered for the selected project |
| `/export` | Save the chat as a markdown file |
| `/tools` | List available tools and their risky, sensitive, or network classification |

## Offline orchestration

`/orchestrate` separates planning from implementation while keeping inference local. The model in the main dropdown inspects the project and submits a structured plan, `/coder` selects the model that edits and verifies code, and `/subagent` selects the read-only scout/verifier. Tasks run sequentially to avoid loading multiple large Ollama models at once. Each failed verification gets one bounded repair attempt. Planner and coder contexts checkpoint automatically at 70% usage, with at most two compactions per stage; every coder task still starts with a fresh context. The final chat response stays concise; use DIFF when you want the complete patch and working-tree detail.

The planner can use `web_search` and `web_fetch` only when ONLINE RESEARCH is enabled, with the same per-request approval boundary as ordinary chats. Coding workers and verifiers never receive network tools. Restart Brittain Code after installing a new Ollama model so the model list refreshes; for example, `gpt-oss:20b` can then be selected in the main dropdown, with `/coder gpt-oss:20b`, or with `/subagent gpt-oss:20b` for role-by-role comparison.

## Git, project instructions, memory, images

- When DIR is a git repo, the status bar shows the branch and changed-file count, with **DIFF** and **COMMIT** buttons. The diff refreshes after every agent run — review what it changed before committing.
- Put a **`BRITTAIN.md`** in any project folder and its contents are added to the system prompt for chats in that folder (like Claude Code's CLAUDE.md) — conventions, build commands, things the agent should know.
- The agent saves cross-chat lessons per project under `~/Library/Application Support/Brittain Code/memory/projects/`. Nothing is written into the project itself. Use `/memory` to view the selected project's file and its exact location. The former universal `memory.md`, if present, remains visible as legacy data but is no longer injected into prompts.
- Attach images with the **IMG** button or paste them into the text box (vision-capable models only).
- **Esc** stops a running generation. Speed (tokens/sec) shows in the status bar after each response.

## Code layout — where to modify things

| File | What it does |
|---|---|
| `main.js` | The agent loop, system prompt, Ollama streaming, persistence, subagents, and application IPC handlers. |
| `tools.js` | Tool schemas, implementations, managed processes, network guards, and risky/network/sensitive approval classifications. Add or change tools here. |
| `renderer/app.js` | UI behavior: sending, streaming display, timers, approval buttons. |
| `renderer/style.css` | All styling. Colors are CSS variables at the top. |
| `renderer/index.html` | The layout skeleton. |
| `preload.js` | The IPC bridge — only touch when adding a new message channel. |

Important limits: `MAX_AGENT_STEPS` and `NUM_CTX_CAP` live near the top of `main.js`; output, process-log, network-download, and tool-specific caps live in `tools.js`.
