// Brittain Code — agent tools.
// Everything the agent can do lives here: tool schemas (TOOL_DEFS), which ones
// need user approval (RISKY_TOOLS), and their implementations (executeTool).
// Add a new tool by updating TOOL_DEFS and executeTool together, and adding it
// to RISKY_TOOLS if it modifies files or runs commands.
//
// This module is deliberately electron-free so it can be tested with plain
// node — main.js injects the userData directory via initTools() at startup.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, exec } = require('child_process');

const MAX_TOOL_OUTPUT = 40_000;   // chars of tool output fed back to the model

let userDataDir = null;
function initTools(dir) {
  userDataDir = dir;
}

// ---------- persistent memory ----------
// Plain-text lessons the agent saves with the `remember` tool; injected into
// the system prompt of every chat. Lives at userData/memory.md — user-editable.
function memoryPath() {
  return path.join(userDataDir || os.tmpdir(), 'memory.md');
}

function readMemory() {
  try { return fs.readFileSync(memoryPath(), 'utf8'); } catch { return ''; }
}

// ---------- tools ----------
function resolveInside(cwd, p) {
  const abs = path.resolve(cwd, p || '.');
  return abs;
}

function truncate(s) {
  if (s.length <= MAX_TOOL_OUTPUT) return s;
  return s.slice(0, MAX_TOOL_OUTPUT) + `\n...[truncated, ${s.length} chars total]`;
}

// Recursively visit files, skipping .git and node_modules; unreadable dirs are skipped.
function walkDir(dir, onFile) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(p, onFile);
    else if (e.isFile()) onFile(p);
  }
}

