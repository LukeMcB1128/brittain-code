# Brittain Code model benchmark (auto-graded, 0–100)

Compare how local Ollama models perform as coding agents inside Brittain Code.
Every model gets the **same** buggy scratch repo and the **same** task; a single
deterministic grader reads what the model did and scores it out of 100 — no human
judgment, no LLM judge, so the rubric is identical for every model.

## What it measures

| Dimension | Pts | Criteria |
|---|---|---|
| **Output** | 45 | O1 tests pass (30) · O2 generalizes / not hardcoded (10) · O3 no collateral damage (5) |
| **Discipline** | 55 | D1 explored first (10) · D2 edited the right file (10) · D3 precise editing (10) · D4 respected the spec (10) · D5 verified with a real test run (10) · D6 honest reporting (5) |

The grader owns its own copy of the tests (so editing `test.js` can't fake a pass)
and runs a **hidden** suite with different numbers (so hardcoding the visible
answers fails O2). Discipline is read from the chat transcript Brittain Code saves.

## One-time setup

```bash
bash benchmark/setup.sh            # creates ~/brittain-bench (3/8 tests fail on purpose)
# or: bash benchmark/setup.sh /custom/path
```

## Run a model

Do this **identically** for each model you want to compare:

1. **Reset the repo** to the baseline:
   ```bash
   cd ~/Downloads/Coding/brittain-bench && git reset --hard -q bench-baseline && git clean -fdq
   ```
2. In Brittain Code: **NEW SESSION**, then **DIR → ~/brittain-bench**.
3. Hold settings constant for every model: **AUTO-APPROVE on**, **ONLINE RESEARCH off**,
   **THINK off**, and `/subagent qwen3:8b` (same helper for all).
   *(Optional: a second pass with THINK on, scored as its own column — don't mix.)*
4. `/model <name>`, then paste the contents of **`prompt.txt`** as a normal message
   (not `/loop` or `/orchestrate` — those add scaffolding and hide the model's own ability).
5. When it stops, **grade before you reset**:
   ```bash
   node "/Users/lukemclarenbrittain/Downloads/Coding/Brittain Code/benchmark/grade.js"         # auto-picks the newest chat for ~/brittain-bench
   ```

The grader prints a per-criterion breakdown, a total, and a `JSON {...}` line you can
collect into a scoreboard. Point it elsewhere with `--dir`, or grade a specific run with
`--chat ~/Library/Application\ Support/Brittain\ Code/chats/<id>.json`
(`node "/Users/lukemclarenbrittain/Downloads/Coding/Brittain Code/benchmark/grade.js" --list` shows matching chats).

## Notes

- Fully offline: pure Node, no `npm install`, `node test.js` runs instantly.
- Deterministic: same working tree + transcript always yields the same score.
- One task is a noisy signal — run each model 3× and average, or ask for the extra
  scratch tasks (multi-file feature-add, and a bug with no failing test) to average over
  challenge types.
- The scratch repo lives at `~/brittain-bench` (outside this repo). Only the harness
  (`setup.sh`, `grade.js`, `prompt.txt`) is version-controlled here.
