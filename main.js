// Local Code — Electron main process.
// Owns the agent loop: talks to Ollama, executes tools, streams results to the UI.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { initTools, TOOL_DEFS, RISKY_TOOLS, SUBAGENT_TOOLS, SUBAGENT_TOOL_NAMES, executeTool, gitRun, memoryPath, readMemory } = require('./tools');
const { stderr } = require('process');

const OLLAMA = 'http://127.0.0.1:11434';
const MAX_AGENT_STEPS = 50;       // safety cap on tool-call loops per user message
// The context window we actually request from Ollama. Without an explicit
// num_ctx, Ollama uses its own (much smaller) default and SILENTLY TRUNCATES
// the oldest messages — the model loses the system prompt and the task, then
// hallucinates ("the user hasn't asked anything yet"). Capped below the model
// maximum because KV-cache RAM grows with the window. 64k sized for gemma4:26b
// on a 36GB Mac WITH Ollama's q8_0 KV cache enabled (OLLAMA_FLASH_ATTENTION=1,
// OLLAMA_KV_CACHE_TYPE=q8_0 via launchctl setenv); drop to 32_768 without it.
const NUM_CTX_CAP = 65_536;

async function effectiveContext(model) {
  return Math.min(await getContextLength(model), NUM_CTX_CAP);
}

let win = null;

// ---------- conversation state (lives in main so tool messages stay in history) ----------
let conversation = [];            // ollama-format messages, excluding system
let currentAbort = null;          // AbortController for the in-flight run
let stopRequested = false;

// ---------- usage accounting (per chat; reset on new session / chat load) ----------
function freshUsage() {
  return {
    main: { calls: 0, prompt: 0, gen: 0 },
    subagent: { calls: 0, prompt: 0, gen: 0, runs: 0 },
    verifier: { calls: 0, prompt: 0, gen: 0 },
    context: { tokens: 0, limit: 0 },
  };
}
let usage = freshUsage();

function recordUsage(bucket, stats) {
  if (!stats) return;
  usage[bucket].calls += 1;
  usage[bucket].prompt += stats.promptTokens || 0;
  usage[bucket].gen += stats.evalTokens || 0;
}

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

app.whenReady().then(() => {
  initTools(app.getPath('userData'));
  createWindow();
});
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

// Model capability checks (thinking, vision) — sending think:true or images
// to a model that lacks the capability makes Ollama error out.
const capsCache = new Map();
async function getCapabilities(model) {
  if (capsCache.has(model)) return capsCache.get(model);
  try {
    const info = await ollamaJson('/api/show', { model });
    const caps = Array.isArray(info.capabilities) ? info.capabilities : [];
    capsCache.set(model, caps);
    return caps;
  } catch {
    return [];
  }
}
const supportsThinking = async (model) => (await getCapabilities(model)).includes('thinking');
const supportsVision = async (model) => (await getCapabilities(model)).includes('vision');

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
async function streamChat(model, messages, signal, think, silent = false, numCtx = 8192, toolset = TOOL_DEFS) {
  const res = await fetch(OLLAMA + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      ...(toolset ? { tools: toolset } : {}), // null = no tools (forces a text answer)
      stream: true,
      options: { num_ctx: numCtx },
      ...(think === undefined ? {} : { think }),
    }),
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
        if (!silent) win.webContents.send('stream:thinking', msg.thinking);
      }
      if (msg.content) {
        content += msg.content;
        if (!silent) win.webContents.send('stream:token', msg.content);
      }
      if (msg.tool_calls) toolCalls.push(...msg.tool_calls);
      if (chunk.done) {
        stats = {
          promptTokens: chunk.prompt_eval_count || 0,
          evalTokens: chunk.eval_count || 0,
          tokPerSec: chunk.eval_duration ? (chunk.eval_count || 0) / (chunk.eval_duration / 1e9) : 0,
        };
      }
    }
  }
  return { content, thinking, toolCalls, stats };
}

// ---------- fallback tool-call parser ----------
// Some models (seen with qwen3-coder) occasionally emit their native tool-call
// markup as plain text instead of a structured call, e.g.:
//   <tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.js\n</parameter>\n</function>\n</tool_call>
// often truncated or missing wrapper tags. When Ollama parses nothing, this
// recovers those calls from the raw text so the agent loop can still run them.
function coerceParamValue(v) {
  return /^(true|false|null|-?\d+(\.\d+)?)$/.test(v) ? JSON.parse(v) : v;
}

