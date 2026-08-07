# Brittain Code

A local-first coding agent and general chat desktop app powered by Ollama-compatible models. Inference, chats, project memory, and ordinary tools stay on your machine by default; optional online research is disabled by default. No model API key is required — the default endpoint is Ollama at `localhost:11434`, and Settings can point the app at another compatible host or port.

Runs on macOS and Windows.

## Run it

```
npm install   # first time only
npm start
```

Ollama must be running (`ollama serve`, or the menu bar app).

## Installable builds

| Command | Output |
|---|---|
| `npm run dist` | macOS `.dmg` and `.zip` |
| `npm run dist:win` | Windows x64 NSIS installer |
| `npm run dist:all` | both |
| `npm run deploy` | macOS: build and copy straight into /Applications |

On macOS the standalone app lands in `dist/mac-arm64/Brittain Code.app`; drag it into Applications or the Dock to launch it without a terminal. Builds are unsigned, so the first launch needs the usual right-click → Open (macOS) or SmartScreen "More info" → "Run anyway" (Windows).

The built app is a snapshot of the code at build time — editing `main.js` or the `renderer/` files does **not** change it; rebuild after changes. During development, `npm start` always runs the live code.

## Using it

1. Choose **CODE** for project work or **CHAT** for folder-free conversation and research.
2. Pick a model from the dropdown. Models that support tool calling work best — **qwen3.6:27b** and **gemma4:26b** are the strongest for agent tasks, **qwen3:8b** and **gemma4:latest** are fast fallbacks. qwen3-coder:30b sometimes emits malformed tool calls; tiny models (qwen2.5-coder:1.5b) are chat-only.
3. In Code mode, click **DIR** and choose the project folder the agent should work in. Chat mode deliberately has no directory or project tools.
4. Type a task or question and hit Enter.

The agent can inspect and edit files, search source and locally installed documentation, run allowlisted project checks, inspect Git state, manage local development processes, verify loopback HTTP servers, and run shell commands. `run_project_check` discovers npm-compatible scripts, CMake configure/build/CTest flows, Cargo, Go, Python/pytest, and safe Make targets; every command runs without a shell. File tools are confined to the selected project directory. It asks before writes, commands, and other risky operations. **AUTO-APPROVE** can make ordinary risky tools unattended, but online requests and sensitive reads always require explicit approval.

If Ollama rejects malformed tool-call JSON, Brittain Code discards that call and retries generation once with strict formatting and THINK disabled. A second rejection stops safely with a concise model-format error; malformed arguments are never reconstructed or executed.

### Model degradation detection

Local models degrade before they fail loudly — glitch tokens, byte-fallback artifacts, self-talk leaking into written files, and runaway repetition. Brittain Code scans generated content and tool arguments for those signatures inside the streaming layer, so every caller (main agent, subagent, verifier, coder) is protected without per-call-site changes. A detected episode recovers with a context compaction — the "sanity reset" that empirically clears it — rather than silently writing corrupted code, and gives up honestly if it recurs.

### Undoing a run

Before every Code-mode run in a Git repo, the app takes a silent checkpoint of the working tree, so **UNDO RUN** restores it even if you never committed. UNDO itself snapshots first, so it is also undoable. Optional **auto-branch** moves work onto a generated `brittain/<slug>` branch before the agent touches anything, keeping your current branch clean.

Coordinated edits can use an atomic multi-file batch: every exact match and syntax check must pass before target files are replaced. Managed background processes receive opaque IDs, keep bounded logs, and are stopped when the app quits.

`revert_to_last_commit` can return selected paths or the whole working tree to `HEAD`. It previews by default and always requires explicit approval to execute. Before changing the working tree it creates a named Git stash, allowing recovery with the command returned in the tool result. Untracked files require an explicit option; ignored files and submodule contents are preserved.

