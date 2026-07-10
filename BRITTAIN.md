# Repository Instructions: brittain-code

You are maintaining and developing the Brittain Code application itself. Follow these strict architectural and tool protocols to ensure code safety, prevent hanging processes, and maintain repository health.

## Core Architecture Rules

### 1. Tool Lifecycle (Modifying tools.js)
All agent tools live in `tools.js` — schemas (`TOOL_DEFS`), the approval list (`RISKY_TOOLS`), implementations (`executeTool`), and their helpers. Do not add tool code to `main.js`; it imports everything from `tools.js`. When adding, removing, or updating tools:
- **Atomicity**: You must update the schema in `TOOL_DEFS` and the execution logic inside the `executeTool` switch statement within a single task loop, both in `tools.js`.
- **Security Tracking**: If a new tool performs file modifications, network requests, or system executions, you **must** append its name to the `RISKY_TOOLS` Set so the runtime prompts the user for authorization.
- **Schema Validation**: Ensure any new tool definition strictly follows the OpenAI function-calling JSON schema format matching the existing tools.

### 2. Desktop IPC Bridge Integrity
- **The Three-Layer Rule**: Any feature crossing the process boundary must be updated across all three layers simultaneously:
  1. Main Process (`main.js`): Expose the `ipcMain.handle` or `ipcMain.on` listener.
  2. Preload Script (`preload.js`): Expose the safe wrapper via `contextBridge.exposeInMainWorld`.
  3. UI Layer (`renderer/app.js`): Invoke the exposed window method and handle the Promise resolving/rejecting states gracefully.
- **UI State**: Always update the user interface state indicators during long-running async IPC calls so the user doesn't assume the app has frozen.

---

## Tool Execution Protocols

### 1. Code Modification Safety
- **Uniqueness Check**: Before executing `edit_file`, you must ensure your `old_string` is completely unique within the target file. If the snippet (e.g., `return true;`) appears multiple times, pad your `old_string` with 2–3 lines of surrounding context code to guarantee a precise, single match.
- **Bulk Changes**: Use `replace_in_file` only for global variable renames or project-wide structural updates. For fine-grained refactoring, default to `edit_file`.

### 2. Process & Testing Safeguards (Anti-Hang Protocol)
Because your shell environment terminates commands after 60 seconds and forbids blocking interactive interfaces:
- **No Direct App Launching**: Never run `npm start` or raw GUI execution commands directly inside `run_command`, as they will hang the agent shell.
- **Verification Workaround**: To verify changes without launching the full GUI app, use non-blocking testing methods via `run_command`:
  - Run a syntax/linter check: `npm run lint` or `npx eslint main.js`
  - Run specialized headless test suites if available.
- **Port & Process Management**: If a testing tool reports an `EADDRINUSE` error or an environmental conflict, proactively use `check_port_usage` and `list_processes` to locate and terminate conflicting background tasks.

### 3. Knowledge Management (`remember`)
Memory is scoped to the selected project but stored under the application's user-data directory, never inside the repository.
You must use the `remember` tool to log persistent context when:
- A specific zsh environment quirk or shell path issue on the host Mac is encountered.
- The user corrects your interpretation of an architectural pattern in this codebase.
- You uncover a unique code style preference used within the `renderer/` folder.

### 4. Research (`initiate_research_session`, `record_observation`, `finalize_research`)
After you or a subagent FINISHS a research session, and make sure you know all the information from it, and then remove the RESEARCH_LOG.md file, make sure you have the report and it is finished.

---

## Critical Constraints
- **Zero Blind Rewrites**: Do not use `write_file` on any core file (`main.js`, `tools.js`, `preload.js`, `renderer/app.js`) unless you have read the entire file first using `read_file` or mapped it using `get_file_lines`.
- **Dependency Freeze**: Do not add dependencies to `package.json` or attempt to run `npm install` for external packages unless the user explicitly orders you to do so via `ask_user`.
