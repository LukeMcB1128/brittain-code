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
const onlineResearchToggle = $('online-research');
const autoBranchToggle = $('auto-branch');
const reviewToggle = $('review-mode');
const undoBtn = $('undo-btn');
const codeModeBtn = $('mode-code');
const chatModeBtn = $('mode-chat');

let cwd = null;
let appMode = localStorage.getItem('appMode') === 'chat' ? 'chat' : 'code';
let busy = false;
let subModel = localStorage.getItem('subModel') || 'qwen3:8b'; // set via /subagent
let coderModel = localStorage.getItem('coderModel') || 'qwen3-coder:30b'; // set via /coder
let elapsedTimer = null;
let toolCount = 0;
let currentChatId = null;

setAppMode(appMode, false, false);

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

  // Display version number
  try {
    const version = await window.api.getVersion();
    $('version-display').textContent = version;
    $('version-display').classList.remove('hidden');
  } catch (e) {
    console.error('Failed to load version:', e);
  }

  // subagent model: validate the saved choice against what's installed
  if (!res.models.includes(subModel)) {
    subModel = res.models.includes('qwen3:8b') ? 'qwen3:8b' : res.models[0] || '';
  }
  // Prefer the coding-specialized model, then gpt-oss as a capable local
  // fallback once installed, then whichever subagent model is available.
  if (!res.models.includes(coderModel)) {
    coderModel = res.models.includes('qwen3-coder:30b')
      ? 'qwen3-coder:30b'
      : res.models.includes('gpt-oss:20b')
        ? 'gpt-oss:20b'
        : subModel || res.models[0] || '';
    localStorage.setItem('coderModel', coderModel);
  }

  // tag the dev channel (npm start) so it's never mistaken for the installed app
  if (await window.api.isDev()) {
    const tag = document.createElement('span');
    tag.className = 'dev-tag';
    tag.textContent = 'DEV';
    tag.title = 'Running live source via npm start — not the installed app';
    document.querySelector('.brand').appendChild(tag);
  }

  const savedCwd = localStorage.getItem('cwd');
  if (savedCwd) setCwd(savedCwd);

  thinkToggle.checked = localStorage.getItem('think') === '1';
  autoApprove.checked = localStorage.getItem('autoApprove') === '1';
  autoBranchToggle.checked = localStorage.getItem('autoBranch') === '1';
  reviewToggle.checked = localStorage.getItem('reviewMode') === '1';
  onlineResearchToggle.checked = false; // privacy boundary: never restore online access implicitly

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
autoBranchToggle.addEventListener('change', () => localStorage.setItem('autoBranch', autoBranchToggle.checked ? '1' : '0'));
reviewToggle.addEventListener('change', () => localStorage.setItem('reviewMode', reviewToggle.checked ? '1' : '0'));
onlineResearchToggle.addEventListener('change', () => {
  if (!onlineResearchToggle.checked) return;
  const approved = confirm(
    'Enable ONLINE RESEARCH for this session?\n\nSearch queries and requested page URLs will leave this Mac. Every web_search and web_fetch call will still require explicit approval, even when AUTO-APPROVE is on.'
  );
  if (!approved) onlineResearchToggle.checked = false;
});

modelSelect.addEventListener('change', () => localStorage.setItem('model', modelSelect.value));
codeModeBtn.addEventListener('click', () => chooseAppMode('code'));
chatModeBtn.addEventListener('click', () => chooseAppMode('chat'));

