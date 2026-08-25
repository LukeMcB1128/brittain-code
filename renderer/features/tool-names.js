// User-facing display names for tools.
//
// The agent calls tools by their exact snake_case name (e.g. `edit_file`),
// which is also what the model must see. But that raw name is ugly in the UI.
// This module maps the real tool name to a friendly label for display only.
// Logic, filtering, and tooltips should keep using the raw name.
(function attachToolNames(global) {
  // Curated labels for the built-in tools. Anything not listed here (MCP or
  // custom tools) falls back to a Title Case transformation below.
  const DISPLAY_NAMES = {
    read_file: 'Read File',
    write_file: 'Write File',
    edit_file: 'Edit File',
    edit_files: 'Edit Files',
    apply_patch: 'Apply Patch',
    append_file: 'Append to File',
    browse_files: 'Browse Files',
    search_files: 'Search Files',
    run_command: 'Run Command',
    run_project_check: 'Run Project Check',
    project_outline: 'Project Outline',
    find_symbol: 'Find Symbol',
    find_references: 'Find References',
    search_local_docs: 'Search Local Docs',
    ask_user: 'Ask User',
    run_subagent: 'Subagent',
    remember: 'Remember',
    create_directory: 'Create Directory',
    delete_file: 'Delete File',
    file_metadata: 'File Metadata',
    copy_file: 'Copy File',
    move_file: 'Move File',
    get_file_lines: 'Get File Lines',
    get_environment_variables: 'Get Environment Variables',
    check_port_usage: 'Check Port Usage',
    start_process: 'Start Process',
    process_status: 'Process Status',
    stop_process: 'Stop Process',
    local_http_request: 'Local HTTP Request',
    browser_open: 'Open Browser',
    browser_snapshot: 'Browser Snapshot',
    browser_click: 'Browser Click',
    browser_type: 'Browser Type',
    browser_console: 'Browser Console',
    browser_screenshot: 'Browser Screenshot',
    browser_close: 'Close Browser',
    create_git_branch: 'Create Git Branch',
    git_status: 'Git Status',
    revert_to_last_commit: 'Revert to Last Commit',
    read_git_diff: 'Read Git Diff',
    get_git_log: 'Git Log',
    get_git_graph: 'Git Graph',
    list_processes: 'List Processes',
    initiate_research_session: 'Start Research Session',
    record_observation: 'Record Observation',
    finalize_research: 'Finalize Research',
    web_search: 'Web Search',
    web_fetch: 'Web Fetch',
  };

  function displayToolName(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    if (DISPLAY_NAMES[raw]) return DISPLAY_NAMES[raw];
    // Fallback: snake_case / kebab-case -> Title Case for unmapped tools.
    return raw
      .split(/[_\-\s]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  const api = { displayToolName, DISPLAY_NAMES };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.ToolNames = api;
})(typeof window !== 'undefined' ? window : global);
