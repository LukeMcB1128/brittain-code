// Local Code — Electron main process.
// Owns the agent loop: talks to Ollama, executes tools, streams results to the UI.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');

const OLLAMA = 'http://127.0.0.1:11434';
const MAX_TOOL_OUTPUT = 40_000;   // chars of tool output fed back to the model
const MAX_AGENT_STEPS = 50;       // safety cap on tool-call loops per user message

let win = null;

// ---------- conversation state (lives in main so tool messages stay in history) ----------
let conversation = [];            // ollama-format messages, excluding system
let currentAbort = null;          // AbortController for the in-flight run
let stopRequested = false;

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#111214',
    title: 'Brittain Code',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------- ollama helpers ----------
async function ollamaJson(route, body, signal) {
  const res = await fetch(OLLAMA + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) throw new Error(`Ollama ${route} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const contextCache = new Map();
async function getContextLength(model) {
  if (contextCache.has(model)) return contextCache.get(model);
  try {
    const info = await ollamaJson('/api/show', { model });
    const mi = info.model_info || {};
    const key = Object.keys(mi).find((k) => k.endsWith('.context_length'));
    const len = key ? mi[key] : 8192;
    contextCache.set(model, len);
    return len;
  } catch {
    return 8192;
  }
}

// Only request thinking from models that advertise the capability —
// sending think:true to others makes Ollama error out.
const capsCache = new Map();
async function supportsThinking(model) {
  if (capsCache.has(model)) return capsCache.get(model);
  try {
    const info = await ollamaJson('/api/show', { model });
    const ok = Array.isArray(info.capabilities) && info.capabilities.includes('thinking');
    capsCache.set(model, ok);
    return ok;
  } catch {
    return false;
  }
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
      description: 'Ask the user a question and wait for their answer. Use when you are blocked on a decision only the user can make (ambiguous requirements, destructive choices, multiple valid approaches). Provide 2-4 concrete options when possible.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user' },
          options: { type: 'array', items: { type: 'string' }, description: 'Optional list of 2-4 suggested answers shown as buttons' },
        },
        required: ['question'],
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
      description: 'Replace text in a file using regex or literal replacement. Reports how many occurrences were replaced.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to modify' },
          pattern: { type: 'string', description: 'Text or regex to find' },
          replacement: { type: 'string', description: 'Replacement text' },
          flags: { type: 'string', description: 'Regex flags (e.g., "g", "i", "m"). Default "g".' },
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
    case 'replace_in_file': {
      const p = resolveInside(cwd, args.path);
      const content = fs.readFileSync(p, 'utf8');
      const regex = new RegExp(args.pattern, args.flags || 'g');
      const matches = content.match(regex);
      const count = matches ? matches.length : 0;
      if (!count) return `No matches for pattern in ${p} — file unchanged.`;
      fs.writeFileSync(p, content.replace(regex, args.replacement), 'utf8');
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
    default:
      return `Error: unknown tool "${name}"`;
  }
}

// ---------- approval flow ----------
const pendingApprovals = new Map();

function requestApproval(info) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    pendingApprovals.set(id, resolve);
    win.webContents.send('approval:request', { id, ...info });
  });
}

ipcMain.on('approval:response', (_e, { id, approved }) => {
  const resolve = pendingApprovals.get(id);
  if (resolve) {
    pendingApprovals.delete(id);
    resolve(approved);
  }
});

// ---------- question flow (ask_user tool) ----------
const pendingQuestions = new Map();

function requestAnswer(info) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    pendingQuestions.set(id, resolve);
    win.webContents.send('question:request', { id, ...info });
  });
}

ipcMain.on('question:response', (_e, { id, answer }) => {
  const resolve = pendingQuestions.get(id);
  if (resolve) {
    pendingQuestions.delete(id);
    resolve(answer);
  }
});

// ---------- streaming chat with ollama ----------
async function streamChat(model, messages, signal, think) {
  const res = await fetch(OLLAMA + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools: TOOL_DEFS, stream: true, ...(think ? { think: true } : {}) }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let thinking = '';
  const toolCalls = [];
  let stats = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const chunk = JSON.parse(line);
      if (chunk.error) throw new Error(chunk.error);
      const msg = chunk.message || {};
      if (msg.thinking) {
        thinking += msg.thinking;
        win.webContents.send('stream:thinking', msg.thinking);
      }
      if (msg.content) {
        content += msg.content;
        win.webContents.send('stream:token', msg.content);
      }
      if (msg.tool_calls) toolCalls.push(...msg.tool_calls);
      if (chunk.done) {
        stats = {
          promptTokens: chunk.prompt_eval_count || 0,
          evalTokens: chunk.eval_count || 0,
        };
      }
    }
  }
  return { content, thinking, toolCalls, stats };
}

// ---------- agent loop ----------
function systemPrompt(cwd) {
  return [
    "You are Brittain Code, an expert coding agent running fully offline on the user's Mac (macOS, zsh).",
    'Working directory: /tmp/x — use paths relative to it.',
    '',
    'Rules:',
    '- Explore before changing code: list and read the relevant files first. Never guess at file contents or paths.',
    '- Verify your work: read a file back after editing it, or run a command that proves the change works. Do not claim success without evidence from a tool result.',
    '- Prefer replace_in_file for small edits. Use write_file only for new files or full rewrites of files you have read completely. Never write placeholders like "... existing code ...".',
    '- Commands run in zsh with a 60 second timeout; do not start interactive programs or servers that never exit.',
    '- If a tool call errors twice, stop and ask the user for guidance with ask_user. If the user denies a tool call, do not retry it.',
    '- For ambiguous or destructive decisions, ask with ask_user and give 2-4 concrete options. Otherwise state your assumption in one line and proceed.',
    '- Be concise. End each task with a 1-3 sentence summary of what changed. Report failures honestly.',
    '',
    'Everything runs locally; you cannot access the internet.',
  ].join('\n');
}

ipcMain.handle('chat:send', async (_e, { model, text, cwd, autoApprove, think }) => {
  conversation.push({ role: 'user', content: text });
  stopRequested = false;
  currentAbort = new AbortController();

  const messages = () => [{ role: 'system', content: systemPrompt(cwd) }, ...conversation];
  const contextLength = await getContextLength(model);
  const useThink = !!think && await supportsThinking(model);

  try {
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      const { content, thinking, toolCalls, stats } = await streamChat(model, messages(), currentAbort.signal, useThink);

      if (stats) {
        win.webContents.send('stream:stats', {
          contextTokens: stats.promptTokens + stats.evalTokens,
          contextLength,
        });
      }

      const assistantMsg = { role: 'assistant', content };
      if (thinking) assistantMsg.thinking = thinking;
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      conversation.push(assistantMsg);

      if (!toolCalls.length || stopRequested) break;

      for (const tc of toolCalls) {
        const name = tc.function?.name;
        let args = tc.function?.arguments || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }

        win.webContents.send('stream:toolcall', { name, args });

        let result;
        if (stopRequested) {
          result = 'Cancelled by user.';
        } else if (name === 'ask_user') {
          const answer = await requestAnswer({
            question: String(args.question || ''),
            options: Array.isArray(args.options) ? args.options.map(String).slice(0, 4) : [],
          });
          result = answer != null
            ? `The user answered: ${answer}`
            : 'The user cancelled the question. Stop and wait for further instructions.';
          win.webContents.send('stream:toolresult', { name, result: preview(result) });
        } else if (RISKY_TOOLS.has(name) && !autoApprove) {
          const approved = await requestApproval({ name, args });
          result = approved
            ? await safeExecute(name, args, cwd)
            : 'The user denied this tool call. Ask before retrying, or try another approach.';
          if (!approved) win.webContents.send('stream:toolresult', { name, result: '(denied by user)', denied: true });
          else win.webContents.send('stream:toolresult', { name, result: preview(result) });
        } else {
          result = await safeExecute(name, args, cwd);
          win.webContents.send('stream:toolresult', { name, result: preview(result) });
        }

        conversation.push({ role: 'tool', tool_name: name, content: String(result) });
      }
      if (stopRequested) break;
    }
    return { ok: true };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: true, stopped: true };
    return { ok: false, error: String(err.message || err) };
  } finally {
    currentAbort = null;
    win.webContents.send('stream:done');
  }
});

async function safeExecute(name, args, cwd) {
  try {
    return await executeTool(name, args, cwd);
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function preview(s) {
  s = String(s);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

// ---------- misc ipc ----------
ipcMain.on('chat:stop', () => {
  stopRequested = true;
  if (currentAbort) currentAbort.abort();
  // release any pending approval as denied, any pending question as cancelled
  for (const [id, resolve] of pendingApprovals) { resolve(false); pendingApprovals.delete(id); }
  for (const [id, resolve] of pendingQuestions) { resolve(null); pendingQuestions.delete(id); }
});

ipcMain.handle('chat:reset', () => {
  conversation = [];
  return { ok: true };
});

// chat history support: the renderer saves/loads conversations, but the live
// array lives here — these let it read the current one and swap in a stored one.
ipcMain.handle('chat:get', () => conversation);

ipcMain.handle('chat:load', (_e, msgs) => {
  conversation = Array.isArray(msgs) ? msgs : [];
  return { ok: true };
});

ipcMain.handle('models:list', async () => {
  try {
    const data = await ollamaJson('/api/tags');
    return { ok: true, models: (data.models || []).map((m) => m.name) };
  } catch (err) {
    return { ok: false, error: 'Cannot reach Ollama at ' + OLLAMA + ' — is it running?' };
  }
});

ipcMain.handle('cwd:pick', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  return { ok: true, path: result.filePaths[0] };
});