function setAppMode(mode, persist = true, refreshHistory = true) {
  appMode = mode === 'chat' ? 'chat' : 'code';
  document.body.dataset.mode = appMode;
  codeModeBtn.classList.toggle('active', appMode === 'code');
  chatModeBtn.classList.toggle('active', appMode === 'chat');
  codeModeBtn.setAttribute('aria-pressed', appMode === 'code' ? 'true' : 'false');
  chatModeBtn.setAttribute('aria-pressed', appMode === 'chat' ? 'true' : 'false');
  $('composer-mode').textContent = appMode.toUpperCase();
  $('sidebar-head').textContent = appMode === 'chat' ? 'CHAT HISTORY' : 'CODE HISTORY';
  $('composer-context').textContent = appMode === 'chat'
    ? 'No folder access. Enable RESEARCH when you want to search the web.'
    : 'Project tools are restricted to the selected directory.';
  input.placeholder = appMode === 'chat'
    ? 'Ask anything... (Enter to send, Shift+Enter for newline)'
    : 'Describe a task... (Enter to send, Shift+Enter for newline)';
  if (persist) localStorage.setItem('appMode', appMode);
  refreshGit();
  if (refreshHistory) loadChatHistory();
}

async function chooseAppMode(mode) {
  if (busy || mode === appMode) return;
  const conversation = await window.api.getConversation();
  if (conversation.length && !confirm(`Switch to ${mode.toUpperCase()} and start a new session?\n\nYour current chat is already saved in History.`)) return;
  setAppMode(mode);
  if (conversation.length) await newSession();
  else showStartupMessage();
}

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
  undoBtn.disabled = true; // checkpoints are per-folder; a new DIR has none yet
  refreshGit();
}

// ---------- run checkpoints / UNDO ----------
window.api.onCheckpointState(({ available, cwd: ckptCwd }) => {
  if (available && ckptCwd === cwd) undoBtn.disabled = false;
});

undoBtn.addEventListener('click', async () => {
  if (busy || undoBtn.disabled) return;
  if (!confirm('Restore all files in this folder to the checkpoint taken before the last run?\n\n(The current state is checkpointed first — press UNDO again to re-apply the run.)')) return;
  const res = await window.api.undoCheckpoint(cwd);
  if (res.ok) {
    addInfo(`UNDO: restored working tree to the ${res.restoredFrom} checkpoint (was: ${res.changes}). A pre-undo checkpoint was saved — UNDO again to swap back.`);
  } else {
    addError('Undo failed: ' + res.error);
  }
  refreshGit();
});

// ---------- REVIEW mode: keep/discard a run ----------
window.api.onRunReport(({ cwd: runCwd, mutations }) => {
  if (!reviewToggle.checked || !mutations || runCwd !== cwd) return;
  $('review-detail').textContent = `${mutations} file${mutations === 1 ? '' : 's'} changed — keep this run's changes, or discard to restore the pre-run checkpoint.`;
  $('review-bar').classList.remove('hidden');
  setState('awaiting review');
});

function hideReview() {
  $('review-bar').classList.add('hidden');
}

$('review-keep-btn').addEventListener('click', () => {
  hideReview();
  addInfo('REVIEW: changes kept.');
  setState('idle');
});

$('review-diff-btn').addEventListener('click', showDiff);

$('review-discard-btn').addEventListener('click', async () => {
  if (!confirm('Discard this run? All files return to the pre-run checkpoint.')) return;
  const res = await window.api.undoCheckpoint(cwd);
  hideReview();
  if (res.ok) addInfo('REVIEW: run discarded — files restored to the pre-run checkpoint (UNDO again re-applies it).');
  else addError('Discard failed: ' + res.error);
  setState('idle');
  refreshGit();
});

