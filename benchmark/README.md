# Brittainmark v3

Deterministic, fully offline evaluation for local coding agents and orchestrated teams.

V3 keeps the strongest V2 tasks, hardens the outbox task, adds Python and TypeScript coverage, and shifts the score so correctness dominates.

## Score

| Dimension | Points | Measures |
|---|---:|---|
| Correctness | 80 | Visible behavior (30) and hidden generalization (50) |
| Safety | 10 | Protected files remain intact and collateral edits stay controlled |
| Reliability | 7 | Verification after editing, honest completion claims, and tool stability |
| Efficiency | 3 | Tool calls, generated tokens, and elapsed wall time |

A run is zeroed when it is effectively a complete failure, including:

- no implementation attempt;
- protected-file tampering;
- fixture load failure;
- zero visible tests passed.

This keeps partial progress visible while removing the old non-solution floor.

## Tasks

```bash
node benchmark/setup.js --list
```

| Task | Version | Language | Challenge |
|---|---:|---|---|
| `cart` | v4 | JavaScript | checkout arithmetic, rounding, validation, tax, and shipping boundaries |
| `feature` | v3 | JavaScript | atomic inventory reservation and payment rollback |
| `debug` | v3 | JavaScript | tenant cache isolation, falsy values, and TTL bugs with green visible tests |
| `economy` | v3 | JavaScript | deterministic simulation, ledger invariants, and exact snapshot/resume replay |
| `outbox` | v2 | JavaScript | leased durable outbox with retries, dead letters, lease recovery, and snapshot safety |
| `fraudml` | v1 | Python | deterministic train/validation split, threshold calibration, and ML-style data leakage traps |
| `tsapi` | v1 | TypeScript | paginated API sync, ETags, typed errors, and idempotent writes |

Hidden graders live in `benchmark/tasks.js`, outside the selected scratch directory.

## Create a fixture

```bash
node benchmark/setup.js --task cart
node benchmark/setup.js --task feature
node benchmark/setup.js --task debug
node benchmark/setup.js --task economy
node benchmark/setup.js --task outbox
node benchmark/setup.js --task fraudml
node benchmark/setup.js --task tsapi
```

Defaults are `~/brittain-bench` for `cart` and `~/brittain-bench-<task>` for other tasks. Override with `--dir /path`. Setup refuses to replace a non-benchmark directory unless `--force` is explicitly supplied.

The original shell wrapper still works:

```bash
bash benchmark/setup.sh [directory] [task]
```

## Running models

For each task repetition:

1. Reset the fixture:

   ```bash
   git reset --hard -q bench-baseline
   git clean -fdq
   ```

2. Start a fresh Brittain Code session in that fixture directory.
3. Hold approvals, thinking mode, context size, online mode, and team/solo workflow constant.
4. Paste the matching prompt from `benchmark/prompts/`.
5. Grade before resetting:

   ```bash
   node benchmark/grade.js --dir ~/brittain-bench --task cart
   ```

V3 is intended to be run with at least three repetitions per model/task/configuration.

## Automated batch runs

You can now run a whole batch in one command and let Brittainmark create fixtures, execute the tool loop, save chats, and grade each run automatically.

```bash
node benchmark/run.js --models 'local:*' --tasks all
node benchmark/run.js --models 'local:*,openai:gpt-5.6-sol' --tasks all --promote-top 5 --total-repeats 3
node benchmark/run.js --models qwen2.5-coder:1.5b,openai:gpt-5.6-sol --tasks cart,feature
node benchmark/run.js --models anthropic:claude-haiku-4-5,anthropic:claude-sonnet-4-5 --tasks all
node benchmark/run.js --list-local-models
```

Notes:

- The runner automatically loads a repository-root `.env` file. It is gitignored; shell environment values take precedence over it.
- Quote `local:*` in `zsh` so the shell does not expand the `*`.
- Bare model names default to Ollama, so `qwen2.5-coder:1.5b` is treated as a local model.
- Use explicit prefixes for non-local providers, for example `openai:gpt-5.6-sol`.
- OpenAI runs require `OPENAI_API_KEY` in the environment. `OPENAI_BASE_URL` is also supported for compatible endpoints.
- Anthropic runs require `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL`, `ANTHROPIC_VERSION`, `ANTHROPIC_MAX_TOKENS`, and `ANTHROPIC_THINKING_BUDGET` are optional overrides.
- The Anthropic adapter uses the Messages API's native client-side tool calls, so Claude receives and uses the same Brittain Code tools as local and OpenAI models. With `--think on`, it enables manual extended thinking for Claude 4.5 models (including Haiku 4.5) and adaptive thinking for supported Claude 4.6+ models. Unsupported model IDs are accurately recorded as `think off`.
- `--promote-top 5 --total-repeats 3` runs every model once, ranks them, then continues only the top five until they reach three total runs.
- Batch outputs are written under `benchmark/runs/<timestamp>/` with a `manifest.json` plus saved chats for every run.

## Team runs

Team runs are still supported. The grader detects orchestration from saved metrics and records planner, coder, and verifier separately. Solo and team runs remain separate report modes, and team runs receive bounded efficiency budget multipliers instead of being compared directly to a one-call solo path.

## Grading and reports

```bash
node benchmark/grade.js                         # newest detected benchmark chat
node benchmark/grade.js --dir /path --task id
node benchmark/grade.js --chat /path/chat.json
node benchmark/grade.js --list
node benchmark/grade.js --tasks
node benchmark/grade.js --dry-run               # score without changing results.json
node benchmark/report.js                        # rebuild report.html
```

Each successful grade appends or replaces its chat record in `results.json` and rebuilds `report.html`.

The V3 report includes:

- current task-version badges and run counts;
- a V3-only leaderboard separated from archived legacy runs;
- average total score across tasks;
- average score per elapsed minute;
- a model-by-task matrix for current tasks;
- aggregate and individual run tables;
- visible/hidden pass details, zeroed-run rate, and telemetry-backed timing.

Qualified leaderboard status is intended for configurations that cover all current tasks with at least three runs each.

## Persisted run telemetry

Recent Brittain Code chats save:

- prompt and generated tokens by role;
- model-load, prompt-evaluation, generation, and total inference duration;
- wall time and peak context;
- tool calls, errors, denials, and recovered malformed calls;
- compactions, loop iterations, orchestrations, and repair attempts;
- role model digests, parameter sizes, quantization, and native context;
- app version/commit, Ollama version, temperature, context cap, and hardware profile.

Legacy runs remain visible in the archive, but they do not participate in the V3 leaderboard.
