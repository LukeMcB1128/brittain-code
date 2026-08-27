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
| `npm run dist` | Local macOS `.dmg` and `.zip` without production updates |
| `npm run dist:win` | Windows x64 NSIS installer |
| `npm run dist:all` | both |
| `npm run deploy` | macOS: build and copy straight into /Applications |

On macOS the standalone app lands in `dist/mac-arm64/Brittain Code.app`; drag it into Applications or the Dock to launch it without a terminal. Local builds use an ad-hoc signature, so the first launch can need the usual right-click → Open. Local Windows builds can show the SmartScreen "More info" → "Run anyway" action.

Official releases are built from stable `vX.Y.Z` tags by `.github/workflows/release.yml`, which uploads both platforms into a draft and publishes it only after both jobs succeed. Releases carry no paid signing identity: macOS gets a deep ad-hoc signature so Gatekeeper shows the ordinary unidentified-developer prompt rather than rejecting a bundle whose seal no longer matches its contents, and Windows shows SmartScreen.

Auto-updates run on Windows, where an unsigned installer can still replace itself: those builds check GitHub Releases for newer stable versions, download in the background, and offer a restart when ready. macOS updates are manual, because Squirrel.Mac will not swap an app it cannot verify a Developer ID signature for — a mac release build would download an update it could never install, so the updater is left off there. Adding a Developer ID later means restoring the signing and notarization env in the mac job and setting `MAC_RELEASE_BUILD=1`; the release config turns the updater back on with it. Development and local package builds never contact the update server.

The built app is a snapshot of the code at build time — editing `main.js` or the `renderer/` files does **not** change it; rebuild after changes. During development, `npm start` always runs the live code.

## Using it

1. Choose **CODE** for project work or **CHAT** for folder-free conversation and research.
2. Pick a model from the dropdown. Models that support tool calling work best — **qwen3.6:27b** and **gemma4:26b** are the strongest for agent tasks, **qwen3:8b** and **gemma4:latest** are fast fallbacks. qwen3-coder:30b sometimes emits malformed tool calls; tiny models (qwen2.5-coder:1.5b) are chat-only.
3. In Code mode, click **DIR** and choose the project folder the agent should work in. Chat mode deliberately has no directory or project tools.
4. Type a task or question and hit Enter.

The agent can inspect and edit files, search source and locally installed documentation, run allowlisted project checks, inspect Git state, manage local development processes, verify loopback HTTP servers, and run shell commands. `run_project_check` discovers npm-compatible scripts, CMake configure/build/CTest flows, Cargo, Go, Python/pytest, and safe Make targets; every command runs without a shell. File tools are confined to the selected project directory. It asks before writes, commands, and other risky operations. The **AUTONOMY** dial sets how much a run may do without asking: *Supervised* prompts before every risky call, *Guarded* lets reads and project checks through but still asks before writes and commands, and *Trusted* runs ordinary risky tools unattended. Whatever the setting, destructive operations, sensitive reads, and external MCP tools always require explicit approval, and online requests need both the ONLINE switch and a policy that permits them. Custom policies can be defined in `autonomy.json` in the application-data directory; built-in ones cannot be overridden.

If Ollama rejects malformed tool-call JSON, Brittain Code discards that call and retries generation once with strict formatting and THINK disabled. A second rejection stops safely with a concise model-format error; malformed arguments are never reconstructed or executed.

### What a saved session records

Alongside the transcript, a saved chat records the models it used, the working directory, and whether the session ever ran with **online research enabled** — shown as an `ONLINE` marker in the session list. That flag is a latch over the whole session rather than the state of the switch when the chat happened to be saved: research done an hour ago is still in the transcript after the toggle goes off, so a snapshot would file a session that plainly went online as local. It is stamped in the main process from the runs themselves, not from the sender.

Opening such a session never re-enables online research. The record is provenance — it answers "was anything here reached over the network?" — and the switch always starts off, exactly as it does for a new chat.

### Cloud models

Inference speaks two protocols. `ollama` is the default: the endpoint is a local Ollama-compatible host and nothing leaves the machine. `openai` covers every OpenAI-compatible provider — OpenRouter, Z.AI, Groq, DeepSeek — with the base URL going in the same endpoint setting exactly as the provider documents it (`https://openrouter.ai/api/v1`). Provider, key and cost rates all live in Settings beside that endpoint; `/provider` reports what is configured without changing it.

The provider is chosen rather than sniffed from the URL, because it decides whether a conversation leaves your machine and that is not a question to answer by guessing. An unrecognised value stays local.

