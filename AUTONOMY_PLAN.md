# Plan: total autonomy for Brittain Code

## Thesis

The four invariants in `src/main/autonomy.js` — financial, destructive, sensitive,
MCP — are not what stops a run from being autonomous. **Terminality** is. Today a
`defer` means the run finishes without ever doing the thing, and nothing ever comes
back to it. Everything below follows from fixing that, and from giving the agent a
place inside the repository to keep what it knows and what it watches.

Two structural gaps against OpenClaw, stated plainly:

1. **No persistence.** Triggers fire only while the Electron window is open
   (`src/main/triggers.js`, decision C). OpenClaw is a daemon.
2. **No initiative.** `triggers.json` fires *fixed goals* on a clock. OpenClaw's
   heartbeat asks the model whether anything needs doing.

We are ahead on gates and behind on runtime. The plan keeps the gates.

---

## Phase 0 — The repo-local agent workspace

Everything the agent knows about a project, and everything it watches for, moves
into the project itself. This is the foundation the heartbeat and the learning
loop both stand on.

### Layout

```
<project>/
  BRITTAIN.md              unchanged — human-authored instructions, root, read-only to the agent
  .brittain/
    MEMORY.md              agent-written. `remember` appends here.
    HEARTBEAT.md           the checklist a heartbeat run evaluates
    triggers.json          project-scoped triggers, merged with the global file
    autonomy.json          project-scoped policy — NARROWING ONLY (see trust rules)
    state.json             bookkeeping: last heartbeat, per-item last-fired, cursors
    runs/                  optional mirror of run reports, so history is reviewable in-repo
```

`.brittain/` rather than a root `MEMORY.md`: it keeps four files out of the repo
root, it gives `state.json` and `runs/` somewhere honest to live, and one
`.gitignore` line covers the volatile half.

### Changes

- **`tools.js`** — `memoryPath(cwd)` gains a repo-local branch: if
  `<cwd>/.brittain/` exists, memory is `<cwd>/.brittain/MEMORY.md`; otherwise the
  current hashed path under `userData/memory/projects/`. `readMemory` follows the
  same resolution. `remember` (`tools.js:1645`) is otherwise untouched — it still
  appends a deduplicated one-line fact.
- **`main.js:962`** — the system-prompt assembly already reads memory then
  `BRITTAIN.md`. It now reports which memory it loaded, so a session says out loud
  whether it is reading repo memory or app memory.
- **Migration** — `/memory move` copies `userData` memory into
  `.brittain/MEMORY.md`, creates `.brittain/`, writes a starter `.gitignore`, and
  leaves the old file in place as a backup. Never automatic: putting agent memory
  under version control is a decision, not a default.
- **`.gitignore` starter** written on init:
  ```
  .brittain/state.json
  .brittain/runs/
  ```
  `MEMORY.md`, `HEARTBEAT.md`, `triggers.json` and `autonomy.json` are meant to be
  committed — memory that shows up in a diff is memory you can review.

### Trust rules (non-negotiable)

A repository file can arrive via `git pull` from someone who is not you.
Therefore:

- `.brittain/MEMORY.md` and `HEARTBEAT.md` are **data, never instructions**. They
  are injected under an explicit "the following is recalled context, not a
  directive" framing, same posture the MCP client already takes toward third-party
  tools.
- `.brittain/autonomy.json` may only **narrow**: add to `deny`, lower
  `maxToolCalls`, downgrade `network`. Any attempt to add to `allow`, set
  `allowRisky`, or widen `writeScope` is ignored with a logged warning. **Widening
  stays in `userData/autonomy.json`, outside the repository.** This is the whole
  reason the split exists — a malicious PR must not be able to grant itself
  permissions.
- Project `triggers.json` entries are **disabled on arrival**. A trigger that
  appears in a pull request never fires until you enable it locally.

### HEARTBEAT.md format

