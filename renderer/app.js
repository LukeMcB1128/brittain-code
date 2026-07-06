// Local Code — UI logic.

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const input = $('input');
const sendBtn = $('send-btn');
const stopBtn = $('stop-btn');
const modelSelect = $('model-select');
const autoApprove = $('auto-approve');
const chatList = $('chat-list');
const sidebar = $('sidebar');
const thinkToggle = $('think-toggle');

let cwd = null;
let busy = false;
let elapsedTimer = null;
let toolCount = 0;
let currentChatId = null;

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

  thinkToggle.checked = localStorage.getItem('think') === '1';
  autoApprove.checked = localStorage.getItem('autoApprove') === '1';

  // Load chat history
  loadChatHistory();
})();

thinkToggle.addEventListener('change', () => localStorage.setItem('think', thinkToggle.checked ? '1' : '0'));
autoApprove.addEventListener('change', () => localStorage.setItem('autoApprove', autoApprove.checked ? '1' : '0'));

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

// ---------- chat history ----------
function loadChatHistory() {
  const chats = JSON.parse(localStorage.getItem('chatHistory') || '[]');
  chatList.innerHTML = '';

  if (chats.length === 0) {
    const noChats = document.createElement('div');
    noChats.className = 'no-chats';
    noChats.textContent = 'No chats yet';
    chatList.appendChild(noChats);
    return;
  }
  // newest first
  for (const c of chats.slice().reverse()) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === currentChatId ? ' active' : '');

    const main = document.createElement('div');
    main.className = 'chat-item-main';
    const title = document.createElement('span');
    title.className = 'chat-title';
    title.textContent = c.title || `Chat ${c.id.substring(0, 8)}`;
    const date = document.createElement('span');
    date.className = 'chat-date';
    date.textContent = new Date(c.timestamp).toLocaleString();
    main.appendChild(title);
    main.appendChild(date);

    const del = document.createElement('button');
    del.className = 'chat-del';
    del.textContent = '✕';
    del.title = 'Delete this chat';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Delete this chat?')) deleteChat(c.id);
    });

    item.addEventListener('click', () => loadChat(c.id));
    item.appendChild(main);
    item.appendChild(del);
    chatList.appendChild(item);
  }
}

async function saveChat() {
  // The live conversation lives in the main process — pull it over IPC.
  const conversation = await window.api.getConversation();
  if (!conversation.length) return;

  const chats = JSON.parse(localStorage.getItem('chatHistory') || '[]');
  const firstUser = conversation.find((m) => m.role === 'user');
  const title = firstUser
    ? firstUser.content.substring(0, 30) + (firstUser.content.length > 30 ? '...' : '')
    : 'Chat';

  // Update the current chat in place; only create a new entry for a new session.
  if (!currentChatId) currentChatId = Date.now().toString();
  const existing = chats.find((c) => c.id === currentChatId);
  if (existing) {
    existing.conversation = conversation;
    existing.timestamp = new Date().toISOString();
  } else {
    chats.push({
      id: currentChatId,
      title,
      timestamp: new Date().toISOString(),
      conversation,
    });
  }

  localStorage.setItem('chatHistory', JSON.stringify(chats));
  loadChatHistory();
}

async function loadChat(chatId) {
  if (busy) return;
  const chats = JSON.parse(localStorage.getItem('chatHistory') || '[]');
  const saved = chats.find((c) => c.id === chatId);
  if (!saved) return;

  // Push the stored conversation into the main process so the model continues from it.
  await window.api.loadConversation(saved.conversation);
  renderConversation(saved.conversation);
  currentChatId = chatId;
  loadChatHistory(); // refresh active highlight
}

async function deleteChat(chatId) {
  const chats = JSON.parse(localStorage.getItem('chatHistory') || '[]');
  const updatedChats = chats.filter(c => c.id !== chatId);
  localStorage.setItem('chatHistory', JSON.stringify(updatedChats));
  loadChatHistory();

  // If we deleted the currently loaded chat, clear the conversation everywhere
  if (currentChatId === chatId) {
    await window.api.reset();
    currentChatId = null;
    chat.innerHTML = '';
    toolCount = 0;
    $('tool-count').textContent = '0';
    $('ctx-tokens').textContent = '0';
    $('ctx-fill').style.width = '0%';
    setState('idle');
  }
}