The key is kept in `credentials.json` rather than `settings.json`, encrypted against the OS keychain where one is available and mode `0600` regardless; when no encrypted storage exists the app says so rather than implying protection it does not have. It is never sent to the interface — `/provider` shows only whether a key is set and its first and last few characters.

Worth being clear about what changes: on a cloud provider **every message is sent to that endpoint**, including the contents of files the agent reads. With policy `roots` or MCP servers configured, that can reach well beyond the project folder. The sensitive-read invariant still refuses `.env` files and keys, and online research remains a separate switch, but the model itself now sees everything else. Set `inputPerMillion` and `outputPerMillion` in Settings and a run will report what it cost.

### Scanned PDFs

A PDF with no text layer — a photographed or scanned worksheet — used to be refused outright. Its pages are now rendered to images and attached the way any other image is, so a vision-capable model (`qwen2.5vl`, `llava`, `gemma3`) can read it. The attachment text says plainly that the document was a scan and how many pages were attached, so the model is never guessing at what it was given.

Rendering is a fallback, never the first choice: a PDF with real text is extracted as text, which is smaller, cheaper and more accurate. Pages are capped at eight, and the message names the ones left out — a long scan at readable resolution consumes a context window far faster than the same document as text. If the selected model cannot see images, the error says that the file is a scan, why that means images, and which models can read it.

### Model degradation detection

Local models degrade before they fail loudly — glitch tokens, byte-fallback artifacts, self-talk leaking into written files, and runaway repetition. Brittain Code scans generated content and tool arguments for those signatures inside the streaming layer, so every caller (main agent, subagent, verifier, coder) is protected without per-call-site changes. A detected episode recovers with a context compaction — the "sanity reset" that empirically clears it — rather than silently writing corrupted code, and gives up honestly if it recurs.

### What compaction keeps

Compacting a conversation summarizes the older half and keeps the most recent complete turns verbatim, because those are both the most relevant part of the session and the cheapest to preserve. Tails always start at one of your messages, so a tool result is never separated from the call that produced it. Small context windows keep a proportionally larger share, since a flat percentage of 8K leaves too little to work from.

The summary itself is checked before anything is thrown away. One that is too thin for the conversation it covers earns a single retry naming the length it missed, and the old messages are not replaced until a summary passes. If none does, compaction keeps a larger stretch of raw conversation and says so, rather than continuing from a record that lost the session — and if not even one complete turn fits, it declines and changes nothing.

Alongside the summary, compaction carries a **session ledger** read directly off the tool record: files changed, commands run and their outcomes, project checks, unresolved errors, and anything you denied. Those facts are extracted mechanically rather than recalled, so a denied write is never reported as work done and the file list cannot quietly go missing. The summary itself is requested by section — goal, constraints, decisions, state, next steps — with a minimum length, and one retry when it arrives thin or unlabelled.

Each ledger is also written to `runs/` in the app's data directory as it is produced, so the record outlives the compaction that created it. `/ledger` shows what the current session has done and lists the snapshots saved so far. Every compaction reports tokens before and after, the summary size, ledger entries, how many turns survived intact, and whether a retry was needed.

### Unattended runs

`/agent <goal>` runs a single agent loop with nobody watching — one model working the goal, free to spawn a subagent when it needs one. It is not the planner/coder/verifier mission pipeline; "check my emails" should not stand up three models. It is a commitment rather than a setting: where there is a repository it moves work onto a generated branch and checkpoints it, and it always writes a report, however the toggles happen to sit. `--policy <name>` picks an autonomy policy for that run alone without changing your default.

**Parked calls.** Unattended, a call only a human may approve — money, destructive operations, sensitive reads, untrusted MCP tools — no longer ends the run without it. The call's exact arguments are frozen, the run suspends, and a notification says a decision is waiting. `/pending` lists suspended runs; approve or deny each call, then `/pending resume` continues the run from exactly where it stopped, executing what was parked — never a regenerated variant. Undecided calls at resume count as denied, and a decision nobody makes for six hours expires. Ordinary risky calls a policy merely does not list are still deferred (recorded, skipped, the run continues) — a defer's answer would be stale by morning anyway.