The status bar shows: current state, context usage (tokens used vs the model's context window, with a fill bar), elapsed time for the current run, and total tool calls.

**NEW SESSION** clears the conversation (context resets to zero).

## Settings

**SETTINGS** controls the Ollama-compatible inference endpoint, separate default models and response styles for Code and Chat, main/coder/scout context caps, auto-compaction and its threshold, model keep-alive, starting mode, THINK and Code safety defaults, sidebar visibility, global instructions, main-agent step cap, and the default `/loop` iteration count. Main context **Auto** uses up to 128K tokens and never exceeds the model's native context; a custom cap can be entered when needed. Research always starts disabled regardless of session defaults.

The inference endpoint accepts an `http://` or `https://` base URL containing only a host and optional port, such as `http://127.0.0.1:9001`. **TEST** checks the endpoint's `/api/tags` response before saving. This supports servers that implement Ollama's `/api/tags`, `/api/show`, and `/api/chat` shapes; other provider protocols will need a provider adapter. A non-loopback endpoint sends prompts, attachment contents, and tool context to that server, so it is no longer local-only.

Chats are saved automatically as individual JSON files in the application-data directory — `~/Library/Application Support/Brittain Code/` on macOS, `%APPDATA%\Brittain Code\` on Windows — under `chats/` (with an `index.json` for the sidebar). They survive app updates and rebuilds, and are never included in the built app. The sidebar puts folder-free conversations under **GENERAL** and groups Code chats by project folder. Loading a chat restores its mode, model, directory, THINK, and AUTO-APPROVE states, but never restores RESEARCH.

## Online research

**ONLINE RESEARCH** is an explicit session-only switch. Enabling it warns that search queries and requested URLs leave your machine. It exposes two additional model tools:

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
| `/graph` | Show a visual tree of the git commit history |
| `/model <name>` | Switch model (partial match) |
| `/coder [name]` | Show or set the writable coding-worker model (default qwen3-coder:30b when installed) |
| `/subagent [name]` | Show or set the subagent/verifier model (default qwen3:8b) |
| `/loop [n] <goal>` | Work toward a goal with the selected model for up to n iterations (default 8). Turn AUTO-APPROVE on for unattended runs |
| `/orchestrate <goal>` | Use the selected model as a read-only planner, delegate sequential tasks to the coder model, and verify each task with the subagent model |
| `/mission [n] <goal>` | Run a persisted, visible coder mission for up to n iterations; `/mission status` inspects it and `/mission stop` cancels it |
| `/usage` | Show context remaining and token spend across planner/main agent, scouts, coders, and verifier |
| `/context` | Show exactly what will be sent next turn — system prompt, per-message tokens, eviction flags |
| `/recommendations` | Compare installed models by memory fit, capabilities, measured speed, and local Brittainmark results |
| `/best [task] [use]` | Rank installed models by their local benchmark score for a task; `use` switches to the top result |
| `/mcp [on\|off <server>]` | External MCP tool servers: status, enable, disable |
| `/memory` | View what the agent has remembered for the selected project |
| `/export` | Save the chat as a markdown file |
| `/tools` | List available tools and their risky, sensitive, or network classification |

## Offline orchestration

`/orchestrate` separates planning from implementation while keeping inference local by default. The model in the main dropdown inspects the project and submits a structured plan, `/coder` selects the model that edits and verifies code, and `/subagent` selects the read-only scout/verifier. Tasks run sequentially to avoid loading multiple large models at once. Each failed verification gets one bounded repair attempt. Planner and coder contexts checkpoint automatically at the configured compaction threshold, with at most two compactions per stage; every coder task still starts with a fresh context. The final chat response stays concise; use DIFF when you want the complete patch and working-tree detail.

`/loop` is the original single-model, conversation-preserving loop. For planned, verifier-guided implementation and repair work, use `/mission`: it records its goal, project, models, phase, latest evidence, and final report under Brittain Code’s application-data directory. It keeps the same tool permissions and approval rules as ordinary Code mode. Only one mission can run at a time; closing the app marks an active mission as interrupted rather than attempting to resume it. Missions do not run after the app exits and have no messaging, scheduling, or external-notification integration.

The planner can use `web_search` and `web_fetch` only when ONLINE RESEARCH is enabled, with the same per-request approval boundary as ordinary chats. Coding workers and verifiers never receive network tools. Run `/recommendations` after installing a new Ollama model to refresh the model list. The recommendations popup compares installed models at the current context cap. Memory values are marked as measured or estimated, and speed is learned from responses during the current app run.

## MCP servers

Brittain Code speaks the Model Context Protocol over stdio using a hand-rolled JSON-RPC client with no third-party dependencies — the most security-sensitive component of the app carries no supply chain. Configure servers in `mcp.json` in the application-data directory, using the same shape as Claude Desktop:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {}
    }
  }
}
```

Settings has an **OPEN MCP CONFIG** button, and `/mcp` shows status or enables/disables individual servers. Every MCP tool is namespaced `mcp_<server>_<tool>`.

MCP servers are third-party code running on your machine, so their tools are untrusted by default: **each call waits for approval even when AUTO-APPROVE is on**. A dedicated, off-by-default `mcpAutoApprove` setting — gated behind an explicit disclaimer — is the only thing that waives that prompt.

## Git, project instructions, memory, images

- When DIR is a git repo, the status bar shows the branch and changed-file count, with **DIFF** and **COMMIT** buttons. The diff refreshes after every agent run — review what it changed before committing.
- Put a **`BRITTAIN.md`** in any project folder and its contents are added to the system prompt for chats in that folder (like Claude Code's CLAUDE.md) — conventions, build commands, things the agent should know.
- The agent saves cross-chat lessons per project under `memory/projects/` in the application-data directory. Nothing is written into the project itself. Use `/memory` to view the selected project's file and its exact location. The former universal `memory.md`, if present, remains visible as legacy data but is no longer injected into prompts.
- Use **ATTACH** for images, PDFs, text files, and common source-code formats; pasted images still work. Images require a vision-capable model. Documents are extracted locally as read-only context, capped to protect the model window, and scanned PDFs without selectable text currently require external OCR.
- **Esc** stops a running generation. Speed (tokens/sec) shows in the status bar after each response.

## Brittainmark — the model benchmark

Brittainmark v3 is a deterministic, fully offline evaluation for local coding agents and orchestrated teams. There is no LLM judge: hidden graders live outside the scratch directory, so a run is scored on what the code actually does, not on what the model claims.

Seven versioned tasks span JavaScript, Python, and TypeScript — checkout arithmetic, atomic inventory rollback, debugging with green visible tests, deterministic snapshot/resume simulation, a leased durable outbox, ML data-leakage traps, and a paginated typed API sync. Scoring weights correctness (80), protected-file safety (10), verification reliability (7), and efficiency (3); catastrophic runs are zeroed rather than floored.

A batch runner creates fixtures, drives the tool loop, saves chats, and grades every run automatically:

```bash
node benchmark/run.js --models 'local:*' --tasks all
```

Local models run through Ollama; OpenAI and Anthropic adapters exist **for benchmarking only** (the app itself stays Ollama-compatible) and require their own API keys. Grading appends to `results.json` and rebuilds an HTML report with a leaderboard, model-by-task matrix, and telemetry-backed timing. `/best` inside the app ranks your installed models from those results.

See [`benchmark/README.md`](benchmark/README.md) for tasks, repetition guidance, grading, and report commands.

## Code layout — where to modify things

| File | What it does |
|---|---|
| `main.js` | The agent loop, system prompt, inference streaming, degradation detection, checkpoints, persistence, subagents, and application IPC handlers. |
| `settings.js` | Settings defaults, validation, and atomic on-disk persistence. |
| `missions.js` | Persisted mission state: goal, phase, evidence, and final report. |
| `mcp.js` | Minimal dependency-free MCP client (stdio JSON-RPC) and server lifecycle. |
| `ollama-recovery.js` | Detection and recovery for an unhealthy or stalled inference backend. |
| `attachments.js` | Local validation and text extraction for attached PDFs, text files, source code, and images. |
| `benchmark/` | Brittainmark v3: task fixtures, hidden graders, provider adapters, batch runner, and report generator. |
| `tools.js` | Tool schemas, implementations, managed processes, network guards, and risky/network/sensitive approval classifications. Add or change tools here. |
| `renderer/app.js` | UI behavior: sending, streaming display, timers, approval buttons. |
| `renderer/style.css` | All styling. Colors are CSS variables at the top. |
| `renderer/index.html` | The layout skeleton. |
| `preload.js` | The IPC bridge — only touch when adding a new message channel. |

Default runtime limits live in `settings.js` and can be changed from Settings; output, process-log, network-download, and tool-specific safety caps remain in `tools.js`.