function renderConversation(conversation) {
  chat.innerHTML = '';
  for (const msg of conversation) {
    if (msg.role === 'user') {
      addMessage('user', msg.content);
    } else if (msg.role === 'assistant') {
      if (msg.thinking) addThinkingBlock(msg.thinking, 'THOUGHTS ▸');
      if (msg.content) addMessage('assistant', msg.content);
    } else if (msg.role === 'tool') {
      const text = String(msg.content);
      addMessage('tool', `[${msg.tool_name}] ` + (text.length > 300 ? text.slice(0, 300) + '…' : text));
    }
  }
}

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
    think: thinkToggle.checked,
  });

  if (!res.ok) addError(res.error);
  endRun();
  
  // Save the chat after each message
  saveChat();
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
  hideQuestion();
  finalizeThinking();
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
  label.textContent = role === 'user' ? 'YOU' : role === 'assistant' ? 'MODEL' : 'TOOL';
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

// ---------- thinking display ----------
let currentThinking = null; // { pre, head, wrap, start }

function addThinkingBlock(text, label) {
  const wrap = document.createElement('div');
  wrap.className = 'thinking collapsed';
  const head = document.createElement('div');
  head.className = 'thinking-head';
  head.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = text;
  head.addEventListener('click', () => wrap.classList.toggle('collapsed'));
  wrap.appendChild(head);
  wrap.appendChild(pre);
  chat.appendChild(wrap);
  return { wrap, head, pre };
}

function finalizeThinking() {
  if (!currentThinking) return;
  const secs = ((Date.now() - currentThinking.start) / 1000).toFixed(1);
  currentThinking.head.textContent = `THOUGHT FOR ${secs}S ▸`;
  currentThinking.wrap.classList.remove('live');
  currentThinking = null;
}

window.api.onThinking((t) => {
  if (!currentThinking) {
    const block = addThinkingBlock('', 'THINKING… ▸');
    block.wrap.classList.add('live');
    currentThinking = { ...block, start: Date.now() };
  }
  currentThinking.pre.textContent += t;
  scrollDown();
});

// ---------- stream events ----------
window.api.onToken((t) => {
  finalizeThinking();
  if (!currentAssistant) currentAssistant = addMessage('assistant', '');
  currentAssistant.textContent += t;
  scrollDown();
});

window.api.onToolCall(({ name, args }) => {
  finalizeThinking();
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
  head.addEventListener('click', () => {
    if (card.classList.contains('has-result')) card.classList.toggle('collapsed');
  });
  card.appendChild(head);
  chat.appendChild(card);
  lastToolCard = card;
  scrollDown();
});

let lastToolCard = null;

window.api.onToolResult(({ result, denied }) => {
  setState('working');
  if (!lastToolCard) return;
  lastToolCard.classList.add(denied ? 'denied' : 'ok', 'has-result');
  lastToolCard.querySelector('.status').textContent = denied ? 'denied' : 'done';
  const pre = document.createElement('pre');
  pre.textContent = result;
  lastToolCard.appendChild(pre);
  // collapse successful results; leave failures visible
  const looksBad = denied || /error|traceback|exception|failed|timed out|not found|denied/i.test(String(result).slice(0, 300));
  if (!looksBad) lastToolCard.classList.add('collapsed');
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
  if (args.question) return args.question.length > 60 ? args.question.slice(0, 60) + '…' : args.question;
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

// ---------- questions (ask_user tool) ----------
let pendingQuestionId = null;

window.api.onQuestionRequest(({ id, question, options }) => {
  pendingQuestionId = id;
  $('question-text').textContent = question;
  const optsDiv = $('question-options');
  optsDiv.innerHTML = '';
  for (const o of options || []) {
    const b = document.createElement('button');
    b.textContent = o;
    b.addEventListener('click', () => answerQuestion(o));
    optsDiv.appendChild(b);
  }
  $('question-input').value = '';
  $('question-bar').classList.remove('hidden');
  setState('awaiting answer');
  $('question-input').focus();
});

function answerQuestion(text) {
  if (pendingQuestionId === null) return;
  window.api.respondQuestion(pendingQuestionId, text);
  pendingQuestionId = null;
  hideQuestion();
  setState('working');
}

function hideQuestion() {
  $('question-bar').classList.add('hidden');
  pendingQuestionId = null;
}

$('question-send').addEventListener('click', () => {
  const v = $('question-input').value.trim();
  if (v) answerQuestion(v);
});

$('question-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = $('question-input').value.trim();
    if (v) answerQuestion(v);
  }
});

// ---------- event listeners ----------
$('history-btn').addEventListener('click', () => {
  sidebar.classList.toggle('hidden');
});

$('new-btn').addEventListener('click', async () => {
  if (busy) return;
  await window.api.reset();
  chat.innerHTML = '';
  toolCount = 0;
  $('tool-count').textContent = '0';
  $('ctx-tokens').textContent = '0';
  $('ctx-fill').style.width = '0%';
  setState('idle');
  currentChatId = null;
  loadChatHistory(); // clear active highlight
});