function parseRawToolCalls(content) {
  if (!content.includes('<function=')) return null;
  const calls = [];
  const fnRe = /<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g;
  let m;
  while ((m = fnRe.exec(content)) !== null) {
    const name = m[1];
    const args = {};
    // closed parameters
    const rest = m[2].replace(/<parameter=([\w.-]+)>\r?\n?([\s\S]*?)\r?\n?<\/parameter>/g, (_all, k, v) => {
      args[k] = coerceParamValue(v);
      return '';
    });
    // a trailing unclosed parameter (truncated output)
    const open = rest.match(/<parameter=([\w.-]+)>\r?\n?([\s\S]*)/);
    if (open) {
      const v = open[2].replace(/<[^>]*$/, '').trim();
      if (v) args[open[1]] = coerceParamValue(v);
    }
    calls.push({ function: { name, arguments: args } });
  }
  if (!calls.length) return null;
  const cleaned = content
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
    .replace(/<function=[\s\S]*?(?:<\/function>|$)/g, '')
    .replace(/<\/?(tool_call|function|parameter)[^>]*>/g, '')
    .trim();
  return { calls, cleaned };
}

// ---------- agent loop ----------
function systemPrompt(cwd) {
  const lines = [
    "You are Brittain Code, an expert coding agent running fully offline on the user's Mac (macOS, zsh).",
    `Working directory: ${cwd} — use paths relative to it.`,
    '',
    'Rules:',
    '- Explore before changing code: list and read the relevant files first. Never guess at file contents or paths.',
    '- Verify your work: read a file back after editing it, or run a command that proves the change works. Do not claim success without evidence from a tool result.',
    '- Edit existing code with edit_file: copy the exact old text from the file and give the new text. Use write_file only for new files or full rewrites of files you have read completely. Never write placeholders like "... existing code ...".',
    '- Commands run in zsh with a 60 second timeout; do not start interactive programs or servers that never exit.',
    '- If a tool call errors twice, stop and ask the user for guidance with ask_user. If the user denies a tool call, do not retry it.',
    '- For ambiguous or destructive decisions, ask with ask_user and give 2-4 concrete options. Otherwise state your assumption in one line and proceed.',
    '- Delegate self-contained exploration or research to run_subagent (a faster read-only model). Give it complete instructions — it cannot see this conversation. Prefer it over reading many files yourself.',
    '- Save reusable lessons (user corrections, project conventions, mistakes to avoid) with the remember tool — they persist across chats.',
    '- Be concise. End each task with a 1-3 sentence summary of what changed. Report failures honestly.',
    '',
    'Everything runs locally; you cannot access the internet.',
  ];
  const memory = readMemory().trim();
  if (memory) {
    // cap so a huge memory file cannot blow up the prompt (keep the newest lines)
    const capped = memory.length > 4000
      ? '[…older lessons truncated — prune memory.md]\n' + memory.slice(-4000)
      : memory;
    lines.push('', 'Lessons remembered from previous sessions:', capped);
  }
  // per-project instructions, like Claude Code's CLAUDE.md
  try {
    const proj = fs.readFileSync(path.join(cwd, 'BRITTAIN.md'), 'utf8').trim();
    if (proj) {
      const capped = proj.length > 12_000
        ? proj.slice(0, 12_000) + '\n[…BRITTAIN.md truncated at 12,000 chars — shorten the file]'
        : proj;
      lines.push('', 'Project instructions (from BRITTAIN.md in the working directory):', capped);
    }
  } catch {}
  return lines.join('\n');
}