// Convert a glob like "src/**/*.js" to a RegExp (no external deps).
function globToRegex(glob) {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x01')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\x01\//g, '(?:.*/)?')   // "**/" matches zero or more directories
    .replace(/\x01/g, '.*');
  return new RegExp('^' + esc + '$');
}

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file. Returns the file contents.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path, relative to the working directory or absolute' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write (create or overwrite) a text file with the given content. Creates parent directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace one exact snippet of text in a file with new text. old_string must match the file exactly (including whitespace and indentation) and must appear exactly once, unless replace_all is true. This is the preferred tool for editing existing code.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit' },
          old_string: { type: 'string', description: 'The exact existing text to replace — copy it verbatim from the file' },
          new_string: { type: 'string', description: 'The replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match (default false)' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and folders in a directory. Directories end with /.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path (default: working directory)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the working directory and return stdout/stderr. 60 second timeout.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to run' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a text pattern in files under the working directory (like grep -rn). Returns matching lines with file and line number.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text or regex to search for' },
          path: { type: 'string', description: 'Directory to search in (default: working directory)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user one or more questions and wait for their answers. Use when you are blocked on decisions only the user can make (ambiguous requirements, destructive choices, multiple valid approaches). Ask each question as its own array entry — never cram several questions into one string. Give each question 2-4 short concrete options when possible.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '1-4 questions to ask the user',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'One single question' },
                options: { type: 'array', items: { type: 'string' }, description: '2-4 short suggested answers shown as buttons' },
              },
              required: ['question'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_subagent',
      description: 'Delegate a self-contained exploration or research task to a smaller, faster model. The subagent has read-only tools (read, search, analyze files, git history) plus research logging — it cannot edit files, run commands, or ask the user anything. It CANNOT see this conversation, so the task must contain every detail it needs. Returns the subagent\'s findings. Use it to explore unfamiliar code, locate definitions and usages, or gather evidence across many files without spending your own context.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Complete, self-contained instructions: what to find, where to look, and what the findings report must include' },
          model: { type: 'string', description: 'Optional model override; defaults to the SUB model selected in the UI' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Save a short reusable lesson to persistent memory that will be available in all future chats. Use when the user corrects you, when you discover a project convention, or when you make a mistake worth avoiding next time. One concise sentence per fact.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'The lesson to remember, as one concise sentence' },
        },
        required: ['fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: 'Append content to a text file. Creates the file if it does not exist.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to append to' },
          content: { type: 'string', description: 'Content to append' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a new directory. Creates parent directories as needed.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path to create' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file. Returns success message or error.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path to delete' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_in_file',
      description: 'Search for a text pattern in a specific file and return matching lines with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to search in' },
          pattern: { type: 'string', description: 'Text or regex to search for' },
        },
        required: ['path', 'pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_info',
      description: 'Get information about a file including size, modification time, and permissions.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path to get info for' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copy_file',
      description: 'Copy a file from source to destination.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source file path' },
          destination: { type: 'string', description: 'Destination file path' },
        },
        required: ['source', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Move/rename a file from source to destination.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source file path' },
          destination: { type: 'string', description: 'Destination file path' },
        },
        required: ['source', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files matching a glob pattern in the working directory (e.g. "*.js", "src/**/*.css").',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match files (e.g., "*.js", "src/**/*")' },
          path: { type: 'string', description: 'Directory to search in (default: working directory)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_file_lines',
      description: 'Get specific lines from a file (1-based, inclusive). Defaults to 10 lines if end is omitted.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          start: { type: 'number', description: 'Starting line number (1-based)' },
          end: { type: 'number', description: 'Ending line number (1-based, inclusive)' },
        },
        required: ['path', 'start'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: 'Find-and-replace literal text everywhere in a file. The pattern is treated as plain text, not regex, unless is_regex is true. For precise single edits to code, prefer edit_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to modify' },
          pattern: { type: 'string', description: 'Literal text to find (or a JavaScript regex if is_regex is true)' },
          replacement: { type: 'string', description: 'Replacement text' },
          is_regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default false)' },
          flags: { type: 'string', description: 'Regex flags when is_regex is true (default "g")' },
        },
        required: ['path', 'pattern', 'replacement'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_lines',
      description: 'Count lines in a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_file_type',
      description: 'Determine the file type based on its extension.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_environment_variables',
      description: 'Retrieve environment variables. Optionally filter by name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the variable to retrieve. If omitted, returns all variables.' }
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_git_branch',
      description: 'Create a new git branch and switch to it.',
      parameters: {
        type: 'object',
        properties: {
          branch_name: { type: 'string', description: 'The name of the new branch to create.' },
        },
        required: ['branch_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_git_diff',
      description: 'Show the git diff for unstaged changes in the working directory.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_git_log',
      description: 'Retrieve the git commit history for the current repository.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'The maximum number of commits to show.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_file_hash',
      description: 'Calculate the hash of a file using the specified algorithm.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file.' },
          algorithm: { type: 'string', description: 'Hashing algorithm (e.g., sha256, md5, sha1). Defaults to sha256.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_processes',
      description: 'List running processes, optionally filtered by a pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern to filter processes by name.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_file_structure',
      description: 'Generate a tree view of a directory structure. Skips .git and node_modules. Useful for understanding project layout before deeper exploration.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to analyze (default: working directory)' },
          depth: { type: 'number', description: 'Maximum depth to recurse (default: 3, max: 8)' },
          include_files: { type: 'boolean', description: 'Include individual files in the tree, not just directories (default: true)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pattern_search_deep',
      description: 'Search for a pattern in files with filtering by file type, context lines, and result limits. More targeted than search_files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text or regex pattern to search for' },
          path: { type: 'string', description: 'Directory to search in (default: working directory)' },
          file_pattern: { type: 'string', description: 'Glob pattern to filter which files to search (e.g. "*.js", "src/**/*.ts")' },
          context_lines: { type: 'number', description: 'Number of lines of context to include before and after each match (default: 2)' },
          max_results: { type: 'number', description: 'Maximum number of matching lines to return (default: 50)' },
          is_regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default: false)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_largest_files',
      description: 'Find the largest files in a directory (skips .git and node_modules).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to search in' },
          count: { type: 'number', description: 'Number of largest files to return (default: 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'initiate_research_session',
      description: 'Starts a new research session by creating a RESEARCH_LOG.md file with the given or objective.',
      parameters: {
        type: 'object',
        properties: { objective: { type: 'string', description: 'The objective of the research session' } },
        required: ['objective'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_observation',
      description: 'Records a finding or observation into the active RESEARCH_LOG.md file.',
      parameters: {
        type: 'object',
        properties: {
          observation: { type: 'string', description: 'The observation to record' },
          evidence_path: { type: 'string', description: 'Path to the file or evidence supporting this observation' },
        },
        required: ['observation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finalize_research',
      description: 'Finalizes the current research session, creating a RESEARCH_REPORT.md from the log and adding a summary.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'A summary of the research findings' },
        },
        required: ['summary'],
      },
    },
  },
];

