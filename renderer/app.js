// Brittain Code — UI logic.

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

  // One-time migration: chats used to live in localStorage; move them to disk.
  try {
    const legacy = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    if (legacy.length) {
      for (const c of legacy) {
        await window.api.historySave(
          { id: String(c.id), title: c.title, model: c.model || '', timestamp: c.timestamp || new Date().toISOString() },
          c.conversation || []
        );
      }
    }
    localStorage.removeItem('chatHistory');
  } catch {}

  // Load chat history
  loadChatHistory();
  
  // Show startup message on boot
  showStartupMessage();
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
  refreshGit();
}

// ---------- chat history ----------
async function loadChatHistory() {
  const chats = await window.api.historyList();
  chats.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // newest first
  chatList.innerHTML = '';

  if (chats.length === 0) {
    const noChats = document.createElement('div');
    noChats.className = 'no-chats';
    noChats.textContent = 'No chats yet';
    chatList.appendChild(noChats);
    return;
  }
  // group chats by project folder (newest group first; chats are already newest-first)
  const groups = new Map();
  for (const c of chats) {
    const key = c.cwd || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  for (const [dir, items] of groups) {
    const head = document.createElement('div');
    head.className = 'chat-group';
    head.textContent = dir ? dir.split('/').filter(Boolean).pop().toUpperCase() : 'NO FOLDER';
    head.title = dir || 'Chats saved before folders were tracked';
    chatList.appendChild(head);
    for (const c of items) renderChatItem(c);
  }
}

function renderChatItem(c) {
  {
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
    if (c.model) {
      const model = document.createElement('span');
      model.className = 'chat-model';
      model.textContent = c.model;
      main.appendChild(model);
    }

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

  const firstUser = conversation.find((m) => m.role === 'user');
  const title = firstUser
    ? firstUser.content.substring(0, 30) + (firstUser.content.length > 30 ? '...' : '')
    : 'Chat';

  if (!currentChatId) currentChatId = Date.now().toString();
  const res = await window.api.historySave(
    {
      id: currentChatId,
      title,
      model: modelSelect.value,
      cwd: cwd || '',
      think: thinkToggle.checked,
      autoApprove: autoApprove.checked,
      timestamp: new Date().toISOString(),
    },
    conversation
  );
  if (!res.ok) addError('Failed to save chat: ' + res.error);
  loadChatHistory();
}

async function loadChat(chatId) {
  if (busy) return;
  const res = await window.api.historyLoad(chatId);
  if (!res.ok) return addError('Could not load chat: ' + res.error);
  const saved = res.chat;

  // Push the stored conversation into the main process so the model continues from it.
  await window.api.loadConversation(saved.conversation);
  renderConversation(saved.conversation);
  hideStartupMessage();
  currentChatId = chatId;

  // Auto-select the model this chat was using; if it's gone from Ollama, keep the current one.
  if (saved.model && [...modelSelect.options].some((o) => o.value === saved.model)) {
    modelSelect.value = saved.model;
    localStorage.setItem('model', saved.model);
  }

  // Restore the working directory this chat was using, if it still exists.
  if (saved.cwd && saved.cwd !== cwd) {
    if (await window.api.dirExists(saved.cwd)) {
      setCwd(saved.cwd);
    } else {
      addError(`This chat used ${saved.cwd}, which no longer exists — DIR left unchanged.`);
    }
  }

  // Restore this chat's toggle states (older chats without them are left as-is).
  if ('think' in saved) {
    thinkToggle.checked = !!saved.think;
    localStorage.setItem('think', saved.think ? '1' : '0');
  }
  if ('autoApprove' in saved) {
    autoApprove.checked = !!saved.autoApprove;
    localStorage.setItem('autoApprove', saved.autoApprove ? '1' : '0');
  }

  loadChatHistory(); // refresh active highlight
}

async function deleteChat(chatId) {
  await window.api.historyDelete(chatId);
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
      const imgs = (msg.images || []).map((b) => 'data:image/png;base64,' + b);
      addMessage('user', msg.content || (imgs.length ? '(image)' : ''), imgs);
    } else if (msg.role === 'assistant') {
      if (msg.thinking) addThinkingBlock(msg.thinking, 'THOUGHTS ▸');
      if (msg.content) renderMarkdown(addMessage('assistant', ''), msg.content);
    } else if (msg.role === 'tool') {
      const text = String(msg.content);
      addMessage('tool', `[${msg.tool_name}] ` + (text.length > 300 ? text.slice(0, 300) + '…' : text));
    }
  }
}