// ---------- chat history ----------
async function loadChatHistory() {
  const allChats = await window.api.historyList();
  const chats = allChats.filter((chatEntry) => appMode === 'chat'
    ? chatEntry.mode === 'chat'
    : chatEntry.mode !== 'chat');
  chats.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // newest first
  chatList.innerHTML = '';

  if (chats.length === 0) {
    const noChats = document.createElement('div');
    noChats.className = 'no-chats';
    noChats.textContent = 'No chats yet';
    chatList.appendChild(noChats);
    return;
  }
  // General Chat conversations live outside projects; Code chats stay grouped by folder.
  const groups = new Map();
  for (const c of chats) {
    const key = c.mode === 'chat' ? '__general__' : c.cwd || '__legacy__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  for (const [group, items] of groups) {
    const head = document.createElement('div');
    head.className = 'chat-group';
    if (group === '__general__') {
      head.textContent = 'GENERAL';
      head.title = 'Folder-free Chat conversations';
    } else if (group === '__legacy__') {
      head.textContent = 'OLDER CHATS';
      head.title = 'Chats saved before modes and folders were tracked';
    } else {
      head.textContent = group.split('/').filter(Boolean).pop().toUpperCase();
      head.title = group;
    }
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
  const runMetrics = await window.api.usageGet();

  // Only generate a new title if this is a new chat (no existing title or title is generic)
  let title = 'Chat';
  const firstUser = conversation.find((m) => m.role === 'user');
  
  // Check if we should generate a title using the LLM
  if (!currentChatId || !firstUser) {
    // Use the new LLM-based title generation
    try {
      const titleRes = await window.api.generateChatTitle(conversation, modelSelect.value);
      if (titleRes.ok && titleRes.title) {
        title = titleRes.title;
      } else {
        // Fallback to old behavior if LLM fails
        title = firstUser
          ? firstUser.content.substring(0, 30) + (firstUser.content.length > 30 ? '...' : '')
          : 'Chat';
      }
    } catch (err) {
      // Fallback to old behavior if API call fails
      title = firstUser
        ? firstUser.content.substring(0, 30) + (firstUser.content.length > 30 ? '...' : '')
        : 'Chat';
    }
  } else {
    // For existing chats, keep the existing title
    const existingChat = await window.api.historyList();
    const chatEntry = existingChat.find(c => c.id === currentChatId);
    if (chatEntry && chatEntry.title) {
      title = chatEntry.title;
    } else if (firstUser) {
      title = firstUser.content.substring(0, 30) + (firstUser.content.length > 30 ? '...' : '');
    }
  }

  if (!currentChatId) currentChatId = Date.now().toString();
  const res = await window.api.historySave(
    {
      id: currentChatId,
      title,
      model: modelSelect.value,
      mode: appMode,
      cwd: appMode === 'code' ? cwd || '' : '',
      think: thinkToggle.checked,
      autoApprove: autoApprove.checked,
      autoBranch: autoBranchToggle.checked,
      onlineResearch: onlineResearchToggle.checked,
      subModel,
      coderModel,
      runMetrics,
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
  onlineResearchToggle.checked = false; // loading history must never restore network access
  setAppMode(saved.mode === 'chat' ? 'chat' : 'code');

  // Push the stored conversation into the main process so the model continues from it.
  const lc = await window.api.loadConversation(saved.conversation, saved.model || modelSelect.value, saved.runMetrics);
  renderConversation(saved.conversation);
  updateContextBar(lc.approxTokens, lc.contextLength);
  compactWarned = false; // fresh warning budget for this chat
  hideStartupMessage();
  currentChatId = chatId;

  // Auto-select the model this chat was using; if it's gone from Ollama, keep the current one.
  if (saved.model && [...modelSelect.options].some((o) => o.value === saved.model)) {
    modelSelect.value = saved.model;
    localStorage.setItem('model', saved.model);
  }

  // Restore the working directory this chat was using, if it still exists.
  let cwdChanged = false;
  if (appMode === 'code' && saved.cwd && saved.cwd !== cwd) {
    if (await window.api.dirExists(saved.cwd)) {
      setCwd(saved.cwd);
      cwdChanged = true;
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
  if (!cwdChanged) refreshGit();
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
      const imgs = (msg.images || []).map((b, i) => `data:${msg.imageTypes?.[i] || 'image/png'};base64,${b}`);
      addMessage('user', msg.content || (imgs.length ? '(image)' : ''), imgs);
    } else if (msg.role === 'assistant') {
      if (msg.thinking) addThinkingBlock(msg.thinking, 'THOUGHTS ▸');
      if (msg.content) renderMarkdown(addMessage('assistant', ''), msg.content);
    } else if (msg.role === 'tool') {
      const text = String(msg.content);
      if (msg.tool_name === 'run_subagent') {
        // replay saved subagent reports as collapsed cards, like the live view
        const m = text.match(/^Subagent report \(([^,]+), (\d+) tool calls?\):\n?/);
        const card = document.createElement('div');
        card.className = 'subagent done collapsed';
        const head = document.createElement('div');
        head.className = 'sub-head';
        head.innerHTML = '<span class="sub-title"></span><span class="sub-status">saved · click to expand</span>';
        head.querySelector('.sub-title').textContent = 'SUBAGENT · ' + (m ? m[1] : 'report');
        head.addEventListener('click', () => card.classList.toggle('collapsed'));
        const pre = document.createElement('pre');
        pre.textContent = m ? text.slice(m[0].length) : text;
        card.appendChild(head);
        card.appendChild(pre);
        chat.appendChild(card);
      } else {
        addMessage('tool', `[${msg.tool_name}] ` + (text.length > 300 ? text.slice(0, 300) + '…' : text));
      }
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
    if (text === '/help' || text.includes('/commit') || text.includes('/model') || text.includes('/subagent') || text.includes('/coder') || text.includes('/orchestrate')) {
      hideStartupMessage();
    }
    return handleSlash(text);
  }
  if (!modelSelect.value) return addError('No model selected — is Ollama running?');
  if (appMode === 'code' && !cwd) return addError('Pick a working directory first (DIR button, top left).');

  // Ollama wants raw base64 without the data-URL prefix
  const images = pendingImages.map((d) => d.split(',')[1]);
  const imageTypes = pendingImages.map((d) => d.slice(5, d.indexOf(';')) || 'image/png');
  const shownImages = pendingImages;
  pendingImages = [];
  renderImagePreview();

  input.value = '';
  hideStartupMessage();
  addMessage('user', text || '(image)', shownImages);
  startRun();

  const res = await window.api.send({
    model: modelSelect.value,
    subModel,
    text,
    mode: appMode,
    cwd: appMode === 'code' ? cwd : null,
    autoApprove: appMode === 'code' && autoApprove.checked,
    autoBranch: appMode === 'code' && autoBranchToggle.checked,
    onlineResearch: onlineResearchToggle.checked,
    think: thinkToggle.checked,
    images,
    imageTypes,
  });

  if (!res.ok) addError(res.error);

  // Save before accepting another send so two first-message saves cannot race.
  try {
    await saveChat();
  } catch (err) {
    addError('Failed to save chat: ' + (err.message || err));
  } finally {
    endRun();
  }
}

function startRun() {
  busy = true;
  hideStartupMessage(); // slash commands (/loop etc.) start runs without a normal send
  hideReview();
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

// info notices pushed from main (loop progress, verifier verdicts, auto-compact)
window.api.onInfo((text) => addInfo(text));

// status-bar state pushed from main (loop iteration, verifying, compacting)
window.api.onState((text) => setState(text));

// ---------- subagent cards ----------
let currentSubCard = null;

window.api.onSubagent((d) => {
  if (d.phase === 'start') {
    finalizeThinking();
    finalizeAssistant();
    const card = document.createElement('div');
    card.className = 'subagent';
    const head = document.createElement('div');
    head.className = 'sub-head';
    head.innerHTML = '<span class="sub-title"></span><span class="sub-status">exploring…</span>';
    head.querySelector('.sub-title').textContent = (d.role || 'SUBAGENT') + ' · ' + d.model;
    const task = document.createElement('div');
    task.className = 'sub-task';
    task.textContent = d.task.length > 160 ? d.task.slice(0, 160) + '…' : d.task;
    task.title = d.task;
    const log = document.createElement('div');
    log.className = 'sub-log';
    card.appendChild(head);
    card.appendChild(task);
    card.appendChild(log);
    head.addEventListener('click', () => {
      if (card.classList.contains('done')) card.classList.toggle('collapsed');
    });
    chat.appendChild(card);
    currentSubCard = card;
    setState((d.role || 'subagent').toLowerCase() + ' working');
    scrollDown();
  } else if (d.phase === 'tool' && currentSubCard) {
    const line = document.createElement('div');
    line.textContent = '· ' + d.name + '  ' + shortArgs(d.name, d.args || {});
    currentSubCard.querySelector('.sub-log').appendChild(line);
    scrollDown();
  } else if (d.phase === 'done' && currentSubCard) {
    currentSubCard.classList.add('done', 'collapsed');
    currentSubCard.querySelector('.sub-status').textContent = `done · ${d.steps} tool${d.steps === 1 ? '' : 's'} · click to expand`;
    const pre = document.createElement('pre');
    pre.textContent = d.report;
    currentSubCard.appendChild(pre);
    currentSubCard = null;
    setState('working');
    scrollDown();
  }
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

let compactWarned = false;

function updateContextBar(contextTokens, contextLength) {
  if (!contextLength) return;
  $('ctx-tokens').textContent = contextTokens.toLocaleString();
  $('ctx-limit').textContent = contextLength.toLocaleString();
  const pct = Math.min(100, (contextTokens / contextLength) * 100);
  const fill = $('ctx-fill');
  fill.style.width = pct + '%';
  fill.className = pct > 90 ? 'danger' : pct > 70 ? 'warn' : '';
  fill.id = 'ctx-fill';
}

window.api.onStats(({ contextTokens, contextLength, tokPerSec, scope }) => {
  updateContextBar(contextTokens, contextLength);
  if (tokPerSec) $('tok-speed').textContent = tokPerSec.toFixed(1) + ' t/s';
  // Planner context is short-lived and discarded after /orchestrate. Warn only
  // when the persisted conversation itself needs compaction.
  if (scope !== 'planner' && !compactWarned && contextTokens / contextLength > 0.8) {
    compactWarned = true;
    addInfo('Context is over 80% full — run /compact soon or the model will start losing the oldest messages (including its instructions).');
  }
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
  if (args.query) return args.query.length > 60 ? args.query.slice(0, 60) + '…' : args.query;
  if (args.url) return args.url.length > 60 ? args.url.slice(0, 60) + '…' : args.url;
  if (args.pattern) return '"' + args.pattern + '"';
  return '';
}

// ---------- approvals ----------
let pendingApprovalId = null;

window.api.onApprovalRequest(({ id, name, args, network, sensitive, destructive }) => {
  pendingApprovalId = id;
  $('approval-tool').textContent = (network ? 'ONLINE REQUEST — ' : sensitive ? 'SENSITIVE READ — ' : destructive ? 'DESTRUCTIVE — ' : 'APPROVE ') + name.toUpperCase() + '?';
  $('approval-detail').textContent =
    name === 'web_search' ? `This query will be sent to DuckDuckGo:\n\n${args.query}\n\nDomains: ${(args.allowed_domains || []).join(', ') || '(unrestricted)'}`
    : name === 'web_fetch' ? `This public URL will be requested and its text returned to the model:\n\n${args.url}`
    : name === 'get_environment_variables' ? `${args.reveal ? 'REVEAL RAW VALUE' : 'Inspect redacted metadata'}: ${args.name}\n\nRaw values, when revealed, are retained in chat history.`
    : name === 'list_processes' ? `Process command lines may contain credentials.\n\nFilter: ${args.pattern || '(all processes)'}`
    : name === 'read_file' && sensitive ? `This file may contain credentials or private key material. Its contents will be retained in chat history.\n\n${args.path}`
    : name === 'revert_to_last_commit' ? `Restore ${args.path || 'the entire working tree'} to HEAD.\n\nTracked changes will be saved in a recoverable named Git stash first.\nUntracked files: ${args.include_untracked ? 'INCLUDED — they will leave the working tree and enter the stash' : 'preserved'}\nIgnored files and submodule contents: preserved`
    : name === 'run_command' ? args.command
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

const codeStartupMessages = [
  "Welcome to Brittain Code!",
  "Ready to help with your coding tasks",
  "Start by describing what you'd like to build",
  "Ask me anything about programming",
  "Happy to assist with your development",
  "Let's get coding!",
  "Your AI coding assistant is here",
  "Ask questions, get answers, build amazing things"
];

const chatStartupMessages = [
  'What would you like to explore?',
  'Chat locally, or enable Research to search the web',
  'Ask a question without choosing a folder',
  'Ready when you are',
];

// Show a random startup message
function showStartupMessage() {
  const contentElement = $('startup-message-content');
  contentElement.innerHTML = '';

  const messages = appMode === 'chat' ? chatStartupMessages : codeStartupMessages;
  const randomMessage = messages[Math.floor(Math.random() * messages.length)];
  const p = document.createElement('p');
  p.textContent = randomMessage;
  contentElement.appendChild(p);

  $('startup-message').classList.remove('hidden');
}

function hideStartupMessage() {
  $('startup-message').classList.add('hidden');
}

// ---------- event listeners ----------
$('history-btn').addEventListener('click', () => {
  sidebar.classList.toggle('hidden');
});

async function newSession() {
  if (busy) return;
  await window.api.reset();
  compactWarned = false;
  chat.innerHTML = '';
  toolCount = 0;
  $('tool-count').textContent = '0';
  $('ctx-tokens').textContent = '0';
  $('ctx-fill').style.width = '0%';
  setState('idle');
  currentChatId = null;
  onlineResearchToggle.checked = false;
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
  '/graph — show a visual tree of the git commit history',
  '/loop [--coder] [n] <goal> — repeat until verified; --coder delegates planned implementation and repairs to the selected coder model',
  '/orchestrate <goal> — planner inspects and delegates sequential implementation tasks to the selected coder model',
  '/model <for name> — switch model (partial match ok)',
  '/coder [name] — show or set the writable coding-worker model (partial match ok)',
  '/subagent [name] — show or set the subagent/verifier model (partial match ok)',
  '/usage — show how context and tokens have been spent across all agents',
  '/memory — view what the agent has remembered',
  '/export — save this chat as a markdown file',
  '/tools — list all available tools',
].join('\n');

const CHAT_SLASH_HELP = [
  '/help — show this list',
  '/clear — start a new session',
  '/compact — summarize the conversation to free up context',
  '/model <name> — switch model (partial match ok)',
  '/usage — show context and token usage',
  '/export — save this chat as a markdown file',
  '/tools — list tools available to the app',
].join('\n');

async function handleSlash(raw) {
  const [cmd, ...rest] = raw.slice(1).split(' ');
  const arg = rest.join(' ').trim();
  const normalizedCmd = cmd.toLowerCase();
  const codeOnlyCommands = new Set(['diff', 'graph', 'loop', 'orchestrate', 'commit', 'coder', 'subagent', 'memory']);
  if (appMode === 'chat' && codeOnlyCommands.has(normalizedCmd)) {
    return addError(`/${normalizedCmd} is only available in Code mode.`);
  }

  switch (normalizedCmd) {
    case 'help':
      return addInfo(appMode === 'chat' ? CHAT_SLASH_HELP : SLASH_HELP);

    case 'clear':
      return newSession();

    case 'compact': {
      if (busy) return;
      if (!modelSelect.value) return addError('No model selected.');
      startRun();
      setState('compacting…');
      let res;
      try {
        res = await window.api.compact({ model: modelSelect.value });
      } catch (err) {
        res = { ok: false, error: err.message || String(err) };
      } finally {
        endRun();
      }
      if (!res.ok) return addError('Compact failed: ' + res.error);
      renderConversation(await window.api.getConversation());
      updateContextBar(res.approxTokens, res.contextLength);
      compactWarned = false; // re-arm the 80% warning for the fresh window
      addInfo('Conversation compacted. The model will continue from the summary above.');
      return saveChat();
    }

    case 'diff':
      return showDiff();

    case 'graph': {
      if (!cwd) return addError('Pick a working directory first (DIR button, top left).');
      const res = await window.api.gitGraph(cwd);
      if (!res.ok) return addError(res.error);
      return showOverlay('GIT GRAPH — ' + cwd, res.graph);
    }

    case 'loop': {
      if (busy) return;
      if (!modelSelect.value) return addError('No model selected.');
      if (!cwd) return addError('Pick a working directory first (DIR button, top left).');
      let useCoder = false;
      let iterations = 8;
      let goal = arg;
      const coderFlag = goal.match(/^--coder(?:\s+|$)/i);
      if (coderFlag) {
        useCoder = true;
        goal = goal.slice(coderFlag[0].length).trim();
      }
      const m = goal.match(/^(\d+)\s+([\s\S]+)/);
      if (m) { iterations = parseInt(m[1], 10); goal = m[2].trim(); }
      if (!goal) return addError('Usage: /loop [--coder] [iterations] <goal> — e.g. /loop --coder 10 make all tests pass');
      if (useCoder && !coderModel) return addError('No coder model selected. Use /coder <name>.');
      if (!autoApprove.checked) addInfo('Heads up: AUTO-APPROVE is off, so the loop will pause for every risky tool call. Turn it on for unattended runs.');

      addMessage('user', `${useCoder ? 'CODER LOOP' : 'LOOP'} (max ${iterations}): ${goal}`);
      startRun();
      try {
        const res = await window.api.loop({
          model: modelSelect.value,
          coderModel,
          useCoder,
          subModel,
          goal,
          cwd,
          autoApprove: autoApprove.checked,
          autoBranch: autoBranchToggle.checked,
          onlineResearch: onlineResearchToggle.checked,
          think: thinkToggle.checked,
          maxIterations: iterations,
        });
        if (!res.ok) addError(res.error);
        else if (res.report) renderMarkdown(addMessage('assistant', res.report), res.report);
      } catch (err) {
        addError('Loop failed: ' + (err.message || err));
      } finally {
        endRun();
      }
      return saveChat();
    }

    case 'orchestrate': {
      if (busy) return;
      if (!modelSelect.value) return addError('No orchestrator model selected.');
      if (!coderModel) return addError('No coder model selected. Use /coder <name>.');
      if (!cwd) return addError('Pick a working directory first (DIR button, top left).');
      if (!arg) return addError('Usage: /orchestrate <goal>');
      if (!autoApprove.checked) addInfo('AUTO-APPROVE is off. The coding worker will pause for file writes and commands; online requests always require separate approval.');

      addMessage('user', `ORCHESTRATE: ${arg}`);
      startRun();
      let res;
      try {
        res = await window.api.orchestrate({
          model: modelSelect.value,
          coderModel,
          subModel,
          goal: arg,
          cwd,
          autoApprove: autoApprove.checked,
          onlineResearch: onlineResearchToggle.checked,
          think: thinkToggle.checked,
        });
        if (!res.ok) addError(res.error);
        else if (res.report) renderMarkdown(addMessage('assistant', res.report), res.report);
        await saveChat();
      } catch (err) {
        addError('Orchestration failed: ' + (err.message || err));
      } finally {
        endRun();
      }
      return res;
    }

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

    case 'subagent': {
      const models = [...modelSelect.options].map((o) => o.value);
      if (!arg) return addInfo(`Subagent model: ${subModel}\nAvailable: ${models.join(', ')}\nUse /subagent <name> to change.`);
      const match = models.find((v) => v.includes(arg));
      if (!match) return addError(`No installed model matching "${arg}".`);
      subModel = match;
      localStorage.setItem('subModel', match);
      return addInfo('Subagent model set to ' + match);
    }

    case 'coder': {
      const models = [...modelSelect.options].map((o) => o.value);
      if (!arg) return addInfo(`Coder model: ${coderModel}\nAvailable: ${models.join(', ')}\nUse /coder <name> to change. Restart Brittain Code after installing a new Ollama model so it appears here.`);
      const match = models.find((v) => v.includes(arg));
      if (!match) return addError(`No installed model matching "${arg}". If Ollama just finished installing it, restart Brittain Code to refresh the model list.`);
      coderModel = match;
      localStorage.setItem('coderModel', match);
      return addInfo('Coder model set to ' + match);
    }

    case 'usage': {
      const u = await window.api.usageGet();
      const fmt = (n) => (n || 0).toLocaleString();
      const row = (label, b) => `${label.padEnd(11)} ${String(b.calls).padStart(4)} calls   ${fmt(b.prompt).padStart(10)} processed   ${fmt(b.gen).padStart(9)} generated`;
      const totalGen = u.main.gen + u.subagent.gen + u.coder.gen + u.verifier.gen;
      const totalProc = u.main.prompt + u.subagent.prompt + u.coder.prompt + u.verifier.prompt;
      const ctx = u.context.limit
        ? `${fmt(u.context.tokens)} / ${fmt(u.context.limit)} (${Math.round((u.context.tokens / u.context.limit) * 100)}% used, ${fmt(u.context.limit - u.context.tokens)} left)`
        : '(no requests yet this chat)';
      return showOverlay('USAGE — this chat', [
        'CONTEXT (main agent conversation)',
        '  ' + ctx,
        '',
        'INFERENCE (tokens, since this chat was opened)',
        '  ' + row('main agent', u.main),
        '  ' + row('subagents', u.subagent) + `   (${u.subagent.runs} run${u.subagent.runs === 1 ? '' : 's'})`,
        '  ' + row('coders', u.coder) + `   (${u.coder.runs} run${u.coder.runs === 1 ? '' : 's'})`,
        '  ' + row('verifier', u.verifier),
        '  ' + '─'.repeat(60),
        `  total       ${fmt(totalProc)} processed, ${fmt(totalGen)} generated`,
        '',
        'Note: "processed" counts every token the models read, including the',
        'same conversation re-read on each agent step — it measures compute',
        'spent, not context size. Subagent/coder/verifier tokens never touch the',
        'main context; that is the point of delegating.',
      ].join('\n'));
    }

    case 'memory': {
      if (!cwd) return addError('Pick a working directory first (DIR button, top left).');
      const res = await window.api.memoryGet(cwd);
      if (!res.ok) return addError(res.error);
      let content = res.content.trim() || '(nothing remembered for this project yet)';
      if (res.legacyContent?.trim()) {
        content += `\n\nLEGACY UNIVERSAL MEMORY (not injected)\n${res.legacyPath}\n\n${res.legacyContent.trim()}`;
      }
      return showOverlay('PROJECT MEMORY — ' + res.path, content);
    }

    case 'export': {
      const res = await window.api.exportChat();
      if (res.ok) return addInfo('Exported to ' + res.path);
      if (res.error !== 'cancelled') return addError(res.error);
      return;
    }

    case 'tools': {
      const res = await window.api.toolsList(appMode);
      if (!res.ok) return addError('Failed to fetch tools: ' + res.error);
      const toolLines = res.tools.map(t => (t.isNetwork ? '[NET] ' : t.isSensitive ? '[SEC] ' : t.isDestructive ? '[DEST]' : t.isRisky ? '[!]   ' : '      ') + ' ' + t.name);
      return showOverlay('AVAILABLE TOOLS', toolLines.join('\n'));
    }

    default:
      return addError('Unknown command: /' + cmd + ' — try /help');
  }
}

// ---------- git ----------
async function refreshGit() {
  const info = $('git-info');
  if (appMode !== 'code' || !cwd) return info.classList.add('hidden');
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