// One full agent turn: stream → tools → repeat until the model stops calling
// tools or a cap is hit. Shared by chat:send and chat:loop.
async function runAgentTurn(model, cwd, autoApprove, think, subModel) {
  const messages = () => [{ role: 'system', content: systemPrompt(cwd) }, ...conversation];
  // report the window we actually run with, not the model's theoretical max
  const contextLength = await effectiveContext(model);
  // For models that support thinking, always send an explicit true/false —
  // omitting the param makes Ollama think by default, ignoring the toggle.
  const useThink = (await supportsThinking(model)) ? !!think : undefined;
  let lastContent = '';
  let lastStats = null;

  {
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      let { content, thinking, toolCalls, stats } = await streamChat(model, messages(), currentAbort.signal, useThink, false, contextLength);

      // rescue tool calls the model emitted as raw text (qwen3-coder quirk)
      if (!toolCalls.length) {
        const recovered = parseRawToolCalls(content);
        if (recovered) {
          toolCalls = recovered.calls;
          content = recovered.cleaned;
          // the raw markup already streamed to the UI — replace it with the cleaned text
          win.webContents.send('stream:cleancontent', content);
        }
      }

      if (stats) {
        recordUsage('main', stats);
        usage.context = { tokens: stats.promptTokens + stats.evalTokens, limit: contextLength };
        win.webContents.send('stream:stats', {
          contextTokens: stats.promptTokens + stats.evalTokens,
          contextLength,
          tokPerSec: stats.tokPerSec,
        });
      }

      const assistantMsg = { role: 'assistant', content };
      if (thinking) assistantMsg.thinking = thinking;
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      conversation.push(assistantMsg);
      if (content) lastContent = content;
      if (stats) lastStats = stats;

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
          // accept both the questions array and the legacy single-question shape
          let qs = Array.isArray(args.questions) ? args.questions
            : args.question ? [{ question: args.question, options: args.options }]
            : [];
          qs = qs.slice(0, 4).map((q) => ({
            question: String(q.question || q || ''),
            options: Array.isArray(q.options) ? q.options.map(String).slice(0, 4) : [],
          })).filter((q) => q.question);

          if (!qs.length) {
            result = 'Error: ask_user requires a "questions" array of {question, options} objects.';
          } else {
            const answers = await requestAnswer({ questions: qs });
            result = answers
              ? 'The user answered:\n' + qs.map((q, i) => `Q: ${q.question}\nA: ${answers[i]}`).join('\n')
              : 'The user cancelled the question. Stop and wait for further instructions.';
          }
          win.webContents.send('stream:toolresult', { name, result: preview(result) });
        } else if (name === 'run_subagent') {
          const task = String(args.task || '').trim();
          if (!task) {
            result = 'Error: run_subagent requires a task with complete, self-contained instructions.';
          } else {
            result = await runSubagent(task, String(args.model || subModel || 'qwen3:8b'), cwd);
          }
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
  }
  return { lastContent, lastStats, contextLength };
}

ipcMain.handle('chat:send', async (_e, { model, text, cwd, autoApprove, think, images, subModel }) => {
  if (images?.length && !(await supportsVision(model))) {
    return { ok: false, error: `${model} cannot see images — pick a vision-capable model or remove the attachment.` };
  }
  const userMsg = { role: 'user', content: text };
  if (images?.length) userMsg.images = images;
  conversation.push(userMsg);
  stopRequested = false;
  currentAbort = new AbortController();

  try {
    await runAgentTurn(model, cwd, autoApprove, think, subModel);
    return { ok: true };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: true, stopped: true };
    return { ok: false, error: String(err.message || err) };
  } finally {
    currentAbort = null;
    win.webContents.send('stream:done');
  }
});

ipcMain.handle('tools:list', async () => {
  return {
    ok: true,
    tools: TOOL_DEFS.map(t => ({
      name: t.function.name,
      isRisky: RISKY_TOOLS.has(t.function.name)
    }))
  };
});

// ---------- subagents ----------
const SUBAGENT_MAX_STEPS = 12;
const SUBAGENT_CTX_CAP = 24_576;    // smaller window: subagents are short-lived scouts
const SUBAGENT_REPORT_CAP = 6000;   // chars of findings returned to the main agent
const SUBAGENT_TIMEOUT_MS = 240_000; // wall-clock cap — model swapping makes steps slow, but not infinite