// ---------- image attachments ----------
let pendingImages = []; // data URLs awaiting send

$('img-btn').addEventListener('click', () => $('img-file').click());

$('img-file').addEventListener('change', (e) => {
  for (const f of e.target.files) addImage(f);
  e.target.value = '';
});

input.addEventListener('paste', (e) => {
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      addImage(item.getAsFile());
    }
  }
});

function addImage(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImages.push(reader.result);
    renderImagePreview();
  };
  reader.readAsDataURL(file);
}

function renderImagePreview() {
  const strip = $('img-preview');
  strip.innerHTML = '';
  strip.classList.toggle('hidden', !pendingImages.length);
  pendingImages.forEach((src, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'img-thumb';
    const img = document.createElement('img');
    img.src = src;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Remove image';
    x.addEventListener('click', () => {
      pendingImages.splice(i, 1);
      renderImagePreview();
    });
    wrap.appendChild(img);
    wrap.appendChild(x);
    strip.appendChild(wrap);
  });
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
  if ((!text && !pendingImages.length) || busy) return;
  if (text.startsWith('/')) {
    input.value = '';
    return handleSlash(text);
  }
  if (!modelSelect.value) return addError('No model selected — is Ollama running?');
  if (!cwd) return addError('Pick a working directory first (DIR button, top left).');

  // Ollama wants raw base64 without the data-URL prefix
  const images = pendingImages.map((d) => d.split(',')[1]);
  const shownImages = pendingImages;
  pendingImages = [];
  renderImagePreview();

  input.value = '';
  hideStartupMessage();
  addMessage('user', text || '(image)', shownImages);
  startRun();

  const res = await window.api.send({
    model: modelSelect.value,
    text,
    cwd,
    autoApprove: autoApprove.checked,
    think: thinkToggle.checked,
    images,
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
  finalizeAssistant();
  setState('idle');
  clearInterval(elapsedTimer);
  refreshGit(); // the run may have changed files
}

function setState(s) {
  const el = $('status-state');
  el.textContent = s;
  el.classList.toggle('working', s !== 'idle');
}

// ---------- message rendering ----------
let currentAssistant = null; // the <div> receiving streamed tokens

// Render markdown safely. Falls back to plain text if the libs failed to load.
function renderMarkdown(el, text) {
  if (window.marked && window.DOMPurify) {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }));
    el.classList.add('md'); // switches white-space handling from pre-wrap to normal
  } else {
    el.textContent = text;
  }
}

// Convert the streaming assistant bubble from plain text to rendered markdown.
function finalizeAssistant() {
  if (!currentAssistant) return;
  renderMarkdown(currentAssistant, currentAssistant.textContent);
  currentAssistant = null;
}