**The project workspace.** `/workspace init` creates `<project>/.brittain/` and relocates the agent's memory into `MEMORY.md` there, where it shows up in diffs and travels with the repository. The directory also holds `HEARTBEAT.md` (below), a project-scoped `triggers.json` and optional `autonomy.json`, and a starter `.gitignore` covering the volatile half (`state.json`, `runs/`). These files can arrive via `git pull` from anyone, so they follow strict trust rules: memory and heartbeat text are injected as data, never instructions; a project `autonomy.json` can only *narrow* the active policy (widening lives in the app-data `autonomy.json`, outside the repository); and project triggers arrive disabled — they fire only after `/agent trigger enable <id>`, and re-disable automatically if a pull changes their definition. `remember` refuses key-shaped facts when memory is in-repo, since a committed credential is a published one. Nothing creates the folder for you: because its presence is what moves memory out of app data and into the working tree, an unattended run in a project without one mentions `/workspace init` once and writes nothing. `/workspace` on its own shows what the folder holds; `/memory move` does the same thing as `init` and remains for the memory-specific path.

**Heartbeats.** `/workspace init` ships an inert heartbeat trigger in `.brittain/triggers.json` alongside an empty `HEARTBEAT.md`: write a checklist item, then `/agent trigger enable heartbeat`. Until both are done it does nothing — an empty checklist has nothing to evaluate, and a project trigger has to be enabled locally regardless. An item commented out with `<!-- -->` does not run. A trigger of `{"type": "heartbeat"}` fires no fixed goal. On its interval (frontmatter in `HEARTBEAT.md`; 15-minute floor, optional quiet hours) it reads the project's checklist and acts only on items whose condition is currently true, recording what it concluded in `state.json` for the next beat to read. That is the difference between scheduled and autonomous: cron fires a goal, a heartbeat asks a question.

**The daemon.** Triggers normally fire only while the app is open. `/agent daemon install` (macOS, opt-in, never automatic) installs a LaunchAgent that runs the app `--headless`: no window, the same runtime, answering on a unix domain socket — deliberately not a network port. The daemon owns the trigger scheduler; a window that finds it alive does not start a second one. `/agent daemon start` and `stop` control it without reinstalling — start also restarts, which is how you pick up an edited config, and both report what the daemon is actually doing rather than that a command was issued. It writes `daemon.out.log` and `daemon.err.log` beside the other application data, which is the first place to look if it will not stay up.

**Separate conversations per origin.** A Discord thread, each trigger, each heartbeat and the app window each keep their own conversation, history entry, ledger and context. They share a process — only one run executes at a time — but not a transcript, so a heartbeat firing overnight does not reason with the afternoon's chat still in scope, and a run started from Discord is saved under its own chat rather than mixed into whatever the window was doing. A run that does not declare an origin belongs to the window, which is what everything started from the app does.

**Reach it from Discord.** A bridge between a Discord bot and the agent makes it reachable from a phone. It runs inside the app — or inside the daemon, whichever owns the trigger scheduler — so there is no separate process to keep alive and it works in a packaged build. `/discord` shows its state, `/discord edit` opens the config, and changes take effect on restart. (`npm run discord` runs it standalone against a running daemon, for a checkout.) Message it a goal and it runs unattended in the configured project; `!pending`, `!approve`, `!deny`, `!resume`, `!status` and `!stop` mirror the slash commands, and `!compact`, `!clear`, `!usage`, `!ledger` and `!memory` do the same for the conversation itself. Those act on the channel they are sent from — a long thread compacting whatever the app happens to have open would be both useless and destructive — and are refused while a run is in flight, since switching conversations under a live loop is what tears them. This is what parked calls were built for — a run suspends on your desktop, the bridge tells you what it is waiting on, and you approve from wherever you are; the frozen call then executes at home.

The bot speaks as it works: each thing the model says is relayed when it says it, so a run that narrates its way through several steps reads as a conversation rather than arriving as one closing paragraph. What is not relayed is the machinery — tool calls, results, transcript paths, branch names, compaction notices — since none of it is actionable from a phone. Failures and skipped calls still break the silence.

If the agent needs to ask you something — the `ask_user` tool — the question arrives wherever the run is being driven from, with any options numbered so you can reply with a digit. Your next ordinary message answers it; `!` commands still work, so `!stop` is never swallowed by a question you would rather abandon. A question nobody answers within ten minutes gives up rather than holding the run open.

The bridge holds no authority of its own: it turns an allowlisted person's message into the same run the app starts, under the same policy, so every invariant and every decision record still applies. Setup needs a bot account — Discord does not permit automating a user account — and the bot must share a server with you before it can open a DM, so invite it to one (a private server with only you is fine). Enable the Message Content intent on the application, or it cannot read what you send. Configuration lives in `discord.json` in the application-data directory and ships disabled. Unprompted messages — a run parking at 3am, a heartbeat's result — go to `notifyChannelId`, or to a DM the bridge opens with the first owner at startup, so it can reach you without being spoken to first. It answers nobody until `ownerIds` names you, and with no `channelIds` it accepts direct messages only — a shared channel has to be opted into by naming it. Messages from bots, from non-owners, and from channels you did not list are dropped without a reply. It adds no dependencies: Node ships a WebSocket client, and the gateway protocol is hand-rolled for the same reason the MCP client is.

