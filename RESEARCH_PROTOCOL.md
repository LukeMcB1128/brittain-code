# Research Protocol: Deep Research Capability

This document defines the standard operating procedure for conducting autonomous, deep-dive investigations within the environment.

## 1. The Research Loop
Every research session must follow a structured iterative cycle:

1.  **Initiation**: Define a clear, bounded objective. Use `initiate_research_session(objective)`.
2.  **Hypothesis Generation**: Before performing any file operations, state a hypothesis about what you expect to find or what the underlying cause of a behavior might be.
3.  **Exploration**: Use discovery tools (`browse_files`, `search_files`) to navigate the codebase.
4.  **Observation & Evidence**: As you encounter relevant code, patterns, or errors, record them using `record_observation(observation, evidence_path)`. **Never record an observation without a specific file path as evidence.**
5.  **Verification**: Actively seek to disprove or confirm your hypotheses by examining related files or running diagnostic commands.
6.  **Synthesis & Finalization**: Once the objective is met or progress has plateaued, summarize the findings and use `finalize_research(summary)` to generate the final report.

## 2. Data Structures

### A. The Research Log (`RESEARCH_LOG.md`)
The log is a living document of the investigation. It must follow this format:
```markdown
# Research Session: [Objective]

## Observations
- **Observation**: [Detailed description of what was found] (Evidence: [path/to/file])
- **Observation**: [Detailed description of what was found] (Evidence: [path/to/file])
```

### B. The Research Report (`RESEARCH_REPORT.md`)
The report is the permanent record of the completed investigation. It consists of the full `RESEARCH_LOG.md` followed by a synthesized conclusion:
```markdown
[Full Content of RESEARCH_LOG.md]

## Summary
[A high-level synthesis of the findings, conclusions drawn, and any recommended next steps or architectural changes.]
```

## 3. Principles of Deep Research
- **Traceability**: Every claim must be traceable to a specific line of code or command output.
- **Breadth then Depth**: Start with wide-scale directory/file searches to understand context, then move to fine-grained `read_file` or targeted `search_files` operations.
- **Avoid Noise**: Do not log trivial information (e.g., "Found file index.js"). Only log observations that contribute to the research objective.
- **Self-Correction**: If an exploration path leads to a dead end, explicitly record that "No relevant patterns were found in [path]" to prevent re-exploring the same area.