function subagentSystemPrompt(cwd) {
  return [
    'You are a fast research subagent inside Brittain Code, working for a lead agent.',
    `Working directory: ${cwd} — use paths relative to it.`,
    'You have read-only exploration tools plus research-logging tools. You cannot edit code, run shell commands, or ask the user questions.',
    '',
    'Strategy — follow this order:',
    '1. list_directory (or analyze_file_structure) first to see what files exist.',
    '2. search_files with SHORT single-word patterns: search "history", never "chat history persistence logic". Multi-word phrases almost never match code.',
    '3. read_file the promising files and base your answer on what you actually read.',
    'If a search finds nothing, do not retry it with similar words — switch tactics (list the directory, read the most likely file).',
    'You have a budget of roughly 12 tool calls. Spend a few exploring, then STOP calling tools and write your report.',
    '',
    'Your FINAL message is the only thing returned to the lead agent, so make it a complete findings report: cite file paths and line numbers, quote the relevant code, and answer every part of the task. If you cannot find something, say so explicitly rather than guessing.',
  ].join('\n');
}

async function runSubagent(task, subModel, cwd) {
  const msgs = [
    { role: 'system', content: subagentSystemPrompt(cwd) },
    { role: 'user', content: task },
  ];
  const numCtx = Math.min(await getContextLength(subModel), SUBAGENT_CTX_CAP);
  // scouts should be fast: disable thinking where the model supports the flag
  const useThink = (await supportsThinking(subModel)) ? false : undefined;
  let finalContent = '';
  let steps = 0;
  // deadline for the whole subagent: aborts on user STOP or on timeout
  const signal = currentAbort
    ? AbortSignal.any([currentAbort.signal, AbortSignal.timeout(SUBAGENT_TIMEOUT_MS)])
    : AbortSignal.timeout(SUBAGENT_TIMEOUT_MS);
  const timedOut = () => signal.aborted && !stopRequested;

  win.webContents.send('stream:subagent', { phase: 'start', task, model: subModel });
  try {
    usage.subagent.runs += 1;
    for (let step = 0; step < SUBAGENT_MAX_STEPS; step++) {
      if (stopRequested || signal.aborted) break;
      let { content, toolCalls, stats } = await streamChat(subModel, msgs, signal, useThink, true, numCtx, SUBAGENT_TOOLS);
      recordUsage('subagent', stats);

      if (!toolCalls.length) {
        const recovered = parseRawToolCalls(content);
        if (recovered) {
          toolCalls = recovered.calls;
          content = recovered.cleaned;
        }
      }
      if (content) finalContent = content;

      const assistantMsg = { role: 'assistant', content };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      msgs.push(assistantMsg);
      if (!toolCalls.length) break;

      for (const tc of toolCalls) {
        const name = tc.function?.name;
        let args = tc.function?.arguments || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        steps++;
        win.webContents.send('stream:subagent', { phase: 'tool', name, args });
        const result = SUBAGENT_TOOL_NAMES.has(name)
          ? await safeExecute(name, args, cwd)
          : `Error: tool "${name}" is not available to subagents. Use your read-only exploration tools.`;
        msgs.push({ role: 'tool', tool_name: name, content: String(result) });
      }
    }
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      if (stopRequested) throw err; // user hit STOP — unwind the whole run
      // timeout: fall through and salvage a report from what it saw
    } else {
      finalContent = finalContent || `Subagent failed: ${err.message}`;
    }
  }

  // scout ran out of steps/time while still exploring — force a report from what it saw
  if (!finalContent && !stopRequested) {
    try {
      msgs.push({
        role: 'user',
        content: 'Your tool budget is exhausted. Write your complete findings report NOW, using only what you have already seen. Cite file paths and line numbers. If parts of the task are unanswered, say which.',
      });
      // fresh 60s signal for the wrap-up: the main deadline may already be spent
      const wrapSignal = currentAbort
        ? AbortSignal.any([currentAbort.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000);
      const wrap = await streamChat(subModel, msgs, wrapSignal, useThink, true, numCtx, null);
      finalContent = wrap.content || '';
    } catch (err) {
      if (err.name === 'AbortError' && stopRequested) throw err;
      finalContent = finalContent || '(subagent timed out before writing a report)';
    }
  }

  const report = (finalContent || '(subagent finished without producing findings)').slice(0, SUBAGENT_REPORT_CAP);
  win.webContents.send('stream:subagent', { phase: 'done', report, steps });
  return `Subagent report (${subModel}, ${steps} tool calls):\n${report}`;
}

