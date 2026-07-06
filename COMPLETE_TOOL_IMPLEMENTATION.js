// COMPLETE IMPLEMENTATION OF ENHANCED TOOLS FOR BRITTAIN CODE

// ========== UPDATED TOOL_DEFS ARRAY ==========

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
      description: 'Find files matching a pattern in the working directory. Supports glob patterns.',
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
      description: 'Get specific lines from a file. Returns lines as an array.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          start: { type: 'number', description: 'Starting line number (1-based)' },
          end: { type: 'number', description: 'Ending line number (1-based)' },
        },
        required: ['path', 'start'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: 'Replace text in a file using regex or literal replacement.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to modify' },
          pattern: { type: 'string', description: 'Text or regex to find' },
          replacement: { type: 'string', description: 'Replacement text' },
          flags: { type: 'string', description: 'Regex flags (e.g., "g", "i", "m")' },
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
      description: 'Determine the file type based on its content or extension.',
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
      description: 'Find the largest files in a directory.',
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

// ========== UPDATED RISKY_TOOLS SET ==========

const RISKY_TOOLS = new Set([
  'write_file', 
  'run_command', 
  'append_file', 
  'create_directory', 
  'delete_file', 
  'copy_file', 
  'move_file', 
  'replace_in_file'
]);

// ========== UPDATED executeTool FUNCTION ==========

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
    case 'append_file': {
      const p = resolveInside(cwd, args.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, args.content ?? '', 'utf8');
      return `Appended ${(args.content ?? '').length} chars to ${p}`;
    }
    case 'list_directory': {
      const p = resolveInside(cwd, args.path);
      const entries = fs.readdirSync(p, { withFileTypes: true })
        .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .sort();
      return truncate(entries.join('\n') || '(empty directory)');
    }
    case 'create_directory': {
      const p = resolveInside(cwd, args.path);
      fs.mkdirSync(p, { recursive: true });
      return `Created directory ${p}`;
    }
    case 'delete_file': {
      const p = resolveInside(cwd, args.path);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        return `Deleted file ${p}`;
      } else {
        return `File not found: ${p}`;
      }
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
    case 'search_in_file': {
      const p = resolveInside(cwd, args.path);
      const content = fs.readFileSync(p, 'utf8');
      const lines = content.split('\n');
      const results = [];
      const regex = new RegExp(args.pattern, args.flags || 'g');
      let match;
      let lineNum = 1;
      
      for (const line of lines) {
        while ((match = regex.exec(line)) !== null) {
          results.push(`${lineNum}:${match[0]}`);
          if (results.length >= 200) break; // Limit results
        }
        lineNum++;
        if (results.length >= 200) break;
      }
      
      return results.length > 0 ? results.join('\n') : 'No matches found.';
    }
    case 'file_info': {
      const p = resolveInside(cwd, args.path);
      const stat = fs.statSync(p);
      return JSON.stringify({
        size: stat.size,
        modified: stat.mtime.toISOString(),
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        permissions: stat.mode.toString(8)
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
      const dir = resolveInside(cwd, args.path || '.');
      const pattern = args.pattern;
      // Using glob for pattern matching
      const glob = require('glob');
      const files = glob.sync(path.join(dir, pattern), { nodir: true });
      return files.map(f => path.relative(cwd, f)).join('\n') || '(no files found)';
    }
    case 'get_file_lines': {
      const p = resolveInside(cwd, args.path);
      const content = fs.readFileSync(p, 'utf8');
      const lines = content.split('\n');
      const start = Math.max(0, args.start - 1);
      const end = args.end ? Math.min(lines.length, args.end) : start + 10; // Default 10 lines
      return lines.slice(start, end).join('\n') || '(no lines found)';
    }
    case 'replace_in_file': {
      const p = resolveInside(cwd, args.path);
      let content = fs.readFileSync(p, 'utf8');
      const regex = new RegExp(args.pattern, args.flags || 'g');
      const originalContent = content;
      content = content.replace(regex, args.replacement);
      fs.writeFileSync(p, content, 'utf8');
      return `Replaced text in ${p}`;
    }
    case 'count_lines': {
      const p = resolveInside(cwd, args.path);
      const content = fs.readFileSync(p, 'utf8');
      const lines = content.split('\n');
      return `Total lines: ${lines.length}`;
    }
    case 'get_file_type': {
      const p = resolveInside(cwd, args.path);
      const ext = path.extname(p).toLowerCase();
      const stat = fs.statSync(p);
      
      if (stat.isDirectory()) {
        return 'directory';
      }
      
      const typeMap = {
        '.js': 'javascript',
        '.ts': 'typescript',
        '.jsx': 'javascript-react',
        '.tsx': 'typescript-react',
        '.html': 'html',
        '.css': 'css',
        '.json': 'json',
        '.md': 'markdown',
        '.txt': 'text',
        '.py': 'python',
        '.java': 'java',
        '.cpp': 'cpp',
        '.c': 'c',
        '.go': 'go',
        '.rs': 'rust',
        '.rb': 'ruby',
        '.sh': 'shell',
        '.sql': 'sql',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.xml': 'xml'
      };
      
      return typeMap[ext] || 'unknown';
    }
    case 'find_largest_files': {
      const dir = resolveInside(cwd, args.path || '.');
      const count = args.count || 10;
      
      const files = [];
      const walk = (dir) => {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const itemPath = path.join(dir, item);
          const stat = fs.statSync(itemPath);
          if (stat.isDirectory()) {
            walk(itemPath);
          } else {
            files.push({ path: itemPath, size: stat.size });
          }
        }
      };
      
      walk(dir);
      files.sort((a, b) => b.size - a.size);
      
      const result = files.slice(0, count).map(f => {
        const relPath = path.relative(cwd, f.path);
        return `${relPath}: ${f.size} bytes`;
      });
      
      return result.join('\n') || '(no files found)';
    }
    default:
      return `Error: unknown tool "${name}"`;
  }
}