function addMessage(role, text, images) {
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
  if (images && images.length) {
    const strip = document.createElement('div');
    strip.className = 'msg-images';
    for (const src of images) {
      const img = document.createElement('img');
      img.src = src;
      strip.appendChild(img);
    }
    div.appendChild(strip);
  }
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

function addInfo(text) {
  const div = document.createElement('div');
  div.className = 'msg info';
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

// The fallback tool-call parser recovered calls from raw markup that already
// streamed into the current bubble — swap in the cleaned text (or drop the bubble).
window.api.onCleanContent((text) => {
  if (!currentAssistant) return;
  if (text) {
    currentAssistant.textContent = text;
  } else {
    currentAssistant.closest('.msg')?.remove();
    currentAssistant = null;
  }
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
  finalizeAssistant(); // markdown-render the finished bubble; next tokens start a fresh one
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

window.api.onStats(({ contextTokens, contextLength, tokPerSec }) => {
  $('ctx-tokens').textContent = contextTokens.toLocaleString();
  $('ctx-limit').textContent = contextLength.toLocaleString();
  if (tokPerSec) $('tok-speed').textContent = tokPerSec.toFixed(1) + ' t/s';
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
  if (args.questions) {
    const first = String(args.questions[0]?.question || '');
    const extra = args.questions.length > 1 ? ` (+${args.questions.length - 1} more)` : '';
    return (first.length > 50 ? first.slice(0, 50) + '…' : first) + extra;
  }
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
    : name === 'edit_file' ? `${args.path}\n\n- ${String(args.old_string || '').slice(0, 300)}\n+ ${String(args.new_string || '').slice(0, 300)}`
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
let questionAnswers = [];

window.api.onQuestionRequest(({ id, questions }) => {
  pendingQuestionId = id;
  questionAnswers = new Array(questions.length).fill(null);
  const single = questions.length === 1;

  const cards = $('question-cards');
  cards.innerHTML = '';

  questions.forEach((q, i) => {
    const card = document.createElement('div');
    card.className = 'q-card';

    const txt = document.createElement('div');
    txt.className = 'question-text';
    txt.textContent = q.question;
    card.appendChild(txt);

    const opts = document.createElement('div');
    opts.className = 'q-options';
    const inp = document.createElement('input');

    for (const o of q.options || []) {
      const b = document.createElement('button');
      b.textContent = o;
      b.addEventListener('click', () => {
        if (single) return submitAnswers([o]); // one question: option click answers immediately
        questionAnswers[i] = o;
        opts.querySelectorAll('button').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
        inp.value = '';
        updateSubmit();
      });
      opts.appendChild(b);
    }
    card.appendChild(opts);

    inp.className = 'q-input';
    inp.placeholder = 'Or type your own answer...';
    inp.addEventListener('input', () => {
      const v = inp.value.trim();
      questionAnswers[i] = v || null;
      if (v) opts.querySelectorAll('button').forEach((x) => x.classList.remove('selected'));
      updateSubmit();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && questionAnswers.every((a) => a)) submitAnswers(questionAnswers);
    });
    card.appendChild(inp);
    cards.appendChild(card);
  });

  updateSubmit();
  $('question-bar').classList.remove('hidden');
  setState('awaiting answer');
});

function updateSubmit() {
  $('question-submit').disabled = !questionAnswers.every((a) => a);
}

function submitAnswers(answers) {
  if (pendingQuestionId === null) return;
  window.api.respondQuestion(pendingQuestionId, answers);
  pendingQuestionId = null;
  hideQuestion();
  setState('working');
}

$('question-submit').addEventListener('click', () => {
  if (questionAnswers.every((a) => a)) submitAnswers(questionAnswers);
});

function hideQuestion() {
  $('question-bar').classList.add('hidden');
  pendingQuestionId = null;
}

// Array of startup messages
const startupMessages = [
  "Welcome to Brittain Code!",
  "Ready to help with your coding tasks",
  "Start by describing what you'd like to build",
  "Ask me anything about programming",
  "Happy to assist with your development",
  "Let's get coding!",
  "Your AI coding assistant is here",
  "Ask questions, get answers, build amazing things"
];

// Show a random startup message
let startupHideTimer = null;

function showStartupMessage() {
  const contentElement = $('startup-message-content');
  contentElement.innerHTML = '';

  const randomMessage = startupMessages[Math.floor(Math.random() * startupMessages.length)];
  const p = document.createElement('p');
  p.textContent = randomMessage;
  contentElement.appendChild(p);

  $('startup-message').classList.remove('hidden');

  // Auto-hide after 10 seconds; reset the timer if a new message replaced this one
  clearTimeout(startupHideTimer);
  startupHideTimer = setTimeout(hideStartupMessage, 10000);
}

function hideStartupMessage() {
  clearTimeout(startupHideTimer);
  $('startup-message').classList.add('hidden');
}

// ---------- event listeners ----------
$('history-btn').addEventListener('click', () => {
  sidebar.classList.toggle('hidden');
});

async function newSession() {
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
  showStartupMessage();
}

$('new-btn').addEventListener('click', newSession);

// ---------- slash commands ----------
const SLASH_HELP = [
  '/help — show this list',
  '/clear — start a new session',
  '/compact — summarize the conversation to free up context',
  '/diff — show the git diff for the working directory',
  '/commit <message> — stage all changes and commit',
  '/model <name> — switch model (partial match ok)',
  '/memory — view what the agent has remembered',
  '/export — save this chat as a markdown file',
].join('\n');

async function handleSlash(raw) {
  const [cmd, ...rest] = raw.slice(1).split(' ');
  const arg = rest.join(' ').trim();

  switch (cmd.toLowerCase()) {
    case 'help':
      return addInfo(SLASH_HELP);

    case 'clear':
      return newSession();

    case 'compact': {
      if (busy) return;
      if (!modelSelect.value) return addError('No model selected.');
      busy = true;
      setState('compacting…');
      const res = await window.api.compact({ model: modelSelect.value });
      busy = false;
      setState('idle');
      if (!res.ok) return addError('Compact failed: ' + res.error);
      renderConversation(await window.api.getConversation());
      addInfo('Conversation compacted — context freed. The model will continue from the summary above.');
      return saveChat();
    }

    case 'diff':
      return showDiff();

    case 'commit': {
      if (!cwd) return addError('No directory set.');
      if (!arg) return addError('Usage: /commit <message>');
      const res = await window.api.gitCommit(cwd, arg);
      res.ok ? addInfo(res.out) : addError(res.error);
      return refreshGit();
    }

    case 'model': {
      if (!arg) return addError('Usage: /model <name>');
      const match = [...modelSelect.options].map((o) => o.value).find((v) => v.includes(arg));
      if (!match) return addError(`No installed model matching "${arg}".`);
      modelSelect.value = match;
      localStorage.setItem('model', match);
      return addInfo('Model set to ' + match);
    }

    case 'memory': {
      const res = await window.api.memoryGet();
      return showOverlay('MEMORY — ' + res.path, res.content.trim() || '(nothing remembered yet — the agent saves lessons here with the remember tool)');
    }

    case 'export': {
      const res = await window.api.exportChat();
      if (res.ok) return addInfo('Exported to ' + res.path);
      if (res.error !== 'cancelled') return addError(res.error);
      return;
    }

    default:
      return addError('Unknown command: /' + cmd + ' — try /help');
  }
}

// ---------- git ----------
async function refreshGit() {
  const info = $('git-info');
  if (!cwd) return info.classList.add('hidden');
  const res = await window.api.gitStatus(cwd);
  if (!res.ok) return info.classList.add('hidden');
  $('git-branch').textContent = res.branch + (res.changed ? ' ±' + res.changed : ' ✓');
  info.classList.remove('hidden');
}

async function showDiff() {
  if (!cwd) return addError('No directory set.');
  const res = await window.api.gitDiff(cwd);
  showOverlay('GIT DIFF — ' + cwd, res.diff, { diff: true });
}

$('diff-btn').addEventListener('click', showDiff);
$('commit-btn').addEventListener('click', () => {
  input.value = '/commit ';
  input.focus();
});

// ---------- overlay ----------
function showOverlay(title, text, opts = {}) {
  $('overlay-title').textContent = title;
  const body = $('overlay-body');
  if (opts.diff) {
    body.innerHTML = '';
    for (const line of text.split('\n')) {
      const div = document.createElement('div');
      div.textContent = line || ' ';
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) div.className = 'diff-file';
      else if (line.startsWith('+')) div.className = 'diff-add';
      else if (line.startsWith('-')) div.className = 'diff-del';
      else if (line.startsWith('@@')) div.className = 'diff-hunk';
      body.appendChild(div);
    }
  } else {
    body.textContent = text;
  }
  $('overlay').classList.remove('hidden');
}

function hideOverlay() {
  $('overlay').classList.add('hidden');
}

$('overlay-close').addEventListener('click', hideOverlay);
$('overlay').addEventListener('click', (e) => {
  if (e.target.id === 'overlay') hideOverlay();
});

// ---------- keyboard shortcuts ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('overlay').classList.contains('hidden')) hideOverlay();
    else if (busy) window.api.stop();
  }
});