// ---------- goal loop (/loop) ----------
async function runVerifier(subModel, goal, summary, gitEvidence) {
  try {
    const think = (await supportsThinking(subModel)) ? false : undefined;
    const data = await ollamaJson('/api/chat', {
      model: subModel,
      stream: false,
      options: { num_ctx: 8192 },
      ...(think === undefined ? {} : { think }),
      messages: [
        {
          role: 'system',
          content: 'You are a strict completion verifier for a coding agent. Judge only from the evidence given. If the goal is FULLY achieved, reply with exactly: GOAL_COMPLETE. Otherwise reply with a short numbered list of the concrete steps that remain — no praise, no restating what was done. Never reply GOAL_COMPLETE if any part of the goal is unfinished or unverified.',
        },
        {
          role: 'user',
          content: `GOAL:\n${goal}\n\nAGENT'S FINAL MESSAGE THIS ITERATION:\n${(summary || '(none)').slice(0, 3000)}\n\nGIT CHANGES SO FAR (diff stat + status):\n${(gitEvidence || '(none)').slice(0, 2000)}`,
        },
      ],
    });
    recordUsage('verifier', { promptTokens: data.prompt_eval_count || 0, evalTokens: data.eval_count || 0 });
    return (data.message?.content || '').trim() || 'No verdict returned — continue working toward the goal.';
  } catch (err) {
    return `Verifier unavailable (${err.message}) — continue working toward the goal.`;
  }
}

