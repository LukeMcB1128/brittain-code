'use strict';

const NETWORK_TOOLS = new Set(['web_search', 'web_fetch']);
const SENSITIVE_TOOLS = new Set(['get_environment_variables', 'list_processes']);
const DESTRUCTIVE_TOOLS = new Set(['revert_to_last_commit']);

const RISKY_TOOLS = new Set([
  'write_file',
  // Every PDF tool writes a file. They default to a new path beside the
  // source, but the caller may name the source itself as the output, so they
  // are gated like any other write.
  'pdf_fill_form',
  'pdf_stamp',
  'pdf_pages',
  'pdf_merge',
  'run_command',
  'run_project_check',
  'start_process',
  'stop_process',
  'local_http_request',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'append_file',
  'create_directory',
  'delete_file',
  'copy_file',
  'move_file',
  'edit_file',
  'edit_files',
  'apply_patch',
  'create_git_branch',
  'revert_to_last_commit',
  'get_environment_variables',
  'list_processes',
  'initiate_research_session',
  'record_observation',
  'finalize_research',
  'web_search',
  'web_fetch',
]);

const SUBAGENT_TOOL_NAMES = new Set([
  'read_file', 'browse_files', 'search_files', 'search_local_docs',
  'project_outline', 'find_symbol', 'find_references',
  'get_file_lines', 'file_metadata',
  'get_git_log', 'read_git_diff', 'check_port_usage',
]);

const ORCHESTRATOR_TOOL_NAMES = new Set([
  ...SUBAGENT_TOOL_NAMES,
  'run_subagent', 'web_search', 'web_fetch',
]);

const CODER_TOOL_NAMES = new Set([
  'read_file', 'write_file', 'edit_file', 'edit_files', 'apply_patch', 'append_file',
  'create_directory', 'delete_file', 'copy_file', 'move_file',
  'browse_files', 'search_files', 'search_local_docs',
  'project_outline', 'find_symbol', 'find_references',
  'get_file_lines', 'file_metadata',
  'browser_open', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_console', 'browser_screenshot', 'browser_close',
  'run_command', 'run_project_check', 'git_status', 'read_git_diff',
  'pdf_info', 'pdf_fill_form', 'pdf_stamp', 'pdf_pages', 'pdf_merge',
]);

// Chat has no filesystem, and these are the one exception: they act only on
// files the person attached this turn, enforced in src/tools/attached-files.js.
const CHAT_TOOL_NAMES = new Set([
  'ask_user', 'calculate', 'remember', 'web_search', 'web_fetch',
  'pdf_info', 'pdf_fill_form', 'pdf_stamp', 'pdf_pages', 'pdf_merge',
]);

const SUBMIT_IMPLEMENTATION_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'submit_implementation_plan',
    description: 'Finish planning by submitting an ordered implementation plan. Call this exactly once after inspecting enough of the project. Tasks run sequentially, so later tasks may depend on earlier tasks.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Short architectural summary of the approach.' },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short task title.' },
              objective: { type: 'string', description: 'Concrete implementation objective for the coding model.' },
              acceptance_criteria: {
                type: 'array',
                items: { type: 'string' },
                description: 'Observable conditions required for this task to be complete.',
              },
              relevant_files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Project-relative files the coder should inspect first. This is guidance, not a write allowlist.',
              },
              constraints: {
                type: 'array',
                items: { type: 'string' },
                description: 'Important project or safety constraints for this task.',
              },
            },
            required: ['title', 'objective', 'acceptance_criteria'],
          },
        },
      },
      required: ['summary', 'tasks'],
    },
  },
};

function selectTools(toolDefinitions, names) {
  return toolDefinitions.filter((definition) => names.has(definition.function.name));
}

function createToolPolicy(toolDefinitions) {
  return {
    NETWORK_TOOLS,
    SENSITIVE_TOOLS,
    DESTRUCTIVE_TOOLS,
    RISKY_TOOLS,
    SUBAGENT_TOOL_NAMES,
    SUBAGENT_TOOLS: selectTools(toolDefinitions, SUBAGENT_TOOL_NAMES),
    ORCHESTRATOR_TOOL_NAMES,
    ORCHESTRATOR_TOOLS: [
      ...selectTools(toolDefinitions, ORCHESTRATOR_TOOL_NAMES),
      SUBMIT_IMPLEMENTATION_PLAN_TOOL,
    ],
    CODER_TOOL_NAMES,
    CODER_TOOLS: selectTools(toolDefinitions, CODER_TOOL_NAMES),
    CHAT_TOOL_NAMES,
    CHAT_TOOLS: selectTools(toolDefinitions, CHAT_TOOL_NAMES),
  };
}

module.exports = {
  CHAT_TOOL_NAMES,
  CODER_TOOL_NAMES,
  DESTRUCTIVE_TOOLS,
  NETWORK_TOOLS,
  ORCHESTRATOR_TOOL_NAMES,
  RISKY_TOOLS,
  SENSITIVE_TOOLS,
  SUBAGENT_TOOL_NAMES,
  SUBMIT_IMPLEMENTATION_PLAN_TOOL,
  createToolPolicy,
};