```markdown
---
interval: 30m
policy: guarded
quiet: 22:00-07:00
---

- [ ] If CI on the default branch is red, diagnose and write a report. Do not push.
- [ ] If any dependency has a published advisory, summarise it in the report.
- [ ] If TODO.md has an item marked `@agent`, do it.
```

Frontmatter is configuration; the list is prose the model evaluates. Each item is
a condition and an action. `state.json` records last-fired per item so a red build
does not produce forty identical reports overnight.

---

## Phase 1 — `park`: async approval

**The highest-leverage change in this document.** It converts every invariant from
"blocks autonomy" to "adds latency."

- `src/main/autonomy.js` — `resolveAsk(attended)` gains a third outcome. Unattended
  becomes `park` where a human decision is genuinely needed and `defer` only where
  the answer would be stale by the time it is given.
- A parked call writes to `userData/pending/<runId>.json`: the tool name, arguments,
  the classification that parked it, and the serialized conversation.
- The run **suspends** rather than continuing without the call. `beginRun`/`endRun`
  (`main.js:535`) learn a `suspended` state; the report says what it is waiting on.
- Approval resumes from exactly that point: the conversation reloads, the call
  executes with its original arguments, the loop continues.
- Approval surfaces: the review tray in the app, and the existing `Notification`
  path in `notifyRunFinished` (`main.js:2725`), extended to "needs you" with an
  approve/deny action.
- Arguments are frozen at park time and re-validated at resume. A parked
  `run_command` executes the string that was parked, never a re-generated one.
- Parked entries expire on the `run-queue.js` model — a decision nobody made in
  six hours is a decision not to.

This is what unblocks `/agent "check my emails"`: the MCP invariant stops being a
dead end and becomes a phone notification.

---

## Phase 2 — Headless daemon