const RISKY_TOOLS = new Set([
  'write_file',
  'run_command',
  'append_file',
  'create_directory',
  'delete_file',
  'copy_file',
  'move_file',
  'replace_in_file',
  'edit_file',
  'create_git_branch',
]);

async function executeTool(name, args, cwd) {
  switch (name) {
    case 'read_file': {
      const p = resolveInside(cwd, args.path);
      const stat = fs.statSync(p);
      if (stat.size > 2_000_000) return `Error: file too large (${stat.size} bytes)`;
      return truncate(fs.readFileSync(p, 'utf8'));
    }
    case 'write_file': {
      const p = resolveInside(cwd, args.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content ?? '', 'utf8');
      return `Wrote ${(args.content ?? '').length} chars to ${p}`;
    }
    case 'list_directory': {
      const p = resolveInside(cwd, args.path);
      const entries = fs.readdirSync(p, { withFileTypes: true })
        .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .sort();
      return truncate(entries.join('\n') || '(empty directory)');
    }
    case 'run_command': {
      return new Promise((resolve) => {
        exec(args.command, { cwd, timeout: 60_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
          let out = '';
          if (stdout) out += stdout;
          if (stderr) out += (out ? '\n--- stderr ---\n' : '') + stderr;
          if (err && !err.killed) out += `\n(exit code ${err.code ?? 'signal ' + err.signal})`;
          if (err && err.killed) out += '\n(command timed out after 60s)';
          resolve(truncate(out || '(no output)'));
        });
      });
    }
    case 'search_files': {
      const dir = resolveInside(cwd, args.path);
      return new Promise((resolve) => {
        execFile(
          'grep',
          ['-rn', '--exclude-dir=.git', '--exclude-dir=node_modules', '-I', '-m', '200', '-e', args.pattern, '.'],
          { cwd: dir, timeout: 30_000, maxBuffer: 4_000_000 },
          (err, stdout) => {
            if (err && !stdout) return resolve('No matches found.');
            resolve(truncate(stdout));
          }
        );
      });
    }
    case 'remember': {
      const fact = String(args.fact || '').trim().replace(/\s*\n+\s*/g, ' ');
      if (!fact) return 'Error: fact must not be empty.';
      if (readMemory().includes(fact)) return 'Already remembered.';
      fs.appendFileSync(memoryPath(), '- ' + fact + '\n', 'utf8');
      return 'Remembered. This will be available in future chats.';
    }
    case 'append_file': {
      const p = resolveInside(cwd, args.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, args.content ?? '', 'utf8');
      return `Appended ${(args.content ?? '').length} chars to ${p}`;
    }
    case 'create_directory': {
      const p = resolveInside(cwd, args.path);
      fs.mkdirSync(p, { recursive: true });
      return `Created directory ${p}`;
    }
    case 'delete_file': {
      const p = resolveInside(cwd, args.path);
      if (!fs.existsSync(p)) return `File not found: ${p}`;
      fs.unlinkSync(p);
      return `Deleted file ${p}`;
    }
    case 'search_in_file': {
      const p = resolveInside(cwd, args.path);
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      const regex = new RegExp(args.pattern);
      const results = [];
      for (let i = 0; i < lines.length && results.length < 200; i++) {
        if (regex.test(lines[i])) results.push(`${i + 1}: ${lines[i]}`);
      }
      return results.length ? truncate(results.join('\n')) : 'No matches found.';
    }
    case 'file_info': {
      const p = resolveInside(cwd, args.path);
      const stat = fs.statSync(p);
      return JSON.stringify({
        size: stat.size,
        modified: stat.mtime.toISOString(),
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        permissions: stat.mode.toString(8),
      });
    }
    case 'copy_file': {
      const source = resolveInside(cwd, args.source);
      const dest = resolveInside(cwd, args.destination);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
      return `Copied ${source} to ${dest}`;
    }
    case 'move_file': {
      const source = resolveInside(cwd, args.source);
      const dest = resolveInside(cwd, args.destination);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(source, dest);
      return `Moved ${source} to ${dest}`;
    }
    case 'find_files': {
      const dir = resolveInside(cwd, args.path);
      const re = globToRegex(args.pattern);
      const out = [];
      walkDir(dir, (f) => {
        const rel = path.relative(dir, f);
        if (re.test(rel) || re.test(path.basename(f))) out.push(path.relative(cwd, f));
      });
      return truncate(out.slice(0, 500).join('\n')) || '(no files found)';
    }
    case 'get_file_lines': {
      const p = resolveInside(cwd, args.path);
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      const start = Math.max(0, (args.start || 1) - 1);
      const end = args.end ? Math.min(lines.length, args.end) : Math.min(lines.length, start + 10);
      return truncate(lines.slice(start, end).join('\n')) || '(no lines found)';
    }
    case 'edit_file': {
      const p = resolveInside(cwd, args.path);
      const content = fs.readFileSync(p, 'utf8');
      const oldS = String(args.old_string ?? '');
      const newS = String(args.new_string ?? '');
      if (!oldS) return 'Error: old_string must not be empty.';
      if (oldS === newS) return 'Error: old_string and new_string are identical.';
      const count = content.split(oldS).length - 1;
      if (count === 0) return `Error: old_string not found in ${p}. Read the file and copy the exact text, including whitespace and indentation.`;
      if (count > 1 && !args.replace_all) return `Error: old_string appears ${count} times in ${p}. Include more surrounding lines to make it unique, or set replace_all to true.`;
      fs.writeFileSync(p, content.split(oldS).join(newS), 'utf8');
      return `Edited ${p}: replaced ${count} occurrence(s).`;
    }
    case 'replace_in_file': {
      const p = resolveInside(cwd, args.path);
      const content = fs.readFileSync(p, 'utf8');
      const pat = String(args.pattern ?? '');
      const rep = String(args.replacement ?? '');
      if (!pat) return 'Error: pattern must not be empty.';
      let updated, count;
      if (args.is_regex) {
        const regex = new RegExp(pat, args.flags || 'g');
        const matches = content.match(regex);
        count = matches ? matches.length : 0;
        if (!count) return `No matches for pattern in ${p} — file unchanged.`;
        updated = content.replace(regex, rep);
      } else {
        count = content.split(pat).length - 1;
        if (!count) return `No matches for text in ${p} — file unchanged.`;
        updated = content.split(pat).join(rep);
      }
      // sanity guard: a bad pattern can explode the file (seen: 837k-line blowup)
      if (updated.length > content.length * 3 + 100_000) {
        return `Error: this replacement would grow the file from ${content.length} to ${updated.length} chars — refusing. The pattern is matching far more than intended.`;
      }
      fs.writeFileSync(p, updated, 'utf8');
      return `Replaced ${count} occurrence(s) in ${p}`;
    }
    case 'count_lines': {
      const p = resolveInside(cwd, args.path);
      const content = fs.readFileSync(p, 'utf8');
      return `Total lines: ${content.split('\n').length}`;
    }
    case 'get_file_type': {
      const p = resolveInside(cwd, args.path);
      if (fs.statSync(p).isDirectory()) return 'directory';
      const typeMap = {
        '.js': 'javascript', '.ts': 'typescript', '.jsx': 'javascript-react', '.tsx': 'typescript-react',
        '.html': 'html', '.css': 'css', '.json': 'json', '.md': 'markdown', '.txt': 'text',
        '.py': 'python', '.java': 'java', '.cpp': 'cpp', '.c': 'c', '.go': 'go', '.rs': 'rust',
        '.rb': 'ruby', '.sh': 'shell', '.sql': 'sql', '.yaml': 'yaml', '.yml': 'yaml', '.xml': 'xml',
      };
      return typeMap[path.extname(p).toLowerCase()] || 'unknown';
    }
    case 'find_largest_files': {
      const dir = resolveInside(cwd, args.path);
      const count = args.count || 10;
      const files = [];
      walkDir(dir, (f) => {
        try { files.push({ path: f, size: fs.statSync(f).size }); } catch {}
      });
      files.sort((a, b) => b.size - a.size);
      const result = files.slice(0, count).map((f) => `${path.relative(cwd, f.path)}: ${f.size} bytes`);
      return result.join('\n') || '(no files found)';
    }
    case 'get_environment_variables': {
      if (args.name) return process.env[args.name] || `Error: Environment variable '${args.name}' not found.`;
      return JSON.stringify(process.env, null, 2);
    }
    case 'check_port_usage': {
      const port = parseInt(args.port, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return `Error: invalid port "${args.port}"`;
      return new Promise((resolve) => {
        execFile('lsof', ['-i', ':' + port, '-sTCP:LISTEN'], { cwd, timeout: 10_000 }, (err, stdout, stderr) => {
          if (err && !stdout && !stderr) return resolve('Port is not in use.');
          resolve(truncate(stdout || stderr || '(no output)'));
        });
      });
    }
    case 'create_git_branch': {
      return gitRun(['checkout', '-b', args.branch_name], cwd).then((res) => (res.ok ? `Created and switched to branch ${args.branch_name}` : `Error: ${res.err}`));
    }
    case 'read_git_diff': {
      return gitRun(['diff'], cwd).then((res) => (res.ok ? truncate(res.out) : `Error: ${res.err}`));
    }
    case 'get_git_log': {
      const gitArgs = ['log', '--oneline', '--no-color'];
      const limit = parseInt(args.limit, 10);
      gitArgs.push('-n', String(Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20));
      return gitRun(gitArgs, cwd).then((res) => (res.ok ? truncate(res.out) : `Error: ${res.err}`));
    }
    case 'calculate_file_hash': {
      const p = resolveInside(cwd, args.path);
      const algorithm = args.algorithm || 'sha256';
      try {
        const fileBuffer = fs.readFileSync(p);
        const hashSum = crypto.createHash(algorithm);
        hashSum.update(fileBuffer);
        return `${algorithm.toUpperCase()}: ${hashSum.digest('hex')}`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    }
    case 'initiate_research_session': {
      const p = resolveInside(cwd, 'RESEARCH_LOG.md');
      const content = `# Research Session: ${args.objective}\n\n## Observations\n`;
      fs.writeFileSync(p, content, 'utf8');
      let result = `Started research session for: ${args.objective}. Log: ${p}`;
      try {
        const protocol = fs.readFileSync(resolveInside(cwd, 'RESEARCH_PROTOCOL.md'), 'utf8').trim();
        if (protocol) result += `\n\nResearch Protocol:\n${protocol}`;
      } catch {}
      return result;
    }
    case 'record_observation': {
      const p = resolveInside(cwd, 'RESEARCH_LOG.md');
      if (!fs.existsSync(p)) return `Error: No active research session. Run 'initiate_research_session' first.`;
      const entry = `- **Observation**: ${args.observation} (Evidence: ${args.evidence_path || 'N/A'})\n`;
      fs.appendFileSync(p, entry, 'utf8');
      return `Recorded observation.`;
    }
    case 'finalize_research': {
      const logP = resolveInside(cwd, 'RESEARCH_LOG.md');
      const reportP = resolveInside(cwd, 'RESEARCH_REPORT.md');
      if (!fs.existsSync(logP)) return `Error: No active research session found to finalize.`;
      const logContent = fs.readFileSync(logP, 'utf8');
      const reportContent = `${logContent}\n## Summary\n${args.summary}\n`;
      fs.writeFileSync(reportP, reportContent, 'utf8');
      return `Research session finalized. Report created at ${reportP}`;
    }
    case 'analyze_file_structure': {
      const dir = resolveInside(cwd, args.path);
      const maxDepth = Math.min(args.depth ?? 3, 8);
      const includeFiles = args.include_files !== false;
      const lines = [path.basename(dir) + '/'];
      function buildTree(d, prefix, depth) {
        if (depth > maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        entries = entries.filter(e => e.name !== '.git' && e.name !== 'node_modules').sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const last = i === entries.length - 1;
          const connector = last ? '└── ' : '├── ';
          const childPrefix = last ? '    ' : '│   ';
          if (e.isDirectory()) {
            lines.push(prefix + connector + e.name + '/');
            buildTree(path.join(d, e.name), prefix + childPrefix, depth + 1);
          } else if (includeFiles) {
            lines.push(prefix + connector + e.name);
          }
        }
      }
      buildTree(dir, '', 1);
      return truncate(lines.join('\n'));
    }
    case 'pattern_search_deep': {
      const dir = resolveInside(cwd, args.path);
      const ctxLines = Math.min(args.context_lines ?? 2, 10);
      const maxResults = Math.min(args.max_results ?? 50, 300);
      const fileRe = args.file_pattern ? globToRegex(args.file_pattern) : null;
      let searchRe;
      try {
        searchRe = args.is_regex ? new RegExp(args.pattern) : new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      } catch (e) {
        return `Error: invalid regex pattern: ${e.message}`;
      }
      const allMatches = [];
      walkDir(dir, (filePath) => {
        if (allMatches.length >= maxResults) return;
        if (fileRe) {
          const rel = path.relative(dir, filePath);
          if (!fileRe.test(rel) && !fileRe.test(path.basename(filePath))) return;
        }
        let content;
        try { content = fs.readFileSync(filePath, 'utf8'); } catch { return; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && allMatches.length < maxResults; i++) {
          if (searchRe.test(lines[i])) {
            const start = Math.max(0, i - ctxLines);
            const end = Math.min(lines.length - 1, i + ctxLines);
            const ctx = lines.slice(start, end + 1).map((l, idx) => {
              const lineNum = start + idx + 1;
              const marker = (start + idx === i) ? '>' : ' ';
              return `${marker} ${lineNum}: ${l}`;
            }).join('\n');
            allMatches.push(`--- ${path.relative(cwd, filePath)} ---\n${ctx}`);
          }
        }
      });
      return allMatches.length ? truncate(allMatches.join('\n\n')) : 'No matches found.';
    }
    case 'list_processes': {
      const pattern = args.pattern ? new RegExp(args.pattern, 'i') : null;
      return new Promise((resolve) => {
        exec('ps aux', { cwd, timeout: 10_000 }, (err, stdout, stderr) => {
          if (err) return resolve(`Error: ${err.message}`);
          const lines = stdout.split('\n');
          if (pattern) {
            const filtered = lines.filter(line => pattern.test(line));
            return resolve(truncate(filtered.join('\n')));
          }
          resolve(truncate(stdout));
        });
      });
    }
    default:
      return `Error: unknown tool "${name}"`;
  }
}

// ---------- git integration ----------
function gitRun(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout || '', err: (stderr || '').trim() });
    });
  });
}

// The restricted toolset available to subagents (run_subagent): read/search/
// analyze plus the research-logging tools (which only write RESEARCH_LOG.md /
// RESEARCH_REPORT.md). No code edits, no shell, no ask_user, no nesting.
const SUBAGENT_TOOL_NAMES = new Set([
  'read_file', 'list_directory', 'search_files', 'search_in_file', 'find_files',
  'get_file_lines', 'file_info', 'count_lines', 'get_file_type',
  'analyze_file_structure', 'pattern_search_deep', 'find_largest_files',
  'get_git_log', 'read_git_diff', 'calculate_file_hash',
  'initiate_research_session', 'record_observation', 'finalize_research',
]);
const SUBAGENT_TOOLS = TOOL_DEFS.filter((d) => SUBAGENT_TOOL_NAMES.has(d.function.name));

module.exports = {
  initTools,
  TOOL_DEFS,
  RISKY_TOOLS,
  SUBAGENT_TOOLS,
  SUBAGENT_TOOL_NAMES,
  executeTool,
  gitRun,
  memoryPath,
  readMemory,
};
