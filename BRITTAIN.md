# Agent Instructions: brittain-code

Follow these instructions when performing tasks within this repository.

## Core Development Patterns

### 1. Tool Implementation (Main Process)
When tasked with adding or modifying tools in `main.js`:
- **Atomicity**: You must update both the `TOOL_DEFS` array (the schema) and the `executeTool` switch statement (the logic) in a single coherent workflow.
- **Risk Assessment**: If the new tool performs any filesystem or shell operations, you **must** add its name to the `RISKY_TOOLS` Set to ensure the user is prompted for approval.
- **Verification**: After implementing a tool, immediately verify it by using the tool itself (e.g., if you added `check_version`, run it).

### 2. IPC & UI Updates
When modifying the interface or adding new capabilities:
- **Bridge Integrity**: Any new `ipcMain` handler in `main.js` **must** be accompanied by a corresponding `contextBridge` exposure in `preload.js`.
- **UI Feedback**: When adding new UI elements in `renderer/`, ensure they utilize the existing `setState` and `status-bar` patterns to provide feedback to the user during long-running operations.

### 3. File Editing Convention
- **Preference**: Use `edit_file` for all modifications to existing code in `main.js`, `preload.js`, and `renderer/app.js`. 
- **Accuracy**: Always `read_file` immediately before `edit_file` to ensure the `old_string` matches the current state of the file exactly, including whitespace.
- **Avoid Overwrites**: Do not use `write_file` for existing files unless the change is a complete rewrite.

### 4. Testing & Verification
- **Development Loop**: Use `npm start` for all testing. Do not rely on the built `.app` version for debugging.
- **Regression Testing**: After any change to `main.js`, run `npm start` and verify that existing tools (like `read_file` or `list_directory`) still function correctly.
- **Deployment**: Only use `npm run deploy` when a feature is fully verified and ready for the permanent installation.

## Constraints
- **No External Dependencies**: Do not attempt to install new npm packages unless explicitly instructed.
- **Offline Protocol**: All testing and verification must assume no internet access is available.