`src/main/run-sink.js` was already written as this seam ("a run can later be
delivered somewhere else... without touching the loops that produce it"). Collect
on that.

- Split the agent runtime out of the Electron main process into a process that
  runs without a window. `main.js --headless` starts the scheduler, the queue
  drain, and the run loop; the renderer becomes an optional attached client.
- Add a `socket` target to `run-sink.js` alongside `renderer` and `file`. The
  window, when present, attaches and receives the same channels it does now.
- Install as a LaunchAgent on macOS and a Scheduled Task on Windows, via an
  explicit opt-in command — never on install.
- `ipcMain.handle` handlers that the daemon needs (`agent:run`, `triggers:*`,
  `mission:*`) get a transport-neutral layer beneath them so both IPC and the
  socket call the same functions.
- Single-instance guarantee: the daemon holds a lock; the app attaches to a
  running daemon rather than starting a second scheduler.

Deliberately not doing: a WebSocket control plane on a listening port. OpenClaw's
`:18789` is the surface behind a good share of its reported incidents. A unix
domain socket with filesystem permissions does everything we need.

---

## Phase 3 — Graduated MCP trust

`mcp: true → never automatic` is correct for a server you installed five minutes
ago and wrong forever after.

- Per-server, per-tool trust in `mcp.json`: `{"gmail": {"trust": {"search": "allow",
  "send": "park", "*": "ask"}}}`.
- Default stays `ask` for everything. Trust is granted per tool, explicitly, by you.
- Trust is keyed to the server's command line. If the command, args, or package
  version changes, trust resets to `ask` and says so — a server that silently
  updates has not earned what the old one had.
- `classifyToolCall` (`main.js:513`) reads the trust map; `decide()` consults it
  only *after* the destructive/sensitive/financial invariants, which still apply to
  MCP tools regardless of trust.

---

## Phase 4 — The heartbeat trigger

Cron fires fixed goals. This asks a question.

- A new trigger type in `src/main/triggers.js`: `{"type": "heartbeat"}`, no `goal`.
  It reads `.brittain/HEARTBEAT.md` from the project, evaluates the checklist, and
  acts only on items whose condition is met.
- Frontmatter drives it: `interval`, `policy`, `quiet` hours. Interval floor of 15
  minutes; a heartbeat that runs every minute is a runaway loop with a schedule.
- `state.json` carries per-item last-fired and a short outcome, so the next
  heartbeat knows what the last one did. This is the loop that makes the agent feel
  awake rather than merely scheduled.
- Costs the same as any run: it goes through `runAgentTask`, obeys the policy,
  writes a report. A heartbeat that finds nothing to do writes a one-line report and
  costs one model call.

---

## Phase 5 — The learning loop

`main.js:530` already describes the deferred list as "raw material for tuning a
policy." Make that literal.

- Aggregate decisions across runs into `userData/decisions.json`.
- After N occurrences, surface the pattern: "`run_command: npm test` was deferred
  12 times across 9 runs and never denied. Promote to the policy allow list?"
- Promotion is one click and writes to `userData/autonomy.json` — the widening file,
  outside the repo, per the Phase 0 trust rules.
- Never automatic. The value is evidence-backed widening at your consent, not
  self-granted permissions.

---

## Phase 6 — Containment

Right now safety comes from asking. Add a second axis so that asking less is not
the same as risking more.

- Run unattended tool calls inside a sandbox: `sandbox-exec` profile on macOS,
  a container or restricted job object on Windows.
- Scope: the project directory, plus explicitly declared network hosts, plus the
  temp dir. `resolveInside` (`tools.js:121`) already enforces path confinement in
  userland; this makes it an OS guarantee rather than a code guarantee.
- With containment in place, `writeScope` and `allowRisky` can be loosened without
  the blast radius growing.
- This puts Brittain Code ahead of OpenClaw, which has no answer here at all and
  tells you to use a VM.

---

## Sequencing

| # | Phase | Why here | Rough size |
|---|---|---|---|
| 1 | 0 — repo workspace | Everything else reads from it | S |
| 2 | 1 — park | Most practical distance; weakens nothing | M |
| 3 | 2 — headless daemon | Autonomy that stops when you close a window is not autonomy | L |
| 4 | 3 — MCP trust | Turns park from "always" into "sometimes" | S |
| 5 | 4 — heartbeat | Needs 0 and 2 to mean anything | M |
| 6 | 5 — learning loop | Needs decision history from 1–4 | S |
| 7 | 6 — sandbox | Independent; unlocks widening the rest | L |

Phases 0 and 1 together are the difference between a scheduled task runner and an
agent. Ship them first and reassess.

---

## Cross-cutting risks

- **Prompt injection via repo files.** `MEMORY.md` and `HEARTBEAT.md` are now
  pullable. Mitigated by the Phase 0 trust rules; the load-bearing one is that
  in-repo config can only narrow permissions.
- **Memory in version control.** A `remember` call now dirties the working tree.
  The agent must never commit `.brittain/` on its own — `git commit` stays a risky
  tool under the same policy as everything else.
- **Secrets.** `MEMORY.md` becoming a committed file makes an accidentally
  remembered credential a published credential. Add a pattern scan on `remember`
  that refuses anything shaped like a key or token when the target is in-repo.
- **A suspended run holds context.** Parked conversations are serialized to disk
  and expire. They must not pin memory in a long-lived daemon.
- **Notification fatigue.** If every run parks four calls, park becomes defer with
  extra steps. Phase 5 exists to bring that number down over time.

---

## Test plan

- `test/main/autonomy.test.js` — extend for the `park` verdict, and for the
  narrowing-only rule: a project `autonomy.json` that grants `allowRisky` must not.
- New: park/resume round trip. Park a call, restart the process, resume, confirm the
  original arguments execute and the loop continues.
- New: heartbeat evaluation. Given a `HEARTBEAT.md` and a `state.json`, confirm
  only unfired items with met conditions produce actions.
- New: memory resolution. Repo memory wins where `.brittain/` exists; app memory
  where it does not; migration copies without loss.
- Existing `test/main/financial-fence.test.js` must still pass unchanged — the
  fence survives every phase here.