**Graduated MCP trust.** "MCP is never automatic" is right for a server installed five minutes ago and wrong forever after. A `trust` map in `mcp.json` (`{"search": "allow", "send": "park"}`) grants specific tools on a specific server; the grant is keyed to the server's command line and voids itself if that changes (`/mcp trust accept <server>` re-affirms). The financial, destructive, and sensitive invariants still apply to trusted MCP calls.

**The learning loop.** Every run's verdicts accumulate. A call held (deferred or parked) five or more times across runs and never denied by a human surfaces in `/policies` as a promotion suggestion; `/policies promote <custom-policy> <tool>` adds it to that policy's allow list. Never automatic — the aggregate produces evidence, a person clicks. Built-in policies cannot be widened.

**Reaching outside the project.** File tools are confined to the working directory, which is right for a coding agent and wrong for an assistant that should be able to read your notes. A custom policy may list `roots`:

```json
{ "policies": { "assistant": { "allowRisky": true, "roots": ["~/Documents/notes", "~/Downloads"] } } }
```

Those directories become readable and writable alongside the project. Paths must be absolute or start with `~`; the filesystem root is refused, and anything unusable is reported rather than silently dropped. Relative paths still mean the project, so a granted root is only ever reached by naming it. Every run that has roots says so in its output, and `/policies` lists them — this is the widest setting in the file, so it is deliberately hard to forget about. It lives in the app-data `autonomy.json` only: a project's `.brittain/autonomy.json` can only narrow, so a file arriving in a pull request cannot hand the agent the rest of the disk.

**Sandboxing.** A custom policy with `"sandbox": true` runs unattended shell commands under macOS `sandbox-exec`, with writes confined to the project and temp directories — path confinement as an OS guarantee rather than a code one. On platforms without a sandbox the run says so plainly and continues unconfined.

Starting an unattended run shows a one-time-per-project disclosure: undo is the wrong safety model for a run that can act on the world, so it states plainly that the agent acts on its own — running commands, driving a browser, calling connected tools — and that some actions cannot be undone. A Git repository is no longer required; when there is one the run still branches and checkpoints for its file-level work, and when there is not, the disclosure is the guard and file-level undo simply does not apply. A policy can still opt into requiring a generated branch, which only applies inside a repository.

Because nobody is there to answer, a call that would normally prompt is *deferred*: it does not run, it is recorded, and the run carries on rather than stalling until morning. When the run ends you get a foldable decision log in the chat listing every verdict, with the deferred calls separated out as the ones that need you.

Autonomy runs inside a fence, not on a blanket waiver. An **autonomous** policy (see `/policies edit`) can run risky tools unattended while a tool-call ceiling, a required branch, and the standing invariants still hold. Four things stay held for a person whatever the policy says: destructive operations, sensitive reads, external MCP tools, and anything that moves money. The money guard is a heuristic backstop — a payment-provider API call, a checkout, a crypto send — surfaced as a spending approval so that spending meets you at the moment it happens rather than at launch.

Each run leaves a timestamped transcript and a markdown report in `runs/` in the application-data directory, and raises a notification when it finishes.

`/agent trigger` manages scheduled unattended runs, defined in `triggers.json` in the application-data directory using ordinary cron fields (`*`, `N`, `a-b`, `*/n`, and comma lists). `/agent trigger new` creates and reveals the file, `/agent trigger list` shows what is configured along with anything waiting to run, and `/agent trigger run <id>` fires one immediately, ignoring its schedule — the honest way to test the whole path with someone watching. A generated example is always created disabled, so nothing runs until you have edited it.

