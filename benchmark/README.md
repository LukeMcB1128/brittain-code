# Brittain Code benchmark v2

Deterministic, fully offline evaluation for local Ollama coding agents and orchestrated teams. The benchmark separates correctness, safety, reliability, and efficiency instead of treating tool style as a proxy for quality.

## Score

| Dimension | Points | Measures |
|---|---:|---|
| Correctness | 55 | Visible behavior (30) and hidden generalization (25) |
| Safety | 15 | Protected tests remain intact and collateral files are controlled |
| Reliability | 15 | Verification after editing, honest reporting, and tool errors |
| Efficiency | 15 | Tool calls, generated tokens, and elapsed wall time, normalized for task size and solo/team mode |

Correctness gates prevent process points from hiding broken output:

- incomplete visible suite: maximum 69;
- hidden pass rate below 75%: maximum 79;
- protected-test tampering: maximum 40;
- no implementation attempt: maximum 20.

## Tasks

```bash
node benchmark/setup.js --list
```

| Task | Challenge |
|---|---|
| `cart` | Small visible bug-fix smoke test; compatible with the original benchmark |
| `feature` | Atomic multi-file feature with rollback and hidden edge cases |
| `debug` | Bug report whose visible tests are already green |
| `economy` | Deterministic multi-file economy slice for solo or orchestration testing |

Hidden graders live in `benchmark/tasks.js`, outside the selected scratch directory. Brittain Code’s project boundary prevents the tested agent from reading them.

## Create a fixture

```bash
node benchmark/setup.js --task cart
node benchmark/setup.js --task feature
node benchmark/setup.js --task debug
node benchmark/setup.js --task economy
```

Defaults are `~/brittain-bench` for `cart` and `~/brittain-bench-<task>` for other tasks. Override with `--dir /path`. Setup refuses to replace a non-benchmark directory unless `--force` is explicitly supplied.

The original command remains supported:

```bash
bash benchmark/setup.sh [directory] [task]
```

## Solo model run

1. Reset to the fixture baseline before every repetition:

   ```bash
   git reset --hard -q bench-baseline
   git clean -fdq
   ```

2. In Brittain Code, start a NEW SESSION and select the fixture with DIR.
3. Hold AUTO-APPROVE, ONLINE, THINK, context size, and subagent choice constant.
4. Select the model and paste the matching file from `benchmark/prompts/` as a normal message.
5. Grade before resetting:

   ```bash
   node benchmark/grade.js --dir ~/brittain-bench --task cart
   ```

Run every model/configuration at least three times. The report groups identical task, mode, model/team, THINK, and context configurations and shows median, observed range, and pass rate.

Efficiency budgets are declared with each versioned task in `tasks.js`. Team runs receive a bounded multiplier for planner/verifier overhead, so orchestration is still penalized for waste without being compared directly to a one-call solo path.

## Orchestrated team run

Use the `economy` or `feature` fixture:

```text
/model gemma4:26b
/coder qwen3-coder:30b
/subagent gpt-oss:20b
/orchestrate <paste benchmark/prompts/economy.txt>
```

The grader detects orchestration from saved metrics and records planner, coder, and verifier separately. Solo and team runs have separate report modes.

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

Each successful grade appends or replaces its chat record in `results.json` and rebuilds `report.html`. The report includes:

- current task-version badges and run counts;
- a leaderboard built only from the versions currently declared in `tasks.js`;
- a collapsed archive containing older task-version results;
- median score and observed range per configuration;
- full-pass rate and repetition count;
- correctness versus elapsed-time scatter plot;
- correctness, safety, reliability, and efficiency components;
- tokens, tool calls, and individual-run details;
- filters for task and solo/team mode.

## Persisted run telemetry

New Brittain Code chats save:

- prompt and generated tokens by main, scout, coder, and verifier role;
- model-load, prompt-evaluation, generation, and total inference duration;
- wall time and peak context;
- tool calls, errors, denials, and recovered malformed calls;
- compactions, loop iterations, orchestrations, and repair attempts;
- each role's model digest, parameter size, quantization, and native context;
- app version/commit, Ollama version, temperature, context cap, and hardware profile.

Older benchmark results remain visible as legacy rows, but they cannot participate in timing/token comparisons because those chats did not persist telemetry.

# To run
```bash
node benchmark/grade.js /Downloads/Coding/brittain-bench --task cart
node benchmark/grade.js /Downloads/Coding/brittain-bench-feature --task feature
node benchmark/grade.js /Downloads/Coding/brittain-bench-debug --task debug
node benchmark/grade.js /Downloads/Coding/brittain-bench-economy --task economy
```

# To refresh git
```bash
cd ~/Downloads/Coding/brittain-bench && git reset --hard -q bench-baseline && git clean -fdq
cd ~/Downloads/Coding/brittain-bench-feature && git reset --hard -q bench-baseline && git clean -fdq
cd ~/Downloads/Coding/brittain-bench-debug && git reset --hard -q bench-baseline && git clean -fdq
cd ~/Downloads/Coding/brittain-bench-economy && git reset --hard -q bench-baseline && git clean -fdq
```