ipcMain.handle('chat:loop', async (_e, { model, subModel, goal, cwd, autoApprove, think, maxIterations }) => {
  stopRequested = false;
  currentAbort = new AbortController();
  const max = Math.min(Math.max(parseInt(maxIterations, 10) || 8, 1), 25);
  const info = (t) => win.webContents.send('stream:info', t);
  const state = (t) => win.webContents.send('stream:state', t);

  try {
    let feedback = '';
    for (let i = 1; i <= max; i++) {
      if (stopRequested) break;
      info(`━ Loop iteration ${i}/${max} ━`);
      state(`loop ${i}/${max}`);

      conversation.push({
        role: 'user',
        content: i === 1
          ? `GOAL: ${goal}\n\nWork toward this goal. Use your tools, verify your work, and summarize what you accomplished when you stop.`
          : `GOAL: ${goal}\n\nVerifier feedback on your previous iteration:\n${feedback}\n\nAddress the feedback and continue toward the goal. Summarize what you accomplished when you stop.`,
      });

      const { lastContent, lastStats, contextLength } = await runAgentTurn(model, cwd, autoApprove, think, subModel);
      if (stopRequested) break;

      state(`verifying ${i}/${max} (${subModel || 'qwen3:8b'})…`);
      const diff = await gitRun(['diff', '--stat'], cwd);
      const status = await gitRun(['status', '--porcelain'], cwd);
      const verdict = await runVerifier(subModel || 'qwen3:8b', goal, lastContent, `${diff.out || ''}\n${status.out || ''}`.trim());
      if (stopRequested) break;

      if (/GOAL_COMPLETE/i.test(verdict)) {
        info(`✔ Verifier: goal complete after ${i} iteration${i > 1 ? 's' : ''}.`);
        break;
      }
      feedback = verdict.slice(0, 2000);
      info(`Verifier: not done yet —\n${feedback}`);
      if (i === max) {
        info(`Loop ended: reached the ${max}-iteration cap without GOAL_COMPLETE.`);
        break;
      }

      // auto-compact between iterations so long loops never hit silent truncation
      const used = lastStats ? lastStats.promptTokens + lastStats.evalTokens : 0;
      if (contextLength && used > 0.7 * contextLength) {
        info('Context past 70% — auto-compacting before the next iteration…');
        state('auto-compacting…');
        const c = await compactConversation(model);
        if (c.ok) {
          win.webContents.send('stream:stats', { contextTokens: c.approxTokens, contextLength: c.contextLength, tokPerSec: 0 });
        } else {
          info('Auto-compact failed (' + c.error + ') — continuing without it.');
        }
      }
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
  usage = freshUsage();
  return { ok: true };
});

ipcMain.handle('usage:get', () => usage);

// chat history support: the renderer saves/loads conversations, but the live
// array lives here — these let it read the current one and swap in a stored one.
ipcMain.handle('chat:get', () => conversation);

ipcMain.handle('chat:load', async (_e, msgs, model) => {
  conversation = Array.isArray(msgs) ? msgs : [];
  usage = freshUsage();
  // estimate the loaded context so the bar and /usage aren't blank until the
  // next message (Ollama reports the exact count on the next request)
  const approxTokens = Math.round(JSON.stringify(conversation).length / 4);
  const contextLength = model ? await effectiveContext(model) : 0;
  usage.context = { tokens: approxTokens, limit: contextLength };
  return { ok: true, approxTokens, contextLength };
});

// ---------- durable chat storage ----------
// One JSON file per chat in userData/chats/ plus a light index.json holding
// only sidebar metadata. Saves rewrite one chat's file, never the whole history.
function chatsDir() {
  return path.join(app.getPath('userData'), 'chats');
}

function safeChatId(id) {
  return String(id).replace(/[^\w.-]/g, '');
}

function readChatIndex() {
  try {
    return JSON.parse(fs.readFileSync(path.join(chatsDir(), 'index.json'), 'utf8'));
  } catch {
    return [];
  }
}

function writeChatIndex(list) {
  fs.mkdirSync(chatsDir(), { recursive: true });
  fs.writeFileSync(path.join(chatsDir(), 'index.json'), JSON.stringify(list, null, 2), 'utf8');
}

ipcMain.handle('history:list', () => readChatIndex());

ipcMain.handle('history:save', (_e, meta, convo) => {
  try {
    const id = safeChatId(meta.id);
    if (!id) return { ok: false, error: 'invalid chat id' };
    const entry = {
      id,
      title: meta.title || 'Chat',
      model: meta.model || '',
      cwd: meta.cwd || '',
      think: !!meta.think,
      autoApprove: !!meta.autoApprove,
      timestamp: meta.timestamp || new Date().toISOString(),
    };
    fs.mkdirSync(chatsDir(), { recursive: true });
    fs.writeFileSync(path.join(chatsDir(), id + '.json'), JSON.stringify({ ...entry, conversation: convo || [] }), 'utf8');
    const index = readChatIndex().filter((c) => c.id !== id);
    index.push(entry);
    writeChatIndex(index);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('history:load', (_e, id) => {
  try {
    const chat = JSON.parse(fs.readFileSync(path.join(chatsDir(), safeChatId(id) + '.json'), 'utf8'));
    return { ok: true, chat };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('history:delete', (_e, id) => {
  try { fs.unlinkSync(path.join(chatsDir(), safeChatId(id) + '.json')); } catch {}
  writeChatIndex(readChatIndex().filter((c) => c.id !== safeChatId(id)));
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

// ---------- git integration (gitRun lives in tools.js) ----------
ipcMain.handle('git:status', async (_e, cwd) => {
  // rev-parse fails on a freshly-initialized repo (no commits yet) —
  // symbolic-ref reports the unborn branch name, so try it as a fallback.
  let branch = await gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!branch.ok) branch = await gitRun(['symbolic-ref', '--short', 'HEAD'], cwd);
  if (!branch.ok) return { ok: false }; // not a git repo
  const status = await gitRun(['status', '--porcelain'], cwd);
  return {
    ok: true,
    branch: branch.out.trim(),
    changed: status.out.split('\n').filter(Boolean).length,
  };
});

ipcMain.handle('git:diff', async (_e, cwd) => {
  const staged = await gitRun(['diff', '--cached'], cwd);
  const unstaged = await gitRun(['diff'], cwd);
  const untracked = await gitRun(['ls-files', '--others', '--exclude-standard'], cwd);
  const parts = [];
  if (staged.out.trim()) parts.push('═══ STAGED ═══\n' + staged.out);
  if (unstaged.out.trim()) parts.push(unstaged.out);
  if (untracked.out.trim()) parts.push('═══ UNTRACKED FILES ═══\n' + untracked.out);
  return { ok: true, diff: parts.join('\n') || '(working tree clean)' };
});

ipcMain.handle('git:commit', async (_e, cwd, message) => {
  const add = await gitRun(['add', '-A'], cwd);
  if (!add.ok) return { ok: false, error: add.err || 'git add failed' };
  const commit = await gitRun(['commit', '-m', message], cwd);
  return commit.ok
    ? { ok: true, out: commit.out.trim().split('\n')[0] }
    : { ok: false, error: commit.err || commit.out.trim() || 'commit failed' };
});

// ---------- memory viewer ----------
ipcMain.handle('memory:get', () => ({ content: readMemory(), path: memoryPath() }));

// ---------- conversation compaction ----------
async function compactConversation(model) {
  if (conversation.length < 2) return { ok: false, error: 'Nothing to compact yet.' };
  try {
    // drop bulky tool outputs from what the summarizer sees
    const msgs = conversation.map((m) =>
      m.role === 'tool' && String(m.content).length > 1500
        ? { ...m, content: String(m.content).slice(0, 1500) + '…[truncated]' }
        : m
    );
    msgs.push({
      role: 'user',
      content: 'Summarize this entire conversation so work can continue seamlessly in a fresh session: the goal, key decisions, files created or modified and their current state, and unresolved tasks. Output only the summary.',
    });
    const data = await ollamaJson('/api/chat', {
      model,
      messages: msgs,
      stream: false,
      options: { num_ctx: await effectiveContext(model) },
    });
    const summary = (data.message?.content || '').trim();
    if (!summary) return { ok: false, error: 'Model returned an empty summary.' };
    conversation = [
      { role: 'user', content: 'This conversation was compacted to save context. Continue from the summary below.' },
      { role: 'assistant', content: 'Summary of the conversation so far:\n\n' + summary },
    ];
    // rough size of the compacted conversation so the UI can update its bar
    // (exact count comes from Ollama on the next real message)
    const approxTokens = Math.round(JSON.stringify(conversation).length / 4);
    return { ok: true, approxTokens, contextLength: await effectiveContext(model) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

ipcMain.handle('chat:compact', (_e, { model }) => compactConversation(model));

// ---------- chat export ----------
ipcMain.handle('chat:export', async () => {
  if (!conversation.length) return { ok: false, error: 'Nothing to export.' };
  const parts = [];
  for (const m of conversation) {
    if (m.role === 'user') {
      parts.push('## You\n\n' + m.content);
    } else if (m.role === 'assistant') {
      if (m.thinking) parts.push('<details><summary>Thinking</summary>\n\n' + m.thinking + '\n\n</details>');
      if (m.content) parts.push('## Model\n\n' + m.content);
      for (const tc of m.tool_calls || []) {
        parts.push('**Tool call:** `' + (tc.function?.name || '?') + '` — `' + JSON.stringify(tc.function?.arguments || {}).slice(0, 300) + '`');
      }
    } else if (m.role === 'tool') {
      parts.push('<details><summary>Tool result: ' + (m.tool_name || '') + '</summary>\n\n```\n' + String(m.content).slice(0, 4000) + '\n```\n\n</details>');
    }
  }
  const result = await dialog.showSaveDialog(win, {
    defaultPath: 'chat-' + new Date().toISOString().slice(0, 10) + '.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
  fs.writeFileSync(result.filePath, parts.join('\n\n') + '\n', 'utf8');
  return { ok: true, path: result.filePath };
});

ipcMain.handle('dir:exists', (_e, p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
});

ipcMain.handle('cwd:pick', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  return { ok: true, path: result.filePaths[0] };
});

// ---------- generate chat title ----------
ipcMain.handle('chat:generateTitle', async (_e, conversationContent) => {
  try {
    // If conversation is empty or invalid, return a default title
    if (!conversationContent || !Array.isArray(conversationContent)) {
      return { ok: false, error: 'Invalid conversation content' };
    }
    
    // Create a system prompt that strictly asks for a descriptive, concise title
    const systemPrompt = "You are a helpful chat summarizer. Given the following transcript of a programming chat, generate a single, descriptive, and concise title (maximum 7 words). Do not include any pre-text, explanation, or markdown formatting. Only output the title. Do not output any hashtags, markdown, or formatting. Just the plain text title. This is for generating a chat title only - do not output anything to the chat stream or UI. The only output should be the plain text title string.";
    
    // Get the last few messages to provide context for title generation
    const lastMessages = conversationContent.slice(-5); // Get last 5 messages for context
    
    // Generate the title using the LLM
    const response = await streamChat('qwen2.5-coder:1.5b', [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(lastMessages) }
    ], null, false, true);
    
    // Return only the title without any extra formatting
    let title = response.content.trim();
    
    // Clean up any markdown or formatting that might have slipped through
    title = title.replace(/[#*`]/g, '').trim();
    
    return { ok: true, title };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});