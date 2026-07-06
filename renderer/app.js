// Local Code — UI logic.

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const input = $('input');
const sendBtn = $('send-btn');
const stopBtn = $('stop-btn');
const modelSelect = $('model-select');
const autoApprove = $('auto-approve');

let cwd = null;
let busy = false;
let elapsedTimer = null;
let toolCount = 0;

// ---------- boot ----------
(async function boot() {
  const res = await window.api.listModels();
  if (!res.ok) {
    addError(res.error);
    return;
  }
  for (const name of res.models) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    modelSelect.appendChild(opt);
  }
  const saved = localStorage.getItem('model');
  if (saved && res.models.includes(saved)) modelSelect.value = saved;

  const savedCwd = localStorage.getItem('cwd');
  if (savedCwd) setCwd(savedCwd);
})();

modelSelect.addEventListener('change', () => localStorage.setItem('model', modelSelect.value));

$('cwd-btn').addEventListener('click', async () => {
  const res = await window.api.pickCwd();
  if (res.ok) setCwd(res.path);
});

function setCwd(p) {
  cwd = p;
  localStorage.setItem('cwd', p);
  const parts = p.split('/');
  $('cwd-label').textContent = parts.slice(-2).join('/') || p;
  $('cwd-btn').title = p;
}

$('new-btn').addEventListener('click', async () => {
  if (busy) return;
  await window.api.reset();
  chat.innerHTML = '';
  toolCount = 0;
  $('tool-count').textContent = '0';
  $('ctx-tokens').textContent = '0';
  $('ctx-fill').style.width = '0%';
  setState('idle');
});

// ---------- sending ----------
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
sendBtn.addEventListener('click', send);
stopBtn.addEventListener('click', () => window.api.stop());

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  if (!modelSelect.value) return addError('No model selected — is Ollama running?');
  if (!cwd) return addError('Pick a working directory first (DIR button, top left).');

  input.value = '';
  addMessage('user', text);
  startRun();

  const res = await window.api.send({
    model: modelSelect.value,
    text,
    cwd,
    autoApprove: autoApprove.checked,
  });

  if (!res.ok) addError(res.error);
  endRun();
}

function startRun() {
  busy = true;
  sendBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  setState('working');
  const start = Date.now();
  elapsedTimer = setInterval(() => {
    $('elapsed').textContent = ((Date.now() - start) / 1000).toFixed(1) + 's';
  }, 100);
}

function endRun() {
  busy = false;
  sendBtn.classList.remove('hidden');
  stopBtn.classList.add('hidden');
  hideApproval();
  setState('idle');
  clearInterval(elapsedTimer);
  currentAssistant = null;
}

function setState(s) {
  const el = $('status-state');
  el.textContent = s;
  el.classList.toggle('working', s !== 'idle');
}

// ---------- message rendering ----------
let currentAssistant = null; // the <div> receiving streamed tokens

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = role === 'user' ? 'YOU' : 'MODEL';
  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = text;
  div.appendChild(label);
  div.appendChild(body);
  chat.appendChild(div);
  scrollDown();
  return body;
}

function addError(text) {
  const div = document.createElement('div');
  div.className = 'msg error';
  div.textContent = text;
  chat.appendChild(div);
  scrollDown();
}

function scrollDown() {
  chat.scrollTop = chat.scrollHeight;
}

// ---------- stream events ----------
window.api.onToken((t) => {
  if (!currentAssistant) currentAssistant = addMessage('assistant', '');
  currentAssistant.textContent += t;
  scrollDown();
});

window.api.onToolCall(({ name, args }) => {
  currentAssistant = null; // next tokens start a fresh assistant bubble
  toolCount++;
  $('tool-count').textContent = String(toolCount);
  setState('tool: ' + name);

  const card = document.createElement('div');
  card.className = 'tool';
  card.dataset.tool = name;
  const head = document.createElement('div');
  head.className = 'tool-head';
  head.innerHTML = `<span>${name}</span><span class="args"></span><span class="status">running…</span>`;
  head.querySelector('.args').textContent = shortArgs(name, args);
  card.appendChild(head);
  chat.appendChild(card);
  lastToolCard = card;
  scrollDown();
});

let lastToolCard = null;

window.api.onToolResult(({ result, denied }) => {
  setState('working');
  if (!lastToolCard) return;
  lastToolCard.classList.add(denied ? 'denied' : 'ok');
  lastToolCard.querySelector('.status').textContent = denied ? 'denied' : 'done';
  const pre = document.createElement('pre');
  pre.textContent = result;
  lastToolCard.appendChild(pre);
  scrollDown();
});

window.api.onStats(({ contextTokens, contextLength }) => {
  $('ctx-tokens').textContent = contextTokens.toLocaleString();
  $('ctx-limit').textContent = contextLength.toLocaleString();
  const pct = Math.min(100, (contextTokens / contextLength) * 100);
  const fill = $('ctx-fill');
  fill.style.width = pct + '%';
  fill.className = pct > 90 ? 'danger' : pct > 70 ? 'warn' : '';
  fill.id = 'ctx-fill';
});

window.api.onDone(() => {
  if (busy) setState('idle');
});

function shortArgs(name, args) {
  if (args.source) return args.source + ' → ' + args.destination;
  if (args.path) return args.path;
  if (args.command) return args.command.length > 60 ? args.command.slice(0, 60) + '…' : args.command;
  if (args.pattern) return '"' + args.pattern + '"';
  return '';
}

// ---------- approvals ----------
let pendingApprovalId = null;

window.api.onApprovalRequest(({ id, name, args }) => {
  pendingApprovalId = id;
  $('approval-tool').textContent = 'APPROVE ' + name.toUpperCase() + '?';
  $('approval-detail').textContent =
    name === 'run_command' ? args.command
    : name === 'write_file' || name === 'append_file' ? `${args.path}\n\n${(args.content || '').slice(0, 600)}`
    : name === 'replace_in_file' ? `${args.path}\n\nfind: ${args.pattern}\nreplace: ${args.replacement}`
    : args.source ? `${args.source} → ${args.destination}`
    : String(args.path || JSON.stringify(args));
  $('approval-bar').classList.remove('hidden');
  setState('awaiting approval');
});

$('approve-btn').addEventListener('click', () => respond(true));
$('deny-btn').addEventListener('click', () => respond(false));

function respond(approved) {
  if (pendingApprovalId === null) return;
  window.api.respondApproval(pendingApprovalId, approved);
  pendingApprovalId = null;
  hideApproval();
  setState('working');
}

function hideApproval() {
  $('approval-bar').classList.add('hidden');
  pendingApprovalId = null;
}