Triggers only fire while Brittain Code is open. A trigger that fires while a mission is already running is queued rather than dropped: the same trigger replaces its own pending entry instead of stacking copies, entries expire rather than running hours late, and a queued run is branched and checkpointed when it starts rather than against the tree it was queued against.

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
| `/diff` | Review staged, unstaged, and untracked files with per-file navigation and collapsible patches |
| `/commit <message>` | Stage everything and commit |
| `/graph` | Show a visual tree of the git commit history |
| `/model <name>` | Switch model (partial match) |
| `/coder [name]` | Show or set the writable coding-worker model (default qwen3-coder:30b when installed) |
| `/subagent [name]` | Show or set the subagent/verifier model (default qwen3:8b) |
| `/loop [n] <goal>` | Work toward a goal with the selected model for up to n iterations (default 8). Turn AUTO-APPROVE on for unattended runs |
| `/plan <goal>` | Inspect the project and show an editable implementation plan. Run, edit, or cancel it before any coding starts |
| `/review [base]` | Review changes relative to a Git base with structured findings, then send selected findings to the coder |
| `/orchestrate <goal>` | Use the selected model as a read-only planner, delegate sequential tasks to the coder model, and verify each task with the subagent model |
| `/mission [n] <goal>` | Run a persisted coder mission; use `/mission status`, `/mission stop`, or validated `/mission resume` recovery |
| `/usage` | Show context remaining and token spend across planner/main agent, scouts, coders, and verifier |
| `/context` | Show exactly what will be sent next turn — system prompt, per-message tokens, eviction flags |
| `/recs` | Compare installed models by memory fit, capabilities, measured speed, and local Brittainmark results |
| `/auto <request>` | Select the best compatible installed model for the current mode and attachments, then run the request |
| `/mcp [on\|off <server>]` | External MCP tool servers: status, enable, disable |
| `/discord [edit]` | Bridge a Discord bot to the agent so it is reachable from a phone |
| `/workspace [init]` | The project's `.brittain` folder: in-repo memory, heartbeat checklist, project triggers |
| `/memory [move]` | View what the agent has remembered; `move` relocates it into the project's `.brittain/MEMORY.md` |
| `/agent [--policy <name>] <goal>` | Run unattended: always branched, checkpointed, and reported |
| `/agent trigger [list\|new\|run <id>\|enable <id>\|disable <id>]` | Scheduled unattended runs; enable/disable act on project (`.brittain`) triggers |
| `/agent daemon [status\|start\|stop\|install\|uninstall]` | The headless runtime that keeps triggers and heartbeats firing with every window closed |
| `/pending [approve\|deny [<run>] [n\|all]\|resume [<run>]]` | Parked calls from suspended unattended runs; the run id is optional while only one is waiting |
| `/policies [edit\|promote <policy> <tool>]` | Autonomy policies, held calls, and evidence-backed promotion suggestions |
| `/ledger` | View what this session changed, ran, and failed at (survives compaction) |
| `/export` | Save the chat as a markdown file |
| `/tools` | List available tools and their risky, sensitive, or network classification |

## Offline orchestration

`/orchestrate` separates planning from implementation while keeping inference local by default. The model in the main dropdown inspects the project and submits a structured plan, `/coder` selects the model that edits and verifies code, and `/subagent` selects the read-only scout/verifier. `/plan` runs only the inspection stage and shows the result in an editable card. **RUN** sends that exact approved plan to the coder without running the planner again; **CANCEL** changes no files. Tasks run sequentially to avoid loading multiple large models at once. Each failed verification gets one bounded repair attempt. Planner and coder contexts checkpoint automatically at the configured compaction threshold, with at most two compactions per stage; every coder task still starts with a fresh context. The final chat response stays concise; use DIFF when you want the complete patch and working-tree detail.

`/loop` is the original single-model, conversation-preserving loop. For planned, verifier-guided implementation and repair work, use `/mission`: it records its goal, project, models, phase, latest evidence, final report, and recovery anchors under Brittain Code’s application-data directory. It keeps the same tool permissions and approval rules as ordinary Code mode. Only one mission can run at a time. Closing the app marks an active mission as interrupted. `/mission resume` continues only after the project path, Git commit, working-tree fingerprint, and saved checkpoint all match the last persisted mission event. Missions do not run after the app exits and have no messaging, scheduling, or external-notification integration.

The planner can use `web_search` and `web_fetch` only when ONLINE RESEARCH is enabled, with the same per-request approval boundary as ordinary chats. Coding workers and verifiers never receive network tools. Run `/recs` after installing a new Ollama model to refresh the model list. The recommendations popup compares installed models at the current context cap. Memory values are marked as measured or estimated, and speed is learned from responses during the current app run.

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

Local models run through Ollama; OpenAI and Anthropic adapters exist **for benchmarking only** (the app itself stays Ollama-compatible) and require their own API keys. Grading appends to `results.json` and rebuilds an HTML report with a leaderboard, model-by-task matrix, and telemetry-backed timing. `/auto` uses compatible local Brittainmark data as one signal when it selects an installed model.

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
