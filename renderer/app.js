// Brittain Code — UI logic.

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const input = $('input');
const sendBtn = $('send-btn');
const stopBtn = $('stop-btn');
const modelSelect = $('model-select');
const autonomySelect = $('autonomy-select');

// Keep dialogs in the usable area below the top bar. The bar can wrap when the
// window is narrow, so its height is measured instead of copied into the CSS.
const topbar = $('topbar');
function syncPopupArea() {
  document.documentElement.style.setProperty(
    '--topbar-height',
    `${Math.ceil(topbar.getBoundingClientRect().bottom)}px`
  );
}
syncPopupArea();
new ResizeObserver(syncPopupArea).observe(topbar);

// Autonomy replaced the AUTO-APPROVE checkbox: one control for one concept,
// because two overlapping supervision controls is how an unsupervised write
// happens that nobody intended.
let autonomyPolicy = 'supervised';
let autonomyPolicies = [];
const autonomyDescription = (id) => autonomyPolicies.find((entry) => entry.id === id)?.description || '';
// Anything other than the two attended stops runs risky tools without asking.
const runsUnattended = () => autonomyPolicy !== 'supervised' && autonomyPolicy !== 'guarded';

async function loadAutonomy() {
  const state = await window.api.autonomyState();
  if (!state?.ok) return;
  autonomyPolicies = state.policies;
  autonomyPolicy = state.current;
  autonomySelect.innerHTML = '';
  for (const policy of state.policies) {
    const option = document.createElement('option');
    option.value = policy.id;
    option.textContent = policy.label;
    option.title = policy.description;
    autonomySelect.appendChild(option);
  }
  autonomySelect.value = autonomyPolicy;
  document.body.dataset.autonomy = runsUnattended() ? 'unattended' : 'attended';
  $('autonomy-control').title = autonomyDescription(autonomyPolicy) || 'How much this run may do without asking';
}

autonomySelect.addEventListener('change', async () => {
  const wanted = autonomySelect.value;
  const previous = autonomyPolicy;
  // Selecting an unattended policy for the first time in a project should be a
  // deliberate act, not a stray click on a dropdown.
  if (wanted !== previous && wanted !== 'supervised' && wanted !== 'guarded') {
    const confirmed = await confirmDialog(
      `Switch autonomy to "${autonomyPolicies.find((entry) => entry.id === wanted)?.label || wanted}"?\n\n`
      + `${autonomyDescription(wanted)}\n\n`
      + 'Risky tool calls will run without asking. Destructive operations, sensitive reads, and external MCP tools still require approval.',
      { okLabel: 'SWITCH', danger: true }
    );
    if (!confirmed) { autonomySelect.value = previous; return; }
  }
  const res = await window.api.autonomySet(wanted);
  if (!res.ok) { autonomySelect.value = previous; return addError(res.error); }
  await loadAutonomy();
});
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
let appSettings = null;
let settingsDefaults = null;
let currentModels = [];
let missionCard = null;
let latestMission = null;
let pendingPlanDraft = null;
let pendingPlanCard = null;
let updateState = null;
let currentModelDetails = [];

const activeModelPicker = window.ModelPicker?.create(modelSelect, {
  emptyLabel: 'No models available',
});

setAppMode(appMode, false, false);

// ---------- boot ----------
(async function boot() {
  const settingsRes = await window.api.settingsGet();
  if (settingsRes.ok) {
    appSettings = settingsRes.settings;
    settingsDefaults = settingsRes.defaults;
    if (appSettings.defaultMode !== 'last') appMode = appSettings.defaultMode;
    setAppMode(appMode, false, false);
  }

  await loadAutonomy();

  const models = await reloadModels(defaultModelForMode(appMode));

  // Display version number
  try {
    const version = await window.api.getVersion();
    $('version-display').textContent = `v${version}`;
    $('settings-update-version').textContent = `CURRENT v${version}`;
    $('version-display').classList.remove('hidden');
  } catch (e) {
    console.error('Failed to load version:', e);
  }

  try {
    renderUpdateState(await window.api.updateState());
  } catch (e) {
    console.error('Failed to load update state:', e);
  }

  // subagent model: validate the saved choice against what's installed
  subModel = appSettings?.scoutModel || subModel;
  if (!models.includes(subModel)) {
    subModel = models.includes('qwen3:8b') ? 'qwen3:8b' : models[0] || '';
  }
  // Prefer the coding-specialized model, then gpt-oss as a capable local
  // fallback once installed, then whichever subagent model is available.
  coderModel = appSettings?.coderModel || coderModel;
  if (!models.includes(coderModel)) {
    coderModel = models.includes('qwen3-coder:30b')
      ? 'qwen3-coder:30b'
      : models.includes('gpt-oss:20b')
        ? 'gpt-oss:20b'
        : subModel || models[0] || '';
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

  applySessionDefaults();

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
  const missionRes = await window.api.missionGet();
  if (missionRes.ok && missionRes.mission) upsertMissionCard(missionRes.mission);
  
  // Show startup message on boot
  showStartupMessage();
})();

window.api.onUpdateState(renderUpdateState);

function renderUpdateState(state) {
  if (!state) return;
  updateState = state;
  const status = $('settings-update-status');
  const check = $('settings-check-update');
  const install = $('settings-install-update');
  const action = $('update-action');
  status.textContent = state.message || '';
  status.classList.toggle('error', state.status === 'error');
  status.classList.toggle('ok', ['up-to-date', 'downloaded'].includes(state.status));
  check.disabled = !state.enabled || ['checking', 'downloading', 'installing'].includes(state.status);
  install.classList.toggle('hidden', state.status !== 'downloaded');
  action.classList.toggle('hidden', !['downloading', 'downloaded'].includes(state.status));
  action.disabled = state.status !== 'downloaded';
  action.textContent = state.status === 'downloaded'
    ? `UPDATE v${state.version}`
    : `UPDATE ${state.percent || 0}%`;
}

async function installReadyUpdate() {
  if (busy) return addError('Stop the active run before you restart to update.');
  const version = updateState?.version ? ` ${updateState.version}` : '';
  if (!(await confirmDialog(`Restart Brittain Code and install version${version}?`, { okLabel: 'RESTART' }))) return;
  const result = await window.api.installUpdate();
  if (!result.ok) addError(result.error);
}

$('settings-check-update').addEventListener('click', async () => {
  const result = await window.api.checkForUpdates();
  if (!result.ok && result.error) renderUpdateState(result.state || {
    ...updateState,
    status: 'error',
    message: `Update check failed: ${result.error}`,
  });
});
$('settings-install-update').addEventListener('click', installReadyUpdate);
$('update-action').addEventListener('click', installReadyUpdate);

function defaultModelForMode(mode) {
  const configured = mode === 'chat' ? appSettings?.chatModel : appSettings?.codeModel;
  return configured || localStorage.getItem(`model:${mode}`) || localStorage.getItem('model') || '';
}

async function reloadModels(preferred = '') {
  const res = await window.api.listModels();
  modelSelect.innerHTML = '';
  if (!res.ok) {
    currentModels = [];
    currentModelDetails = [];
    activeModelPicker?.refresh([]);
    renderOnboarding('unreachable', res.error, res.provider);
    populateSettingsModelSelects();
    return currentModels;
  }
  currentModels = res.models;
  currentModelDetails = Array.isArray(res.modelDetails) ? res.modelDetails : [];
  for (const name of currentModels) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    modelSelect.appendChild(opt);
  }
  if (preferred && currentModels.includes(preferred)) modelSelect.value = preferred;
  activeModelPicker?.refresh(currentModelDetails);
  populateSettingsModelSelects();
  renderOnboarding(currentModels.length ? 'ok' : 'empty', '', res.provider);
  return currentModels;
}

// ---------- onboarding overlay: unreachable endpoint / zero models installed ----------
function renderOnboarding(state, detail, provider = 'ollama') {
  const overlay = $('onboarding-overlay');
  const title = $('onboarding-title');
  const body = $('onboarding-body');
  const ollamaBtn = $('onboarding-ollama');
  const recommendationsBtn = $('onboarding-recommendations');

  if (state === 'ok') {
    overlay.classList.add('hidden');
    return;
  }

  overlay.classList.remove('hidden');
  const cloud = provider === 'openai';
  // Telling someone to install Ollama when they have deliberately configured a
  // cloud provider is advice for a problem they do not have.
  ollamaBtn.classList.toggle('hidden', cloud || state !== 'unreachable');
  recommendationsBtn.classList.toggle('hidden', cloud || state !== 'empty');

  if (cloud) {
    title.textContent = state === 'unreachable' ? 'CANNOT REACH THE PROVIDER' : 'NO MODELS AVAILABLE';
    body.innerHTML = '';
    const explanation = document.createElement('p');
    explanation.textContent = detail || 'The provider returned no models.';
    body.appendChild(explanation);
    const next = document.createElement('p');
    next.textContent = state === 'unreachable'
      ? 'Check the endpoint URL and API key in Settings, then try again.'
      : 'The endpoint answered but listed nothing. Check that the API key has access to any models.';
    body.appendChild(next);
    return;
  }

  if (state === 'unreachable') {
    title.textContent = 'NO LOCAL MODEL SERVER FOUND';
    body.innerHTML = '';
    const p1 = document.createElement('p');
    p1.textContent = detail || 'Brittain Code could not reach an Ollama-compatible endpoint.';
    const p2 = document.createElement('p');
    p2.textContent = 'Install Ollama, then make sure it is running:';
    body.appendChild(p1);
    body.appendChild(p2);
    addCopyableCommand(body, 'ollama serve');
    const p3 = document.createElement('p');
    p3.textContent = 'Using a different local server (LM Studio, etc.)? Point Brittain Code at its address instead:';
    body.appendChild(p3);
  } else if (state === 'empty') {
    title.textContent = 'NO MODELS INSTALLED YET';
    body.innerHTML = '';
    const p1 = document.createElement('p');
    p1.textContent = 'Ollama is running, but no models are pulled. View the Mac benchmark recommendations, or pull a model directly:';
    body.appendChild(p1);
    addCopyableCommand(body, 'ollama pull gpt-oss:20b');
    const p2 = document.createElement('p');
    p2.textContent = 'or, for a smaller/faster download:';
    body.appendChild(p2);
    addCopyableCommand(body, 'ollama pull qwen2.5-coder:7b');
    const p3 = document.createElement('p');
    p3.textContent = 'Browse more at ollama.com/library, then check again.';
    body.appendChild(p3);
  }
}

function addCopyableCommand(container, command) {
  const code = document.createElement('code');
  code.textContent = command;
  code.title = 'Click to copy';
  code.addEventListener('click', () => {
    navigator.clipboard.writeText(command).catch(() => {});
    const original = code.textContent;
    code.textContent = 'copied!';
    setTimeout(() => { code.textContent = original; }, 900);
  });
  container.appendChild(code);
}

$('onboarding-retry').addEventListener('click', async () => {
  $('onboarding-retry').textContent = 'CHECKING…';
  await reloadModels(defaultModelForMode(appMode));
  applySessionDefaults();
  $('onboarding-retry').textContent = 'CHECK AGAIN';
});

$('onboarding-recommendations').addEventListener('click', async () => {
  const button = $('onboarding-recommendations');
  button.textContent = 'LOADING…';
  try {
    const result = await window.api.getModelRecommendations(appMode);
    if (!result.ok) return addError(result.error);
    showRecommendations(result);
  } catch (err) {
    addError('Could not load model recommendations: ' + (err.message || err));
  } finally {
    button.textContent = 'VIEW RECOMMENDATIONS';
  }
});

$('onboarding-settings').addEventListener('click', () => {
  showSettings();
});

$('onboarding-ollama').addEventListener('click', () => window.api.openOllamaSite());


function applySessionDefaults() {
  thinkToggle.checked = appSettings ? !!appSettings[appMode === 'chat' ? 'chatThink' : 'codeThink'] : localStorage.getItem('think') === '1';
  
  autoBranchToggle.checked = appSettings ? !!appSettings.autoBranch : localStorage.getItem('autoBranch') === '1';
  reviewToggle.checked = appSettings ? !!appSettings.reviewMode : localStorage.getItem('reviewMode') === '1';
  sidebar.classList.toggle('hidden', appSettings ? !appSettings.sidebarOpen : false);
  onlineResearchToggle.checked = false; // privacy boundary: never restore online access implicitly
  const preferred = defaultModelForMode(appMode);
  if (preferred && currentModels.includes(preferred)) modelSelect.value = preferred;
  activeModelPicker?.sync();
}

thinkToggle.addEventListener('change', () => localStorage.setItem('think', thinkToggle.checked ? '1' : '0'));

autoBranchToggle.addEventListener('change', () => localStorage.setItem('autoBranch', autoBranchToggle.checked ? '1' : '0'));
reviewToggle.addEventListener('change', () => localStorage.setItem('reviewMode', reviewToggle.checked ? '1' : '0'));
onlineResearchToggle.addEventListener('change', async () => {
  if (!onlineResearchToggle.checked) return;
  const approved = await confirmDialog(
    'Enable ONLINE RESEARCH for this session?\n\nSearch queries and requested page URLs will leave this computer. Every web_search and web_fetch call will still require explicit approval, even when AUTO-APPROVE is on.',
    { okLabel: 'ENABLE' }
  );
  if (!approved) onlineResearchToggle.checked = false;
});

modelSelect.addEventListener('change', () => {
  localStorage.setItem('model', modelSelect.value);
  localStorage.setItem(`model:${appMode}`, modelSelect.value);
});
codeModeBtn.addEventListener('click', () => chooseAppMode('code'));
chatModeBtn.addEventListener('click', () => chooseAppMode('chat'));

function setAppMode(mode, persist = true, refreshHistory = true) {
  appMode = mode === 'chat' ? 'chat' : 'code';
  document.body.dataset.mode = appMode;
  codeModeBtn.classList.toggle('active', appMode === 'code');
  chatModeBtn.classList.toggle('active', appMode === 'chat');
  codeModeBtn.setAttribute('aria-pressed', appMode === 'code' ? 'true' : 'false');
  chatModeBtn.setAttribute('aria-pressed', appMode === 'chat' ? 'true' : 'false');
  $('sidebar-head').textContent = appMode === 'chat' ? 'CHAT HISTORY' : 'CODE HISTORY';
  input.placeholder = appMode === 'chat'
    ? 'Ask anything... (Enter to send, Shift+Enter for newline)'
    : 'Describe a task... (Enter to send, Shift+Enter for newline)';
  if (persist) localStorage.setItem('appMode', appMode);
  syncMissionCard();
  refreshGit();
  if (refreshHistory) loadChatHistory();
}

async function chooseAppMode(mode) {
  if (busy || mode === appMode) return;
  const conversation = await window.api.getConversation();
  const consequences = [];
  if (conversation.length) consequences.push('Your current chat is already saved in History.');
  if (pendingPlanDraft) consequences.push('The current plan draft will be cancelled.');
  if (consequences.length && !(await confirmDialog(
    `Switch to ${mode.toUpperCase()} and start a new session?\n\n${consequences.join('\n')}`,
    { okLabel: 'SWITCH' },
  ))) return;
  if (pendingPlanDraft) clearPendingPlan();
  setAppMode(mode);
  if (conversation.length) await newSession();
  else {
    applySessionDefaults();
    showStartupMessage();
  }
}

$('cwd-btn').addEventListener('click', async () => {
  const res = await window.api.pickCwd();
  if (res.ok) setCwd(res.path);
});

// In-app replacement for window.confirm() — native dialogs break keyboard
// focus in the renderer on Windows (Electron/Chromium). Returns a promise that
// resolves true (OK) or false (Cancel). Enter confirms, Escape cancels.
// Projects that have already acknowledged the unattended-run disclosure. Kept
// per project so it is a one-time act, not a nag on every run.
const agentAcknowledged = new Set(JSON.parse(localStorage.getItem('agentAcknowledged') || '[]'));

async function confirmAgentRun(projectPath, policyId) {
  if (agentAcknowledged.has(projectPath)) return true;
  const named = policyId || autonomyPolicy;
  const confirmed = await confirmDialog(
    'Start an UNATTENDED agent run in this project?\n\n'
    + `Autonomy policy: ${named}\n\n`
    + 'With nobody watching, the agent acts on its own: it can run shell commands, '
    + 'drive a browser, and call connected tools to do things on the web. Some of those '
    + 'actions cannot be undone, and a Git checkpoint only restores files, not anything '
    + 'that has left this machine — and in a folder without a Git repository there is no '
    + 'file-level undo at all.\n\n'
    + 'Actions the policy does not permit are held in the run\'s review tray rather than '
    + 'performed. Spending money still requires your approval at the moment it happens.\n\n'
    + 'You are responsible for what an unattended run does. Continue?',
    { okLabel: 'RUN UNATTENDED', danger: true }
  );
  if (confirmed) {
    agentAcknowledged.add(projectPath);
    localStorage.setItem('agentAcknowledged', JSON.stringify([...agentAcknowledged]));
  }
  return confirmed;
}

function confirmDialog(message, { okLabel = 'OK', cancelLabel = 'CANCEL', danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $('confirm-modal');
    const okBtn = $('confirm-ok');
    const cancelBtn = $('confirm-cancel');
    $('confirm-message').textContent = message;
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.classList.toggle('deny', danger);
    okBtn.classList.toggle('approve', !danger);
    modal.classList.remove('hidden');
    okBtn.focus();

    function cleanup(result) {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) { if (e.target === modal) cleanup(false); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); cleanup(true); }
    }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}

function setCwd(p) {
  if (pendingPlanDraft && pendingPlanDraft.cwd !== p) {
    clearPendingPlan();
    addInfo('PLAN: draft cancelled because the working directory changed.');
  }
  cwd = p;
  localStorage.setItem('cwd', p);
  const parts = p.split('/');
  $('cwd-label').textContent = parts.slice(-2).join('/') || p;
  $('cwd-btn').title = p;
  undoBtn.disabled = true; // checkpoints are per-folder; a new DIR has none yet
  syncMissionCard();
  refreshGit();
}

// ---------- run checkpoints / UNDO ----------
window.api.onCheckpointState(({ available, cwd: ckptCwd }) => {
  if (available && ckptCwd === cwd) undoBtn.disabled = false;
});

undoBtn.addEventListener('click', async () => {
  if (busy || undoBtn.disabled) return;
  if (!(await confirmDialog('Restore all files in this folder to the checkpoint taken before the last run?\n\n(The current state is checkpointed first — press UNDO again to re-apply the run.)', { okLabel: 'RESTORE' }))) return;
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
  if (!(await confirmDialog('Discard this run? All files return to the pre-run checkpoint.', { okLabel: 'DISCARD', danger: true }))) return;
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
    // Whether this session reached the network is worth seeing before opening
    // it. Loading it still never turns the switch back on — see resetChatState.
    if (c.onlineResearch) {
      const online = document.createElement('span');
      online.className = 'chat-online';
      online.textContent = 'ONLINE';
      online.title = 'This session ran with online research enabled at some point. Opening it does not re-enable it.';
      main.appendChild(online);
    }

    const del = document.createElement('button');
    del.className = 'chat-del';
    del.textContent = '✕';
    del.title = 'Delete this chat';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await confirmDialog('Delete this chat?', { okLabel: 'DELETE', danger: true })) deleteChat(c.id);
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
  const contextRes = await window.api.contextState();

  // Only generate a new title if this is a new chat (no existing title or title is generic)
  let title = 'Chat';
  const firstUser = conversation.find((m) => m.role === 'user');
  const firstUserText = firstUser
    ? firstUser.displayContent || firstUser.attachments?.map((attachment) => attachment.name).join(', ') || firstUser.content || 'Chat'
    : 'Chat';
  const fallbackTitle = firstUserText.substring(0, 30) + (firstUserText.length > 30 ? '...' : '');
  
  // Check if we should generate a title using the LLM
  if (!currentChatId || !firstUser) {
    // Use the new LLM-based title generation
    try {
      const titleRes = await window.api.generateChatTitle(conversation, modelSelect.value);
      if (titleRes.ok && titleRes.title) {
        title = titleRes.title;
      } else {
        // Fallback to old behavior if LLM fails
        title = firstUser ? fallbackTitle : 'Chat';
      }
    } catch (err) {
      // Fallback to old behavior if API call fails
      title = firstUser ? fallbackTitle : 'Chat';
    }
  } else {
    // For existing chats, keep the existing title
    const existingChat = await window.api.historyList();
    const chatEntry = existingChat.find(c => c.id === currentChatId);
    if (chatEntry && chatEntry.title) {
      title = chatEntry.title;
    } else if (firstUser) {
      title = fallbackTitle;
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
      autoApprove: runsUnattended(),
      autoBranch: autoBranchToggle.checked,
      onlineResearch: onlineResearchToggle.checked,
      subModel,
      coderModel,
      runMetrics,
      contextState: contextRes.ok ? contextRes.state : { projectPath: '', pinnedFiles: [] },
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
  clearPendingPlan();
  const saved = res.chat;
  // Set this before any rendering or mode/directory synchronization so a
  // mission card can never be carried over from the previously open chat.
  currentChatId = chatId;
  onlineResearchToggle.checked = false; // loading history must never restore network access
  setAppMode(saved.mode === 'chat' ? 'chat' : 'code');

  // Push the stored conversation into the main process so the model continues from it.
  const lc = await window.api.loadConversation(saved.conversation, saved.model || modelSelect.value, saved.runMetrics, saved.contextState,
    { cwd: saved.cwd || cwd, mode: saved.mode === 'chat' ? 'chat' : 'code', onlineResearch: false });
  renderConversation(saved.conversation);
  updateContextBar(lc.approxTokens, lc.contextLength);
  compactWarned = false; // fresh warning budget for this chat
  hideStartupMessage();

  // Auto-select the model this chat was using; if it's gone from Ollama, keep the current one.
  if (saved.model && [...modelSelect.options].some((o) => o.value === saved.model)) {
    modelSelect.value = saved.model;
    activeModelPicker?.sync();
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


  loadChatHistory(); // refresh active highlight
  if (!cwdChanged) refreshGit();
}

async function deleteChat(chatId) {
  await window.api.historyDelete(chatId);
  loadChatHistory();

  // If we deleted the currently loaded chat, clear the conversation everywhere
  if (currentChatId === chatId) {
    await window.api.reset();
    clearPendingPlan(false);
    currentChatId = null;
    chat.innerHTML = '';
    missionCard = null;
    if (latestMission) upsertMissionCard(latestMission);
    toolCount = 0;
    $('tool-count').textContent = '0';
    $('ctx-tokens').textContent = '0';
    $('ctx-fill').style.width = '0%';
    setState('idle');
  }
}

function renderConversation(conversation) {
  chat.innerHTML = '';
  missionCard = null;
  conversation.forEach((msg, index) => {
    // Messages the app wrote to itself — the compaction block, a nudge back to
    // work — are not dialogue. Replaying them with YOU and MODEL labels claims
    // the user said things they never typed, and buries the real conversation
    // under bookkeeping. They stay visible, but folded and marked as machinery.
    if (msg.meta) {
      addContextBlock(msg);
      return;
    }
    if (msg.role === 'user') {
      const imgs = (msg.images || []).map((b, i) => `data:${msg.imageTypes?.[i] || 'image/png'};base64,${b}`);
      const shownText = msg.displayContent || (msg.attachments?.length ? '(attached files)' : msg.content) || (imgs.length ? '(image)' : '');
      addMessage('user', shownText, imgs, msg.attachments || [], { message: msg, index });
    } else if (msg.role === 'assistant') {
      if (msg.thinking) addThinkingBlock(msg.thinking, 'THOUGHTS ▸');
      if (msg.content) renderMarkdown(addMessage('assistant', '', null, [], { message: msg, index }), msg.content);
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
        decorateContextControls(card, msg, index);
        chat.appendChild(card);
      } else {
        const replayDisplay = window.ToolNames ? window.ToolNames.displayToolName(msg.tool_name) : msg.tool_name;
        addMessage('tool', `[${replayDisplay}] ` + (text.length > 300 ? text.slice(0, 300) + '…' : text), null, [], { message: msg, index });
      }
    }
  });
  if (latestMission) upsertMissionCard(latestMission);
}

// ---------- attachments ----------
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_SIZE = 15 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_TYPE_BY_EXTENSION = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};
const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts',
  'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs',
  'swift', 'kt', 'kts', 'sh', 'bash', 'zsh', 'sql', 'toml', 'ini', 'cfg', 'conf',
  'log', 'properties',
]);
let pendingImages = []; // { name, type, size, dataUrl }
let pendingFiles = []; // { name, type, size, dataUrl }
let pendingAttachmentReads = 0;

$('attach-btn').addEventListener('click', () => $('attach-file').click());

$('attach-file').addEventListener('change', (e) => {
  addAttachments(e.target.files);
  e.target.value = '';
});

input.addEventListener('paste', (e) => {
  const images = Array.from(e.clipboardData?.items || [])
    .filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!images.length) return;
  e.preventDefault();
  addAttachments(images);
});

// Dropping a file on an Electron page normally navigates the window to that
// file. Capture file drags at the document boundary, show one clear target,
// and feed the files into the same path as the ATTACH button and paste.
const attachmentDropOverlay = $('attachment-drop-overlay');
function showAttachmentDropOverlay(visible) {
  attachmentDropOverlay.classList.toggle('hidden', !visible);
  attachmentDropOverlay.setAttribute('aria-hidden', String(!visible));
}

document.addEventListener('dragenter', (e) => {
  if (!window.AttachmentDrop.hasFilePayload(e.dataTransfer)) return;
  e.preventDefault();
  showAttachmentDropOverlay(true);
});

document.addEventListener('dragover', (e) => {
  if (!window.AttachmentDrop.hasFilePayload(e.dataTransfer)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  showAttachmentDropOverlay(true);
});

document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget && document.documentElement.contains(e.relatedTarget)) return;
  showAttachmentDropOverlay(false);
});

document.addEventListener('drop', (e) => {
  if (!window.AttachmentDrop.hasFilePayload(e.dataTransfer)) return;
  e.preventDefault();
  showAttachmentDropOverlay(false);
  addAttachments(window.AttachmentDrop.filesFromTransfer(e.dataTransfer));
  input.focus();
});

window.addEventListener('blur', () => showAttachmentDropOverlay(false));
window.addEventListener('dragend', () => showAttachmentDropOverlay(false));

function attachmentCount() {
  return pendingImages.length + pendingFiles.length;
}

function attachmentSlotsUsed() {
  return attachmentCount() + pendingAttachmentReads;
}

function fileExtension(name) {
  const parts = String(name || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function addAttachment(file) {
  if (!file) return;
  if (attachmentSlotsUsed() >= MAX_ATTACHMENTS) return addError(`Attach at most ${MAX_ATTACHMENTS} files at once.`);
  if (!file.size) return addError(`${file.name || 'Attachment'} is empty.`);
  if (file.size > MAX_ATTACHMENT_SIZE) return addError(`${file.name || 'Attachment'} is larger than 15 MB.`);
  const fileType = String(file.type || '').toLowerCase();
  const inferredImageType = IMAGE_TYPE_BY_EXTENSION[fileExtension(file.name)] || '';
  const imageType = IMAGE_TYPES.has(fileType) ? fileType : inferredImageType;
  const isImage = !!imageType;
  const isDocument = fileType === 'application/pdf' || fileType.startsWith('text/') || DOCUMENT_EXTENSIONS.has(fileExtension(file.name));
  if (!isImage && !isDocument) return addError(`${file.name || 'Attachment'} is not a supported image, PDF, text, or code file.`);
  const reader = new FileReader();
  pendingAttachmentReads += 1;
  renderAttachmentPreview();
  reader.onload = () => {
    const attachment = {
      name: file.name || (isImage ? 'pasted-image' : 'attachment'),
      type: imageType || fileType || (fileExtension(file.name) === 'pdf' ? 'application/pdf' : 'text/plain'),
      size: file.size,
      dataUrl: reader.result,
    };
    (isImage ? pendingImages : pendingFiles).push(attachment);
  };
  reader.onerror = () => addError(`${file.name || 'Attachment'} could not be read.`);
  reader.onloadend = () => {
    pendingAttachmentReads = Math.max(0, pendingAttachmentReads - 1);
    renderAttachmentPreview();
  };
  try {
    reader.readAsDataURL(file);
  } catch (error) {
    pendingAttachmentReads = Math.max(0, pendingAttachmentReads - 1);
    renderAttachmentPreview();
    addError(`${file.name || 'Attachment'} could not be read: ${error.message || error}`);
  }
}

function addAttachments(files) {
  for (const file of Array.from(files || [])) {
    if (attachmentSlotsUsed() >= MAX_ATTACHMENTS) {
      addError(`Attach at most ${MAX_ATTACHMENTS} files at once.`);
      break;
    }
    addAttachment(file);
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderAttachmentPreview() {
  const strip = $('attachment-preview');
  strip.innerHTML = '';
  strip.classList.toggle('hidden', !attachmentCount() && !pendingAttachmentReads);
  pendingImages.forEach((attachment, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'img-thumb';
    const img = document.createElement('img');
    img.src = attachment.dataUrl;
    img.alt = attachment.name;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = `Remove ${attachment.name}`;
    x.addEventListener('click', () => {
      pendingImages.splice(index, 1);
      renderAttachmentPreview();
    });
    wrap.appendChild(img);
    wrap.appendChild(x);
    strip.appendChild(wrap);
  });
  pendingFiles.forEach((attachment, index) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    const details = document.createElement('span');
    details.className = 'file-chip-details';
    details.textContent = `${attachment.name} · ${formatFileSize(attachment.size)}`;
    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.title = `Remove ${attachment.name}`;
    remove.addEventListener('click', () => {
      pendingFiles.splice(index, 1);
      renderAttachmentPreview();
    });
    chip.appendChild(details);
    chip.appendChild(remove);
    strip.appendChild(chip);
  });
  if (pendingAttachmentReads) {
    const loading = document.createElement('div');
    loading.className = 'file-chip attachment-loading';
    loading.textContent = `Adding ${pendingAttachmentReads} attachment${pendingAttachmentReads === 1 ? '' : 's'}…`;
    strip.appendChild(loading);
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
  const missionControl = /^\/mission\s+(?:status|stop|resume)\s*$/i.test(text);
  if (pendingAttachmentReads) return addError('Wait for the attachment to finish loading.');
  if ((!text && !attachmentCount()) || (busy && !missionControl)) return;
  if (text.startsWith('/')) {
    input.value = '';
    if (text === '/help' || text.includes('/auto') || text.includes('/commit') || text.includes('/model') || text.includes('/subagent') || text.includes('/coder') || text.includes('/plan') || text.includes('/review') || text.includes('/orchestrate') || text.includes('/mission') || text.includes('/mcp')) {
      hideStartupMessage();
    }
    return handleSlash(text);
  }
  if (!modelSelect.value) return addError('No model selected — is Ollama running?');
  if (appMode === 'code' && !cwd) return addError('Pick a working directory first (DIR button, top left).');

  // Ollama wants raw base64 without the data-URL prefix
  const images = pendingImages.map((attachment) => attachment.dataUrl.split(',')[1]);
  const imageTypes = pendingImages.map((attachment) => attachment.type || 'image/png');
  const imageAttachments = pendingImages.map(({ name, type, size }) => ({ name, type, size }));
  const files = pendingFiles.map((attachment) => ({
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    data: attachment.dataUrl.split(',')[1],
  }));
  const shownImages = pendingImages.map((attachment) => attachment.dataUrl);
  const shownAttachments = [
    ...pendingImages.map(({ name, type, size }) => ({ name, type, size, kind: 'image' })),
    ...pendingFiles.map(({ name, type, size }) => ({ name, type, size, kind: type === 'application/pdf' ? 'pdf' : 'text' })),
  ];
  pendingImages = [];
  pendingFiles = [];
  renderAttachmentPreview();

  input.value = '';
  hideStartupMessage();
  addMessage('user', text || '(attached files)', shownImages, shownAttachments);
  startRun();

  const res = await window.api.send({
    model: modelSelect.value,
    subModel,
    text,
    mode: appMode,
    cwd: appMode === 'code' ? cwd : null,
    autoApprove: appMode === 'code' && runsUnattended(),
    autoBranch: appMode === 'code' && autoBranchToggle.checked,
    onlineResearch: onlineResearchToggle.checked,
    think: thinkToggle.checked,
    images,
    imageTypes,
    imageAttachments,
    files,
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
// Raw markdown source for the streaming bubble. Once we render markdown into
// the element its textContent is the *rendered* text, so the source has to be
// kept separately or every re-render would compound on its own output.
let currentAssistantRaw = '';
let mdRenderQueued = false;

// Render markdown safely. Falls back to plain text if the libs failed to load.
function renderMarkdown(el, text) {
  if (window.marked && window.DOMPurify) {
    const protectedMath = window.MathRenderer
      ? window.MathRenderer.protectMath(text)
      : { text, segments: [] };
    el.innerHTML = DOMPurify.sanitize(marked.parse(protectedMath.text, { async: false }));
    window.MathRenderer?.renderProtectedMath(el, protectedMath.segments, window.katex);
    el.classList.add('md'); // switches white-space handling from pre-wrap to normal
  } else {
    el.textContent = text;
  }
}

// Convert the streaming assistant bubble from plain text to rendered markdown.
function finalizeAssistant() {
  if (!currentAssistant) return;
  renderMarkdown(currentAssistant, currentAssistantRaw);
  currentAssistant = null;
  currentAssistantRaw = '';
}

// Re-render the streaming bubble as markdown, at most once per animation frame
// so a fast token stream cannot thrash innerHTML. An unclosed ``` fence mid
// stream is fine — marked renders the partial block and it settles as more
// tokens arrive.
function scheduleMarkdownRender() {
  if (mdRenderQueued || !currentAssistant) return;
  mdRenderQueued = true;
  requestAnimationFrame(() => {
    mdRenderQueued = false;
    if (!currentAssistant) return;
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
    renderMarkdown(currentAssistant, currentAssistantRaw);
    if (nearBottom) scrollDown();
  });
}

// Bookkeeping the app inserted into the transcript, folded away by default.
const META_LABELS = {
  compaction: 'CONTEXT — earlier conversation compacted',
  nudge: 'CONTEXT — the app prompted the model to continue',
};

function addContextBlock(msg) {
  const details = document.createElement('details');
  details.className = 'msg info context-block';
  const summary = document.createElement('summary');
  summary.textContent = META_LABELS[msg.meta] || 'CONTEXT';
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'context-block-body';
  renderMarkdown(body, String(msg.content || ''));
  details.appendChild(body);
  chat.appendChild(details);
  return details;
}

function addMessage(role, text, images, attachments = [], context = null) {
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
  if (context) decorateContextControls(div, context.message, context.index);
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
  const documents = attachments.filter((attachment) => attachment.kind !== 'image');
  if (documents.length) {
    const files = document.createElement('div');
    files.className = 'msg-files';
    for (const attachment of documents) {
      const chip = document.createElement('span');
      chip.className = 'msg-file';
      const details = [attachment.name, formatFileSize(Number(attachment.size) || 0)];
      if (attachment.pages) details.push(`${attachment.pages} pages`);
      if (attachment.truncated) details.push('truncated');
      chip.textContent = details.join(' · ');
      files.appendChild(chip);
    }
    div.appendChild(files);
  }
  chat.appendChild(div);
  scrollDown();
  return body;
}

function decorateContextControls(element, message, index) {
  if (!message || !Number.isInteger(index)) return;
  const canPin = message.role === 'user' || message.role === 'assistant';
  const canExclude = message.role === 'tool';
  if (!canPin && !canExclude) return;
  element.classList.toggle('context-pinned', !!message.pinned);
  element.classList.toggle('context-excluded', !!message.excludedFromInference);
  const actions = document.createElement('span');
  actions.className = 'context-actions';
  const addControl = (label, title, action, currentValue) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label(currentValue());
    button.title = title;
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (busy) return addError('Wait for the current run to finish before changing context controls.');
      const nextValue = !currentValue();
      const result = await window.api.contextControl({ action, index, value: nextValue });
      if (!result.ok) return addError(result.error);
      if (action === 'pin-message') message.pinned = nextValue;
      else message.excludedFromInference = nextValue;
      element.classList.toggle('context-pinned', !!message.pinned);
      element.classList.toggle('context-excluded', !!message.excludedFromInference);
      button.textContent = label(nextValue);
      await saveChat();
    });
    actions.appendChild(button);
  };
  if (canPin) addControl((value) => value ? 'UNPIN' : 'PIN', 'Keep this message in model context and through compaction.', 'pin-message', () => !!message.pinned);
  if (canExclude) addControl((value) => value ? 'INCLUDE' : 'EXCLUDE', 'Keep this tool result in visible history but remove its content from inference.', 'exclude-tool', () => !!message.excludedFromInference);
  element.appendChild(actions);
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

// Decision J: the log renders inline as one foldable block per run rather than
// as a panel. It costs far less UI, sits next to the run it describes, and
// survives a history reload for free.
function addDecisionLog({ runId, policy, decisions = [], deferred = [], parked = [], reportPath, transcriptPath }) {
  const counts = decisions.reduce((totals, entry) => {
    totals[entry.verdict] = (totals[entry.verdict] || 0) + 1;
    return totals;
  }, {});
  const summary = Object.entries(counts).map(([verdict, count]) => `${count} ${verdict}`).join(' · ') || 'no tool calls';

  const details = document.createElement('details');
  details.className = 'msg info decision-log';
  const heading = document.createElement('summary');
  const undecided = parked.filter((entry) => !entry.decision).length;
  heading.textContent = `AGENT RUN — ${policy} — ${summary}`
    + (deferred.length ? ` — ${deferred.length} needs review` : '')
    + (undecided ? ` — ${undecided} parked (/pending)` : '');
  details.appendChild(heading);

  const body = document.createElement('div');
  if (parked.length) {
    const tray = document.createElement('div');
    tray.className = 'needs-review';
    tray.textContent = 'Parked — the run is suspended until you decide (/pending):';
    const list = document.createElement('ul');
    for (const entry of parked) {
      const item = document.createElement('li');
      item.textContent = `${entry.name}${entry.target ? ` on ${entry.target}` : ''} — ${entry.reason}${entry.decision ? ` (${entry.decision})` : ''}`;
      list.appendChild(item);
    }
    tray.appendChild(list);
    body.appendChild(tray);
  }
  if (deferred.length) {
    const tray = document.createElement('div');
    tray.className = 'needs-review';
    tray.textContent = 'Not permitted for this unattended run:';
    const list = document.createElement('ul');
    for (const entry of deferred) {
      const item = document.createElement('li');
      item.textContent = `${entry.name}${entry.target ? ` on ${entry.target}` : ''} — ${entry.reason}`;
      list.appendChild(item);
    }
    tray.appendChild(list);
    body.appendChild(tray);
  }

  const log = document.createElement('pre');
  log.textContent = decisions
    .map((entry) => `${entry.verdict.padEnd(9)} ${entry.name}${entry.target ? ` ${entry.target}` : ''}`)
    .join('\n') || '(no tool calls)';
  body.appendChild(log);

  for (const [label, value] of [['Report', reportPath], ['Transcript', transcriptPath]]) {
    if (!value) continue;
    const line = document.createElement('div');
    line.className = 'decision-log-path';
    line.textContent = `${label}: ${value}`;
    body.appendChild(line);
  }

  details.appendChild(body);
  details.dataset.runId = runId;
  chat.appendChild(details);
  scrollDown();
}

$('setting-provider')?.addEventListener('change', () => syncProviderFields({ useDefaultEndpoint: true }));
$('settings-save-key')?.addEventListener('click', async () => {
  const field = $('setting-api-key');
  const res = await window.api.providerSetKey(field.value);
  field.value = '';
  if (!res.ok) { $('settings-key-status').textContent = res.error; return; }
  await syncProviderFields();
});

window.api.onRunDecisions(addDecisionLog);

// A run someone started from Discord or a trigger drives this window's output
// but not its controls, so without this the app sits at "idle" while text
// streams in, and the input stays enabled for a send that will be refused.
window.api.onExternalRun(({ active, origin, goal }) => {
  if (active) {
    startRun();
    setState(`${origin === 'heartbeat' ? 'heartbeat' : origin === 'trigger' ? 'trigger' : 'remote'} run`);
    addInfo(`A run started from ${origin === 'remote' ? 'Discord' : origin}: ${goal}`);
  } else {
    endRun();
  }
});

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
    const subDisplay = window.ToolNames ? window.ToolNames.displayToolName(d.name) : d.name;
    line.textContent = '· ' + subDisplay + '  ' + shortArgs(d.name, d.args || {});
    line.title = d.name;
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
    currentAssistantRaw = text;
    scheduleMarkdownRender();
  } else {
    currentAssistant.closest('.msg')?.remove();
    currentAssistant = null;
    currentAssistantRaw = '';
  }
});

// ---------- stream events ----------
window.api.onToken((t) => {
  finalizeThinking();
  if (!currentAssistant) { currentAssistant = addMessage('assistant', ''); currentAssistantRaw = ''; }
  currentAssistantRaw += t;
  scheduleMarkdownRender(); // live markdown, rather than raw text until the run ends
});

window.api.onToolCall(({ name, args }) => {
  finalizeThinking();
  finalizeAssistant(); // markdown-render the finished bubble; next tokens start a fresh one
  toolCount++;
  $('tool-count').textContent = String(toolCount);
  const displayName = window.ToolNames ? window.ToolNames.displayToolName(name) : name;
  setState('tool: ' + displayName);

  const card = document.createElement('div');
  card.className = 'tool';
  card.dataset.tool = name;
  const head = document.createElement('div');
  head.className = 'tool-head';
  head.innerHTML = `<span></span><span class="args"></span><span class="status">running…</span>`;
  const nameEl = head.firstElementChild;
  nameEl.textContent = displayName;
  nameEl.title = name;
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
  const warningAt = (appSettings?.compactThreshold || 0.7) * 100;
  fill.className = pct > 90 ? 'danger' : pct > warningAt ? 'warn' : '';
  fill.id = 'ctx-fill';
}

window.api.onStats(({ contextTokens, contextLength, tokPerSec, scope }) => {
  // The bar is the current persisted conversation. Provider and planner
  // samples describe one short-lived inference and can decrease because of
  // cache reuse or missing usage fields.
  const isConversation = scope === 'conversation' || !scope;
  if (isConversation) updateContextBar(contextTokens, contextLength);
  if (tokPerSec) $('tok-speed').textContent = tokPerSec.toFixed(1) + ' t/s';
  // Provider and planner context is short-lived. Warn only when the persisted
  // conversation itself needs compaction.
  if (isConversation && appSettings?.autoCompact === false && !compactWarned && contextTokens / contextLength > 0.8) {
    compactWarned = true;
    addInfo('Context is over 80% full — run /compact soon or the model will start losing the oldest messages (including its instructions).');
  }
});

window.api.onDone(() => {
  if (busy) setState('idle');
});

function missionStatusText(mission) {
  const elapsedEnd = mission.endedAt ? new Date(mission.endedAt).getTime() : Date.now();
  const elapsedStart = new Date(mission.startedAt || elapsedEnd).getTime();
  const elapsedSeconds = Math.max(0, Math.floor((elapsedEnd - elapsedStart) / 1000));
  const elapsed = elapsedSeconds >= 60
    ? `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`
    : `${elapsedSeconds}s`;
  return [
    `MISSION · ${String(mission.status || 'unknown').toUpperCase()}`,
    mission.goal || '(no goal recorded)',
    `Project: ${mission.projectPath || '(unknown)'}`,
    `Progress: ${mission.currentIteration || 0}/${mission.maxIterations || 0} · ${mission.currentPhase || 'unknown'} · ${elapsed}`,
    `Last event: ${mission.lastEvent || '(none)'}`,
  ].join('\n');
}

function normalizedMissionPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows paths are case-insensitive; leave POSIX paths untouched.
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function shouldDisplayMission(mission = latestMission) {
  return appMode === 'code'
    && !!cwd
    && !!currentChatId
    && mission?.chatId === currentChatId
    && !!mission?.projectPath
    && normalizedMissionPath(cwd) === normalizedMissionPath(mission.projectPath);
}

function clearMissionCard() {
  missionCard?.remove();
  missionCard = null;
}

function syncMissionCard() {
  if (!shouldDisplayMission()) return clearMissionCard();
  upsertMissionCard(latestMission);
}

function upsertMissionCard(mission) {
  if (!mission) return;
  latestMission = mission;
  if (!shouldDisplayMission(mission)) return clearMissionCard();
  if (!missionCard) {
    missionCard = document.createElement('section');
    missionCard.className = 'mission-card';
    missionCard.innerHTML = [
      '<div class="mission-head"><span class="mission-title">MISSION</span><span class="mission-status"></span></div>',
      '<div class="mission-goal"></div>',
      '<div class="mission-detail"></div>',
      '<div class="mission-event"></div>',
      '<div class="mission-actions"><button type="button" class="mini mission-refresh">STATUS</button><button type="button" class="mini mission-resume">RESUME</button><button type="button" class="mini mission-stop">STOP</button></div>',
    ].join('');
    missionCard.querySelector('.mission-refresh').addEventListener('click', async () => {
      const res = await window.api.missionGet();
      if (res.ok && res.mission) upsertMissionCard(res.mission);
    });
    missionCard.querySelector('.mission-stop').addEventListener('click', async () => {
      const res = await window.api.missionStop();
      if (!res.ok) addError(res.error);
    });
    missionCard.querySelector('.mission-resume').addEventListener('click', () => {
      input.value = '/mission resume';
      send();
    });
  }
  const projectName = String(mission.projectPath || '').split(/[\\/]/).filter(Boolean).pop() || '(unknown project)';
  missionCard.dataset.status = mission.status || 'unknown';
  missionCard.querySelector('.mission-status').textContent = String(mission.status || 'unknown').toUpperCase();
  missionCard.querySelector('.mission-goal').textContent = mission.goal || '(no goal recorded)';
  missionCard.querySelector('.mission-detail').textContent = `${projectName} · ${mission.currentIteration || 0}/${mission.maxIterations || 0} · ${mission.currentPhase || 'starting'}`;
  missionCard.querySelector('.mission-event').textContent = mission.lastEvent || '';
  missionCard.querySelector('.mission-stop').classList.toggle('hidden', mission.status !== 'running');
  missionCard.querySelector('.mission-resume').classList.toggle('hidden', mission.status !== 'interrupted');
  // appendChild moves an existing node, keeping the mission card alongside the
  // most recent work whenever the user refreshes it or the mission advances.
  chat.appendChild(missionCard);
}

window.api.onMissionUpdate((mission) => upsertMissionCard(mission));

function clearPendingPlan(removeCard = true) {
  if (removeCard) pendingPlanCard?.remove();
  pendingPlanCard = null;
  pendingPlanDraft = null;
}

async function runApprovedPlan(plan) {
  const draft = pendingPlanDraft;
  if (!draft) return { ok: false, error: 'This plan draft is no longer active.' };
  if (cwd !== draft.cwd) return { ok: false, error: 'The working directory changed. Create a new plan for this folder.' };
  if (!coderModel) return { ok: false, error: 'No coder model is selected. Use /coder <name> first.' };

  startRun();
  let result;
  try {
    result = await window.api.orchestrate({
      model: draft.plannerModel,
      coderModel,
      subModel,
      goal: draft.goal,
      cwd: draft.cwd,
      autoApprove: runsUnattended(),
      onlineResearch: draft.onlineResearch,
      think: thinkToggle.checked,
      plan,
    });
    if (result.stopped) addInfo('Approved plan stopped. You can edit it or run it again.');
    else if (result.report) renderMarkdown(addMessage('assistant', result.report), result.report);
    if (result.ok && !result.stopped) {
      pendingPlanDraft = null;
      pendingPlanCard = null;
      try {
        await saveChat();
      } catch (error) {
        addError('The plan ran, but the chat could not be saved: ' + (error.message || error));
      }
    }
    return result;
  } catch (error) {
    result = { ok: false, error: error.message || String(error) };
    return result;
  } finally {
    endRun();
  }
}

function showPlanDraft(draft) {
  clearPendingPlan();
  pendingPlanDraft = draft;
  pendingPlanCard = window.PlanDraftView.create({
    draft,
    onRun: runApprovedPlan,
    onCancel: () => {
      const wasPending = !!pendingPlanDraft;
      clearPendingPlan(false);
      if (wasPending) addInfo('PLAN: draft cancelled. No files were changed.');
    },
    onError: addError,
  });
  chat.appendChild(pendingPlanCard);
  scrollDown();
}

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

window.api.onApprovalRequest(({ id, name, args, network, sensitive, destructive, financial }) => {
  pendingApprovalId = id;
  const approvalDisplay = window.ToolNames ? window.ToolNames.displayToolName(name) : name;
  $('approval-tool').textContent = (financial ? '💳 SPENDING — ' : network ? 'ONLINE REQUEST — ' : sensitive ? 'SENSITIVE READ — ' : destructive ? 'DESTRUCTIVE — ' : 'APPROVE ') + approvalDisplay.toUpperCase() + '?';
  $('approval-detail').textContent =
    name === 'web_search' ? `This query will be sent to DuckDuckGo:\n\n${args.query}\n\nDomains: ${(args.allowed_domains || []).join(', ') || '(unrestricted)'}`
    : name === 'web_fetch' ? `This public URL will be requested and its text returned to the model:\n\n${args.url}`
    : name === 'get_environment_variables' ? `${args.reveal ? 'REVEAL RAW VALUE' : 'Inspect redacted metadata'}: ${args.name}\n\nRaw values, when revealed, are retained in chat history.`
    : name === 'list_processes' ? `Process command lines may contain credentials.\n\nFilter: ${args.pattern || '(all processes)'}`
    : name === 'read_file' && sensitive ? `This file may contain credentials or private key material. Its contents will be retained in chat history.\n\n${args.path}`
    : name === 'revert_to_last_commit' ? `Restore ${args.path || 'the entire working tree'} to HEAD.\n\nTracked changes will be saved in a recoverable named Git stash first.\nUntracked files: ${args.include_untracked ? 'INCLUDED — they will leave the working tree and enter the stash' : 'preserved'}\nIgnored files and submodule contents: preserved`
    : name === 'run_command' ? args.command
    : name === 'write_file' || name === 'append_file' ? `${args.path}\n\n${(args.content || '').slice(0, 600)}`
    : name === 'edit_file' ? `${args.path}\n\n- ${String(args.old_string || '').slice(0, 300)}\n+ ${String(args.new_string || '').slice(0, 300)}`
    : args.source ? `${args.source} → ${args.destination}`
    : String(args.path || JSON.stringify(args));
  if (financial) {
    $('approval-detail').textContent = 'This call looks like it moves money — approve only if you intend to spend.\n\n'
      + $('approval-detail').textContent;
  }
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
  "Ask questions, get answers, build amazing things",
  "Let's get to work"
];

const chatStartupMessages = [
  'What would you like to explore?',
  'Chat locally, or enable Online to search the web',
  'Ask a question without choosing a folder',
  'Ready when you are',
  'Pondering...'
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

const compactOptions = $('compact-options');
const compactOptionsButton = $('compact-options-btn');
const compactOptionsMenu = $('compact-options-menu');
function setCompactOptionsOpen(open) {
  compactOptions.classList.toggle('open', open);
  compactOptionsButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    const bounds = compactOptionsButton.getBoundingClientRect();
    compactOptionsMenu.style.top = `${Math.round(bounds.bottom + 6)}px`;
    compactOptionsMenu.style.right = `${Math.round(window.innerWidth - bounds.right)}px`;
  }
}
compactOptionsButton.addEventListener('click', (event) => {
  event.stopPropagation();
  setCompactOptionsOpen(!compactOptions.classList.contains('open'));
});
document.addEventListener('click', (event) => {
  if (!compactOptions.contains(event.target)) {
    setCompactOptionsOpen(false);
  }
});

async function newSession() {
  if (busy) return;
  await window.api.reset();
  clearPendingPlan(false);
  compactWarned = false;
  chat.innerHTML = '';
  missionCard = null;
  if (latestMission) upsertMissionCard(latestMission);
  toolCount = 0;
  $('tool-count').textContent = '0';
  $('ctx-tokens').textContent = '0';
  $('ctx-fill').style.width = '0%';
  setState('idle');
  currentChatId = null;
  applySessionDefaults();
  loadChatHistory(); // clear active highlight
  showStartupMessage();
}

$('new-btn').addEventListener('click', newSession);

async function showSettings() {
  if (!appSettings) {
    const res = await window.api.settingsGet();
    if (!res.ok) return addError(res.error || 'Could not load settings.');
    appSettings = res.settings;
    settingsDefaults = res.defaults;
  }
  fillSettingsForm(appSettings);
  $('settings-save-result').textContent = '';
  $('settings-test-result').textContent = '';
  $('settings-modal').classList.remove('hidden');
}

$('settings-btn').addEventListener('click', showSettings);

const settingModelFields = {
  'setting-chat-model': 'chatModel',
  'setting-code-model': 'codeModel',
  'setting-coder-model': 'coderModel',
  'setting-scout-model': 'scoutModel',
};

const settingModelPickers = Object.fromEntries(
  Object.keys(settingModelFields).map((id) => [id, window.ModelPicker?.create($(id), {
    emptyLabel: 'Automatic / last used',
    disableWhenEmpty: false,
  })])
);

// The cloud-only fields are hidden on a local provider rather than shown as
// dead inputs, and the key's status is read separately because the key itself
// never comes back to the renderer.
async function syncProviderFields({ useDefaultEndpoint = false } = {}) {
  const provider = $('setting-provider');
  const cloud = provider.value === 'openai';
  const defaultEndpoint = provider.selectedOptions[0]?.dataset.defaultEndpoint || '';
  $('setting-endpoint').placeholder = defaultEndpoint;
  if (useDefaultEndpoint && defaultEndpoint) $('setting-endpoint').value = defaultEndpoint;
  $('settings-cloud-fields').classList.toggle('hidden', !cloud);
  // The consequence belongs here, next to the choice, rather than inside the
  // dropdown option where it cannot be read once the menu closes.
  $('setting-provider-help').textContent = cloud
    ? 'Every message is sent to this endpoint, including the contents of files the agent reads.'
    : 'Inference runs on this machine. Nothing is sent anywhere.';
  if (!cloud) return;
  const state = await window.api.providerState();
  const status = $('settings-key-status');
  if (!state?.ok) { status.textContent = ''; return; }
  status.textContent = state.key.set
    ? `Key set (${state.key.hint})${state.key.encrypted ? '' : ' — stored as plain text: this system has no encrypted storage'}`
    : 'No key set yet.';
}

function populateSettingsModelSelects(source = appSettings || {}) {
  for (const [id, key] of Object.entries(settingModelFields)) {
    const select = $(id);
    if (!select) continue;
    const selected = source[key] || '';
    select.innerHTML = '';
    const automatic = document.createElement('option');
    automatic.value = '';
    automatic.textContent = 'Automatic / last used';
    select.appendChild(automatic);
    const names = [...currentModels];
    if (selected && !names.includes(selected)) names.unshift(selected);
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name + (currentModels.includes(name) ? '' : ' (not found)');
      select.appendChild(option);
    }
    select.value = selected;
    settingModelPickers[id]?.refresh(currentModelDetails);
  }
}

function setTemperatureSelect(id, value) {
  const select = $(id);
  const stringValue = String(value);
  if (![...select.options].some((option) => option.value === stringValue)) {
    const option = document.createElement('option');
    option.value = stringValue;
    option.textContent = `Custom (${stringValue})`;
    select.appendChild(option);
  }
  select.value = stringValue;
}

function fillSettingsForm(settings) {
  populateSettingsModelSelects(settings);
  $('setting-endpoint').value = settings.inferenceEndpoint;
  $('setting-provider').value = settings.provider === 'openai' ? 'openai' : 'ollama';
  $('setting-input-rate').value = settings.inputPerMillion || '';
  $('setting-output-rate').value = settings.outputPerMillion || '';
  syncProviderFields();
  const standardContexts = ['0', '8192', '16384', '32768', '65536', '131072'];
  const contextValue = String(settings.mainContextCap);
  $('setting-main-context').value = standardContexts.includes(contextValue) ? contextValue : 'custom';
  $('setting-main-context-custom').value = standardContexts.includes(contextValue) ? '' : contextValue;
  $('setting-main-context-custom').classList.toggle('hidden', $('setting-main-context').value !== 'custom');
  $('setting-auto-compact').checked = !!settings.autoCompact;
  $('setting-compact-threshold').value = Math.round(settings.compactThreshold * 100);
  $('setting-keep-alive').value = settings.keepAlive;
  setTemperatureSelect('setting-code-temperature', settings.codeTemperature);
  setTemperatureSelect('setting-chat-temperature', settings.chatTemperature);
  $('setting-default-mode').value = settings.defaultMode;
  $('setting-code-think').checked = !!settings.codeThink;
  $('setting-chat-think').checked = !!settings.chatThink;
  $('setting-sidebar-open').checked = !!settings.sidebarOpen;
  $('setting-auto-branch').checked = !!settings.autoBranch;
  $('setting-review-mode').checked = !!settings.reviewMode;
  $('setting-mcp-auto-approve').checked = !!settings.mcpAutoApprove;
  $('setting-max-agent-steps').value = settings.maxAgentSteps;
  $('setting-loop-iterations').value = settings.defaultLoopIterations;
  $('setting-coder-context').value = settings.coderContextCap;
  $('setting-scout-context').value = settings.scoutContextCap;
  $('setting-chat-instructions').value = settings.globalChatInstructions;
  $('setting-code-instructions').value = settings.globalCodeInstructions;
}

function settingsFromForm() {
  const selectedContext = $('setting-main-context').value;
  return {
    ...appSettings,
    inferenceEndpoint: $('setting-endpoint').value.trim(),
    provider: $('setting-provider').value === 'openai' ? 'openai' : 'ollama',
    inputPerMillion: Number($('setting-input-rate').value) || 0,
    outputPerMillion: Number($('setting-output-rate').value) || 0,
    mainContextCap: Number(selectedContext === 'custom' ? $('setting-main-context-custom').value : selectedContext),
    autoCompact: $('setting-auto-compact').checked,
    compactThreshold: Number($('setting-compact-threshold').value) / 100,
    keepAlive: $('setting-keep-alive').value,
    chatModel: $('setting-chat-model').value,
    codeModel: $('setting-code-model').value,
    coderModel: $('setting-coder-model').value,
    scoutModel: $('setting-scout-model').value,
    codeTemperature: Number($('setting-code-temperature').value),
    chatTemperature: Number($('setting-chat-temperature').value),
    defaultMode: $('setting-default-mode').value,
    codeThink: $('setting-code-think').checked,
    chatThink: $('setting-chat-think').checked,
    sidebarOpen: $('setting-sidebar-open').checked,
    autoBranch: $('setting-auto-branch').checked,
    reviewMode: $('setting-review-mode').checked,
    mcpAutoApprove: $('setting-mcp-auto-approve').checked,
    maxAgentSteps: Number($('setting-max-agent-steps').value),
    defaultLoopIterations: Number($('setting-loop-iterations').value),
    coderContextCap: Number($('setting-coder-context').value),
    scoutContextCap: Number($('setting-scout-context').value),
    globalChatInstructions: $('setting-chat-instructions').value,
    globalCodeInstructions: $('setting-code-instructions').value,
  };
}

function hideSettings() {
  $('settings-modal').classList.add('hidden');
}

$('setting-main-context').addEventListener('change', () => {
  $('setting-main-context-custom').classList.toggle('hidden', $('setting-main-context').value !== 'custom');
});

$('settings-test-endpoint').addEventListener('click', async () => {
  const status = $('settings-test-result');
  status.className = 'setting-status';
  status.textContent = 'Testing…';
  const res = await window.api.settingsTestEndpoint($('setting-endpoint').value, $('setting-provider').value);
  status.classList.add(res.ok ? 'ok' : 'error');
  status.textContent = res.ok ? `Connected — ${res.modelCount} model${res.modelCount === 1 ? '' : 's'} found.` : res.error;
});

$('settings-open-mcp').addEventListener('click', async () => {
  const status = $('settings-mcp-result');
  status.className = 'setting-status';
  status.textContent = 'Opening…';
  const res = await window.api.mcpOpenConfig();
  status.classList.add(res.ok ? 'ok' : 'error');
  status.textContent = res.ok ? 'Revealed in Finder: ' + res.configPath : res.error;
});

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('settings-save-result');
  status.className = 'setting-status';
  status.textContent = 'Saving…';
  const next = settingsFromForm();
  const oldEndpoint = appSettings.inferenceEndpoint;
  const oldProvider = appSettings.provider;
  const res = await window.api.settingsSave(next);
  if (!res.ok) {
    status.classList.add('error');
    status.textContent = res.error;
    return;
  }
  appSettings = res.settings;
  coderModel = appSettings.coderModel || coderModel;
  subModel = appSettings.scoutModel || subModel;
  if (oldEndpoint !== appSettings.inferenceEndpoint || oldProvider !== appSettings.provider) {
    await reloadModels(defaultModelForMode(appMode));
  }
  applySessionDefaults();
  hideSettings();
  addInfo('Settings saved. New inference and agent requests will use them.');
  hideStartupMessage();
});

$('settings-reset').addEventListener('click', () => fillSettingsForm(settingsDefaults));
$('settings-cancel').addEventListener('click', hideSettings);
$('settings-close').addEventListener('click', hideSettings);
$('settings-modal').addEventListener('click', (event) => {
  if (event.target.id === 'settings-modal') hideSettings();
});

// ---------- slash commands ----------
const SLASH_HELP = [
  '/help — show this list',
  '/clear — start a new session',
  '/compact — summarize the conversation to free up context',
  '/diff — show the git diff for the working directory',
  '/commit <message> — stage all changes and commit',
  '/graph — show a visual tree of the git commit history',
  '/loop [n] <goal> — repeat a single model until verified',
  '/plan <goal> — inspect the project and approve or edit a plan before coding',
  '/review [base] — run a structured read-only review and send selected findings to the coder',
  '/orchestrate <goal> — planner inspects and delegates sequential implementation tasks to the selected coder model',
  '/mission [iterations] <goal> — run a persisted coding mission; use status, stop, or resume',
  '/model <name> — switch model (partial match ok)',
  '/coder [name] — show or set the writable coding-worker model (partial match ok)',
  '/subagent [name] — show or set the subagent/verifier model (partial match ok)',
  '/usage — show how context and tokens have been spent across all agents',
  '/mcp [on|off <server>] — external MCP tool servers: status, enable, disable',
  '/context — show exactly what will be sent to the model next turn (system prompt, per-message tokens, eviction flags)',
  '/pin [list|message <n>|file <path>] — keep important messages or project files in context',
  '/unpin <message <n>|file <path>> — remove a context pin',
  '/exclude <n> — omit a noisy tool result from inference without deleting it',
  '/include <n> — restore an excluded tool result to inference',
  '/recs — compare installed models for this computer',
  '/auto <request> — select the best compatible installed model and run the request',
  '/agent [--policy <name>] <goal> — run unattended: always branched, always checkpointed, always reported',
  '/agent trigger [list|new|run <id>|enable <id>|disable <id>] — scheduled unattended runs; enable/disable are for project (.brittain) triggers',
  '/agent daemon [status|start|stop|install|uninstall] — the headless runtime that keeps triggers firing with the app closed',
  '/pending [approve|deny [<run>] [n|all]|resume [<run>]] — parked calls from suspended unattended runs; the run id is optional when only one is waiting',
  '/policies [edit|promote <policy> <tool>] — autonomy policies, held calls, and evidence-backed promotion suggestions',
  '/provider — which endpoint runs inference, whether a key is set, and what a run costs',
  '/discord [edit] — bridge a Discord bot to the agent so it is reachable from a phone',
  '/workspace [init] — the project\'s .brittain folder: in-repo memory, heartbeat checklist, project triggers',
  '/memory [move] — view what the agent has remembered; move relocates it into the project (.brittain/MEMORY.md)',
  '/ledger — view what this session changed, ran, and failed at (kept across compaction)',
  '/export — save this chat as a markdown file',
  '/tools — list all available tools',
].join('\n');

const CHAT_SLASH_HELP = [
  '/help — show this list',
  '/clear — start a new session',
  '/compact — summarize the conversation to free up context',
  '/model <name> — switch model (partial match ok)',
  '/usage — show context and token usage',
  '/mcp [on|off <server>] - external MCP tool servers: status, enable, disable',
  '/context — show exactly what will be sent to the model next turn (system prompt, per-message tokens, eviction flags)',
  '/pin [list|message <n>] — keep important messages in context',
  '/unpin message <n> — remove a message pin',
  '/exclude <n> — omit a noisy tool result from inference without deleting it',
  '/include <n> — restore an excluded tool result to inference',
  '/recs — compare installed models for this computer',
  '/auto <request> — select the best compatible installed model and run the request',
  '/memory — view user-wide lessons remembered in folder-free Chat mode',
  '/export — save this chat as a markdown file',
  '/tools — list tools available to the app',
].join('\n');

async function handleSlash(raw) {
  const [cmd, ...rest] = raw.slice(1).split(' ');
  const arg = rest.join(' ').trim();
  const normalizedCmd = cmd.toLowerCase();
  const codeOnlyCommands = new Set(['diff', 'graph', 'loop', 'plan', 'review', 'orchestrate', 'mission', 'commit', 'coder', 'subagent', 'memory', 'ledger', 'agent']);
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
      addInfo(res.degraded
        ? `Compacted, but the model could not produce a usable summary — only the most recent turns were kept. ${res.description}`
        : `Conversation compacted. ${res.description}`);
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
      let iterations = appSettings?.defaultLoopIterations || 8;
      let goal = arg;
      const m = goal.match(/^(\d+)\s+([\s\S]+)/);
      if (m) { iterations = parseInt(m[1], 10); goal = m[2].trim(); }
      if (!goal) return addError('Usage: /loop [iterations] <goal> — e.g. /loop 10 make all tests pass');
      if (!runsUnattended()) addInfo('Heads up: autonomy is set to ' + (autonomyPolicies.find((entry) => entry.id === autonomyPolicy)?.label || autonomyPolicy) + ', so the loop will pause for approval. Pick a less supervised policy for unattended runs.');

      addMessage('user', `LOOP (max ${iterations}): ${goal}`);
      startRun();
      try {
        const res = await window.api.loop({
          model: modelSelect.value,
          subModel,
          goal,
          cwd,
          autoApprove: runsUnattended(),
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

    case 'plan': {
      if (busy) return;
      if (!modelSelect.value) return addError('No planner model selected.');
      if (!cwd) return addError('Pick a working directory first (DIR button, top left).');
      if (!arg) return addError('Usage: /plan <goal>');

      const plannerModel = modelSelect.value;
      const planCwd = cwd;
      const planSubModel = subModel;
      const planOnlineResearch = onlineResearchToggle.checked;
      const planThink = thinkToggle.checked;
      startRun();
      let result;
      try {
        result = await window.api.plan({
          model: plannerModel,
          subModel: planSubModel,
          goal: arg,
          cwd: planCwd,
          onlineResearch: planOnlineResearch,
          think: planThink,
        });
      } catch (error) {
        result = { ok: false, error: error.message || String(error) };
      } finally {
        endRun();
      }
      if (!result.ok) return addError('Planning failed: ' + result.error);
      if (result.stopped) return addInfo('Planning stopped. No files were changed.');
      if (cwd !== planCwd) return addError('The working directory changed while planning. Run /plan again for the current folder.');
      showPlanDraft({
        goal: arg,
        plan: result.plan,
        cwd: planCwd,
        plannerModel,
        onlineResearch: planOnlineResearch,
      });
      return;
    }

    case 'review': {
      if (busy) return;
      if (!modelSelect.value) return addError('No reviewer model selected.');
      if (!cwd) return addError('Pick a working directory first (DIR button, top left).');
      const reviewCwd = cwd;
      startRun();
      let result;
      try {
        result = await window.api.review({ model: modelSelect.value, cwd: reviewCwd, base: arg || 'HEAD' });
      } catch (error) {
        result = { ok: false, error: error.message || String(error) };
      } finally {
        endRun();
      }
      if (!result.ok) return addError('Review failed: ' + result.error);
      if (result.stopped) return addInfo('Review stopped. No files were changed.');
      if (cwd !== reviewCwd) return addError('The working directory changed while reviewing. Run /review again.');
      const card = window.ReviewFindings.create(result.review, {
        onSend: async (selected, reviewCard) => {
          startRun();
          let fixResult;
          try {
            fixResult = await window.api.reviewFix({
              coderModel,
              cwd: reviewCwd,
              findings: selected.map((finding) => ({ ...finding, suggested_fix: finding.suggestedFix })),
              autoApprove: runsUnattended(),
              autoBranch: autoBranchToggle.checked,
              think: thinkToggle.checked,
            });
          } catch (error) {
            fixResult = { ok: false, error: error.message || String(error) };
          } finally {
            endRun();
          }
          if (!fixResult.ok) return addError('Coder failed: ' + fixResult.error);
          reviewCard.remove();
          if (fixResult.report) renderMarkdown(addMessage('assistant', fixResult.report), fixResult.report);
          await refreshGit();
          return saveChat();
        },
      });
      chat.appendChild(card);
      chat.scrollTop = chat.scrollHeight;
      return;
    }

    case 'orchestrate': {
      if (busy) return;
      if (!modelSelect.value) return addError('No orchestrator model selected.');
      if (!coderModel) return addError('No coder model selected. Use /coder <name>.');
      if (!cwd) return addError('Pick a working directory first (DIR button, top left).');
      if (!arg) return addError('Usage: /orchestrate <goal>');
      if (!runsUnattended()) addInfo('Autonomy is supervised, so the coding worker will pause for file writes and commands; online requests always require separate approval.');

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
          autoApprove: runsUnattended(),
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

    case 'mission': {
      const command = arg.toLowerCase();
      if (command === 'status') {
        const res = await window.api.missionGet();
        if (!res.ok || !res.mission) return addInfo('No mission has been started in this app profile.');
        upsertMissionCard(res.mission);
        return addInfo(missionStatusText(res.mission));
      }
      if (command === 'stop') {
        const res = await window.api.missionStop();
        return res.ok ? addInfo('Mission stop requested.') : addError(res.error);
      }
      if (command === 'resume') {
        if (busy) return;
        if (!cwd) return addError('Pick the saved mission directory first.');
        if (!currentChatId) return addError('Open the chat that started the mission first.');
        startRun();
        try {
          const res = await window.api.missionResume({
            cwd,
            chatId: currentChatId,
            autoApprove: runsUnattended(),
            onlineResearch: onlineResearchToggle.checked,
            think: thinkToggle.checked,
          });
          if (!res.ok) addError(res.error);
          else if (res.report) renderMarkdown(addMessage('assistant', res.report), res.report);
        } catch (error) {
          addError('Mission resume failed: ' + (error.message || error));
        } finally {
          endRun();
        }
        return saveChat();
      }
      if (busy) return;
      if (!modelSelect.value) return addError('No model selected.');
      if (!coderModel) return addError('No coder model selected. Use /coder <name>.');
      if (!cwd) return addError('Pick a working directory first (DIR button, top left).');
      let iterations = appSettings?.defaultLoopIterations || 8;
      let goal = arg;
      const match = goal.match(/^(\d+)\s+([\s\S]+)/);
      if (match) { iterations = parseInt(match[1], 10); goal = match[2].trim(); }
      if (!goal) return addError('Usage: /mission [iterations] <goal> — e.g. /mission 12 add CSV export and verify it');
      if (!runsUnattended()) addInfo('Heads up: autonomy is set to ' + (autonomyPolicies.find((entry) => entry.id === autonomyPolicy)?.label || autonomyPolicy) + ', so the mission will pause for approval. Pick a less supervised policy for unattended runs.');

      // A mission belongs to the chat that started it, not every chat in its
      // project. Allocate an ID now because a new chat is normally saved only
      // after the mission command has completed.
      if (!currentChatId) currentChatId = Date.now().toString();
      addMessage('user', `MISSION (max ${iterations}): ${goal}`);
      startRun();
      try {
        const res = await window.api.missionStart({
          model: modelSelect.value,
          coderModel,
          subModel,
          goal,
          cwd,
          autoApprove: runsUnattended(),
          autoBranch: autoBranchToggle.checked,
          onlineResearch: onlineResearchToggle.checked,
          think: thinkToggle.checked,
          maxIterations: iterations,
          chatId: currentChatId,
        });
        if (!res.ok) addError(res.error);
        else if (res.report) renderMarkdown(addMessage('assistant', res.report), res.report);
      } catch (err) {
        addError('Mission failed: ' + (err.message || err));
      } finally {
        endRun();
      }
      return saveChat();
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
      modelSelect.dispatchEvent(new Event('change'));
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
      if (!arg) return addInfo(`Coder model: ${coderModel}\nAvailable: ${models.join(', ')}\nUse /coder <name> to change. Run /recs after installing a new Ollama model to refresh the list.`);
      const match = models.find((v) => v.includes(arg));
      if (!match) return addError(`No installed model matching "${arg}". If Ollama just finished installing it, run /recs to refresh the model list.`);
      coderModel = match;
      localStorage.setItem('coderModel', match);
      return addInfo('Coder model set to ' + match);
    }

    case 'mcp': {
      const st = await window.api.mcpStatus();
      if (!arg) {
        if (!st.servers.length) return addInfo('No MCP servers configured.\nAdd them to ' + st.configPath + ' (same format as Claude Desktop) and restart the app.');
        const lines = st.servers.flatMap((sv) => {
          const row = `${sv.enabled ? '●' : '○'} ${sv.name} — ${sv.status}, ${sv.tools} tool${sv.tools === 1 ? '' : 's'}${sv.error ? ' — ' + sv.error : ''}`;
          // Where a server writes anything it saves. Worth showing: a screenshot
          // the model took is only useful if you can find it.
          return sv.workingDirectory ? [row, `    files: ${sv.workingDirectory}`] : [row];
        });
        return addInfo('MCP servers (● enabled / ○ disabled):\n' + lines.join('\n') + '\nMCP calls require approval unless "Auto-approve all MCP tool calls" is enabled in Settings.\nConfig: ' + st.configPath);
      }
      const m = arg.match(/^(on|off)\s+(.+)$/);
      if (!m) return addError('Usage: /mcp, /mcp on <server>, or /mcp off <server>');
      const res = await window.api.mcpToggle(m[2].trim(), m[1] === 'on');
      return res.ok ? addInfo(`MCP server "${m[2].trim()}" ${m[1] === 'on' ? 'enabled' : 'disabled'} for this session.`) : addError(res.error);
    }

    case 'context': {
      await showContextInspector();
      return;
    }

    case 'pin':
    case 'unpin': {
      if (busy) return addError('Wait for the current run to finish before changing context controls.');
      const pinning = normalizedCmd === 'pin';
      if (!arg || arg.toLowerCase() === 'list') {
        const [conversation, stateRes] = await Promise.all([window.api.getConversation(), window.api.contextState()]);
        const pinnedMessages = conversation
          .map((message, index) => message.pinned ? `${index + 1} (${message.role})` : '')
          .filter(Boolean);
        const excludedTools = conversation
          .map((message, index) => message.excludedFromInference ? `${index + 1} (${(window.ToolNames ? window.ToolNames.displayToolName(message.tool_name) : message.tool_name) || 'tool'})` : '')
          .filter(Boolean);
        return addInfo([
          `Pinned messages: ${pinnedMessages.join(', ') || '(none)'}`,
          `Pinned files: ${stateRes.state?.pinnedFiles?.join(', ') || '(none)'}`,
          `Excluded tool results: ${excludedTools.join(', ') || '(none)'}`,
          'Use /context to inspect message numbers and token sizes.',
        ].join('\n'));
      }
      const messageMatch = arg.match(/^message\s+(\d+)$/i);
      const fileMatch = arg.match(/^file\s+(.+)$/i);
      let payload;
      let label;
      if (messageMatch) {
        payload = { action: 'pin-message', index: Number(messageMatch[1]) - 1, value: pinning };
        label = `Message ${messageMatch[1]} ${pinning ? 'pinned' : 'unpinned'}.`;
      } else if (fileMatch) {
        if (appMode !== 'code') return addError('Project files can be pinned only in Code mode.');
        if (!cwd) return addError('Pick a working directory first.');
        payload = { action: pinning ? 'pin-file' : 'unpin-file', cwd, path: fileMatch[1].trim() };
        label = `${fileMatch[1].trim()} ${pinning ? 'pinned' : 'unpinned'}.`;
      } else {
        return addError(`Usage: /${normalizedCmd} message <number>${appMode === 'code' ? ` or /${normalizedCmd} file <path>` : ''}`);
      }
      const result = await window.api.contextControl(payload);
      if (!result.ok) return addError(result.error);
      renderConversation(result.conversation);
      addInfo(label);
      await saveChat();
      return;
    }

    case 'exclude':
    case 'include': {
      if (busy) return addError('Wait for the current run to finish before changing context controls.');
      if (!/^\d+$/.test(arg)) return addError(`Usage: /${normalizedCmd} <tool-result message number>`);
      const value = normalizedCmd === 'exclude';
      const result = await window.api.contextControl({ action: 'exclude-tool', index: Number(arg) - 1, value });
      if (!result.ok) return addError(result.error);
      renderConversation(result.conversation);
      addInfo(`Tool result ${arg} ${value ? 'excluded from' : 'restored to'} inference. Visible history was not changed.`);
      await saveChat();
      return;
    }

    case 'recs': {
      if (busy) return addError('Wait for the current run to finish before checking model recommendations.');
      setState('checking models…');
      try {
        await reloadModels(modelSelect.value);
        const res = await window.api.getModelRecommendations(appMode);
        if (!res.ok) return addError(res.error);
        if (!res.models.length) return addInfo('No installed models or reference recommendations were found.');
        return showRecommendations(res);
      } catch (err) {
        return addError('Could not load model recommendations: ' + (err.message || err));
      } finally {
        setState('idle');
      }
    }

    case 'auto': {
      if (busy) return;
      if (!arg) return addError('Usage: /auto <request>');
      if (appMode === 'code' && !cwd) return addError('Pick a working directory first (DIR button, top left).');
      setState('selecting model…');
      let route;
      try {
        route = await window.api.autoRouteModel({
          mode: appMode,
          needsVision: pendingImages.length > 0,
        });
      } catch (err) {
        route = { ok: false, error: err.message || String(err) };
      } finally {
        setState('idle');
      }
      if (!route.ok) return addError('AUTO could not select a model: ' + route.error);
      if (!currentModels.includes(route.model)) return addError(`AUTO selected "${route.model}", but it is not in the current installed-model list.`);
      modelSelect.value = route.model;
      modelSelect.dispatchEvent(new Event('change'));
      addInfo(`AUTO selected ${route.model} — ${route.reason}.${route.warning ? `\nWarning: ${route.warning}` : ''}`);
      input.value = arg;
      return send();
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

    case 'provider': {
      const state = await window.api.providerState();
      if (!state.ok) return addError('Could not read the provider settings.');

      const cloud = state.provider === 'openai';
      const lines = ['INFERENCE PROVIDER', ''];
      lines.push(`Provider: ${cloud ? 'openai-compatible (cloud)' : 'ollama (local)'}`);
      lines.push(`Endpoint: ${state.endpoint}`);
      if (cloud) {
        lines.push(`API key:  ${state.key.set ? `set (${state.key.hint})${state.key.encrypted ? ', encrypted' : ', PLAIN TEXT'}` : 'NOT SET — runs will be rejected'}`);
        if (state.rates.inputPerMillion || state.rates.outputPerMillion) {
          lines.push(`Rates:    $${state.rates.inputPerMillion}/M in, $${state.rates.outputPerMillion}/M out`);
        } else {
          lines.push('Rates:    not set — set them in Settings to see what a run costs');
        }
      }
      lines.push('',
        cloud
          ? 'EVERY message in this mode leaves your machine and is sent to that endpoint.'
          : 'Nothing leaves your machine: inference runs locally.',
        cloud
          ? 'That includes file contents the agent reads, which — with policy roots or MCP servers'
          : 'Online research is still a separate, opt-in switch.',
        cloud ? 'configured — can reach well beyond the project folder.' : '');
      lines.push('', 'Change any of this in Settings. The key is stored there too, and is never shown in full again.');
      return showOverlay('INFERENCE PROVIDER', lines.filter((line) => line !== undefined).join('\n'));
    }

    case 'discord': {
      const state = await window.api.discordState();
      if (!state.ok) return addError('Could not read the Discord bridge state.');
      if (arg === 'edit' || arg === 'setup') {
        const opened = await window.api.discordOpenConfig();
        return addInfo(`Edit ${opened.path}, then restart Brittain Code to connect. The bridge runs inside the app — no separate process to start.`);
      }
      const lines = ['DISCORD BRIDGE', ''];
      lines.push(`Config:  ${state.configPath}`);
      if (state.error) lines.push(`         (could not be read: ${state.error})`);
      // "The bridge is running" and "Discord accepted us" are different facts,
      // and reporting them as one turned a rejected connection into a
      // confident-looking "connected".
      const gateway = state.identity?.state;
      const status = !state.enabled ? 'disabled in discord.json'
        : !state.running ? (state.daemonOwns
          ? 'the daemon owns the connection — check its log, not this window'
          : 'enabled, but nothing is running it yet (restart Brittain Code)')
        : gateway === 'ready' ? 'connected'
        : gateway === 'failed' ? 'REFUSED by Discord'
        : gateway === 'closed' ? 'disconnected, retrying'
        : 'connecting…';
      lines.push(`Status:  ${status}`);
      if (state.identity?.lastError) lines.push(`         ${state.identity.lastError}`);
      if (state.missing?.length) lines.push(`Missing: ${state.missing.join(', ')}`);
      if (state.cwd) lines.push(`Runs in: ${state.cwd} under "${state.policy}"`);
      if (state.notifyChannel) lines.push(`Notifies: channel ${state.notifyChannel}`);
      if (state.identity?.username) lines.push(`Bot:      ${state.identity.username}, in ${state.identity.guilds} server(s)`);
      // Being in no server is the usual reason a bot cannot be reached at all:
      // Discord refuses to open a DM between two accounts with nothing in common.
      if (state.identity && state.identity.guilds === 0) {
        lines.push('',
          '⚠ This bot is in no servers, so Discord will not let you DM it.',
          '  Invite it: Developer Portal → your app → OAuth2 → URL Generator →',
          '  scopes: bot, permissions: Send Messages + Read Message History.',
          '  Open the generated URL and add it to any server you are in.');
      }
      // No READY means Discord never accepted the connection. The reason is on
      // the close frame, which the bridge now reports rather than looping on.
      if (state.running && state.identity && state.identity.guilds === null && gateway !== 'failed') {
        lines.push('', 'Discord has not accepted the connection yet. If this does not clear in a few',
          'seconds, the usual causes are the Message Content intent being off, or a stale token.');
      }
      lines.push('',
        'Message the bot a goal and it runs unattended; a parked call comes back to you',
        'as a message you can approve from anywhere. !help lists the commands.',
        '',
        'The bridge runs inside the app or the daemon — whichever owns the trigger',
        'scheduler — so there is no separate process to keep alive.',
        '',
        '/discord edit opens the config. Changes take effect on restart.');
      return showOverlay('DISCORD BRIDGE', lines.join('\n'));
    }

    case 'workspace': {
      if (!cwd) return addError('Pick a working directory first (DIR button, top left).');
      if (arg === 'init') {
        const res = await window.api.workspaceInit(cwd);
        if (!res.ok) return addError(res.error);
        const lines = [
          res.alreadyPresent
            ? `${res.dir} already exists.`
            : `Created ${res.dir}${res.created.length ? ` (${res.created.join(', ')})` : ''}.`,
        ];
        if (res.moved) lines.push(`Carried ${res.moved} remembered line(s) in from app data; the old copy is left as a backup.`);
        lines.push(
          'Project memory now lives in the repository, so it shows up in diffs — review it like any other change.',
          `A heartbeat trigger ships with it, inert: write a checklist item in ${res.heartbeatPath}, then turn it on with /agent trigger enable heartbeat.`,
        );
        return addInfo(lines.join(' '));
      }
      const state = await window.api.workspaceState(cwd);
      if (!state.ok) return addError(state.error);
      if (!state.exists) {
        return showOverlay('PROJECT WORKSPACE', [
          `No workspace in this project (${state.dir} does not exist).`,
          '',
          'Memory for this project is kept in app data instead:',
          `  ${state.memoryPath}`,
          '',
          '/workspace init creates .brittain/ and moves memory into the repository, where it',
          'shows up in diffs and travels with a clone. It also adds HEARTBEAT.md, the checklist',
          'a heartbeat run evaluates. Nothing creates this folder automatically — putting agent',
          'memory under version control is your call.',
        ].join('\n'));
      }
      return showOverlay('PROJECT WORKSPACE — ' + state.dir, [
        `Memory:    ${state.memoryPath}`,
        `Heartbeat: ${state.heartbeatPath} (${state.heartbeatItems} checklist item(s))`,
        '',
        'MEMORY.md, HEARTBEAT.md, triggers.json and autonomy.json are meant to be committed.',
        'state.json and runs/ are gitignored.',
        '',
        'In-repo config can only narrow autonomy, never widen it, and project triggers arrive',
        'disabled — these files can reach you through a pull request.',
      ].join('\n'));
    }

    case 'memory': {
      const memoryCwd = appMode === 'chat' ? null : cwd;
      if (appMode !== 'chat' && !memoryCwd) return addError('Pick a working directory first (DIR button, top left).');
      if (arg === 'move') {
        if (!memoryCwd) return addError('Folder-free Chat memory is user-wide and cannot move into a project.');
        const moved = await window.api.memoryMove(memoryCwd);
        if (!moved.ok) return addError(moved.error);
        return addInfo(`Project memory now lives in ${moved.path} (${moved.moved} line(s) copied in`
          + (moved.created.length ? `; created ${moved.created.join(', ')}` : '') + '). '
          + 'The app-data copy remains as a backup. .brittain/MEMORY.md is meant to be committed — review it like any other change.');
      }
      const res = await window.api.memoryGet(memoryCwd);
      if (!res.ok) return addError(res.error);
      let content = res.content.trim() || (res.globalChat
        ? '(nothing remembered for folder-free Chat mode yet)'
        : '(nothing remembered for this project yet)');
      if (res.inRepo) content = '(in-repo: .brittain/MEMORY.md)\n\n' + content;
      if (res.legacyContent?.trim()) {
        content += `\n\nLEGACY UNIVERSAL MEMORY (not injected)\n${res.legacyPath}\n\n${res.legacyContent.trim()}`;
      }
      return showOverlay((res.globalChat ? 'CHAT MEMORY — ' : 'PROJECT MEMORY — ') + res.path, content);
    }

    case 'agent': {
      if (busy) return;
      if (!modelSelect.value) return addError('No model selected.');
      if (!cwd) return addError('Pick a working directory first (DIR button, top left).');

      // Triggers are authored in a file, the way mcp.json already is: entering
      // agent mode there is a setup act, not a session act.
      if (/^daemon\b/.test(arg)) {
        const [, sub = 'status'] = arg.split(/\s+/);
        if (sub === 'install') {
          const res = await window.api.daemonInstall();
          return res.ok
            ? addInfo(`Daemon installed: ${res.plistPath}. It runs headless at login and owns the trigger scheduler; this window stops ticking triggers once it is alive.`)
            : addError(res.error);
        }
        if (sub === 'uninstall') {
          const res = await window.api.daemonUninstall();
          return res.ok ? addInfo('Daemon stopped and uninstalled. It will not return at login.') : addError(res.error);
        }
        if (sub === 'start' || sub === 'restart') {
          const res = await window.api.daemonStart();
          return res.ok
            ? addInfo('Daemon is running and answering. It owns the trigger scheduler and the Discord bridge from here on.')
            : addError(res.error);
        }
        if (sub === 'stop') {
          const res = await window.api.daemonStop();
          if (!res.ok) return addError(res.error);
          return addInfo(res.wasLoaded
            ? 'Daemon stopped. Triggers and the Discord bridge move back to this window; /agent daemon start brings it back.'
            : 'Daemon was not running. Nothing to stop.');
        }
        const res = await window.api.daemonStatus();
        return showOverlay('AGENT DAEMON', [
          `Alive: ${res.alive ? 'yes' : 'no'}`,
          `Socket: ${res.socketPath}`,
          res.launchAgent ? `LaunchAgent: ${res.launchAgent} (${res.installed ? 'installed' : 'not installed'})` : 'LaunchAgent: macOS only',
          '',
          'The daemon is the headless runtime: triggers and heartbeats keep firing with every window closed.',
          '/agent daemon install to set it up (opt-in; runs at login).',
          '/agent daemon start · stop — control it without reinstalling.',
        ].join('\n'));
      }

      if (/^trigger\b/.test(arg)) {
        const [, sub = 'list', id = ''] = arg.split(/\s+/);
        if (sub === 'new' || sub === 'edit') {
          const opened = await window.api.triggersOpenConfig();
          return addInfo(`Edit triggers in ${opened.path}, then reload with /agent trigger list.`);
        }
        if (sub === 'run') {
          if (!id) return addError('Usage: /agent trigger run <id>');
          startRun();
          let res;
          try { res = await window.api.triggersRun(id); } finally { endRun(); }
          return res.ok ? saveChat() : addError(res.error);
        }
        if (sub === 'enable' || sub === 'disable') {
          if (!id) return addError(`Usage: /agent trigger ${sub} <id> — acts on this project's .brittain/triggers.json entries.`);
          const res = sub === 'enable'
            ? await window.api.triggersEnableProject(cwd, id)
            : await window.api.triggersDisableProject(cwd, id);
          return res.ok
            ? addInfo(sub === 'enable'
              ? `Project trigger "${id}" enabled. It re-disables automatically if its definition changes (e.g. via git pull).`
              : `Project trigger "${id}" disabled.`)
            : addError(res.error);
        }
        const state = await window.api.triggersState(cwd);
        const lines = [`TRIGGERS — ${state.configPath}`];
        if (state.error) lines.push(`(could not be read: ${state.error})`);
        if (!state.triggers.length) lines.push('(none configured — /agent trigger new to create the file)');
        for (const trigger of state.triggers) {
          lines.push(`${trigger.enabled ? '[on] ' : '[off]'} ${trigger.id} — ${trigger.type === 'heartbeat' ? 'heartbeat (paced by .brittain/HEARTBEAT.md)' : trigger.schedule + ' — ' + trigger.goal}`
            + (trigger.problem ? `  ⚠ ${trigger.problem}` : ''));
        }
        if (state.project?.length || state.projectError) {
          lines.push('', `PROJECT TRIGGERS (.brittain/triggers.json) — disabled on arrival; /agent trigger enable <id>:`);
          if (state.projectError) lines.push(`(could not be read: ${state.projectError})`);
          for (const trigger of state.project || []) {
            const mark = trigger.enablement === 'enabled' ? '[on] ' : trigger.enablement === 'changed' ? '[chg]' : '[off]';
            lines.push(`${mark} ${trigger.id} — ${trigger.type === 'heartbeat' ? 'heartbeat' : trigger.schedule + ' — ' + trigger.goal}`
              + (trigger.enablement === 'changed' ? '  ⚠ definition changed since enablement — re-enable to let it fire' : '')
              + (trigger.problem ? `  ⚠ ${trigger.problem}` : ''));
          }
        }
        if (state.queued.length) {
          lines.push('', 'WAITING TO RUN:');
          for (const entry of state.queued) lines.push(`- ${entry.goal} (queued ${entry.enqueuedAt})`);
        }
        lines.push('', 'Triggers only fire while Brittain Code is open.');
        return showOverlay('AGENT TRIGGERS', lines.join('\n'));
      }

      let goal = arg;
      let policy = '';
      const flagged = goal.match(/^--policy\s+(\S+)\s+([\s\S]+)/);
      if (flagged) { policy = flagged[1]; goal = flagged[2].trim(); }
      if (!goal) return addError('Usage: /agent [--policy <name>] <goal> — runs unattended, always on a branch, always reported.');

      // Disclosure before an unattended run, once per project. Undo is the wrong
      // safety model for a run that can act on the world, so this states plainly
      // what unattended means instead of implying a checkpoint will save you.
      if (!(await confirmAgentRun(cwd, policy))) return;

      const coder = coderModel || modelSelect.value;
      addMessage('user', `AGENT: ${goal}`);
      startRun();
      let res;
      try {
        res = await window.api.agentRun({
          model: modelSelect.value,
          coderModel: coder,
          subModel: subModel || 'qwen3:8b',
          goal,
          cwd,
          policy,
          think: thinkToggle.checked,
          onlineResearch: onlineResearchToggle.checked,
          maxIterations: appSettings?.defaultLoopIterations || 8,
          chatId: currentChatId,
        });
      } catch (err) {
        res = { ok: false, error: err.message || String(err) };
      } finally {
        endRun();
      }
      if (!res.ok) return addError(res.error);
      return saveChat();
    }

    case 'pending': {
      const [sub = '', runArg = '', callArg = ''] = arg.split(/\s+/);

      // Approve/deny mark decisions on the stored record; resume is the
      // separate, explicit act that executes them and continues the run.
      if (sub === 'approve' || sub === 'deny' || sub === 'resume') {
        const listed = await window.api.pendingList();
        const target = PendingTarget.resolvePendingTarget(listed.records || [], runArg, callArg);
        if (target.error) return addError(target.error);
        const { record, selector } = target;

        if (sub === 'resume') {
          const undecided = record.parked.filter((entry) => !entry.decision).length;
          if (undecided) addInfo(`${undecided} parked call(s) are undecided — resuming treats them as denied.`);
          startRun();
          let res;
          try { res = await window.api.pendingResume(record.runId); } finally { endRun(); }
          return res.ok ? saveChat() : addError(res.error);
        }

        const approved = sub === 'approve';
        const indexes = selector && selector !== 'all'
          ? [parseInt(selector, 10)].filter((n) => Number.isInteger(n))
          : record.parked.map((entry) => entry.index);
        if (!indexes.length) return addError(`"${selector}" is not one of this run's parked calls. /pending lists them by index.`);
        for (const index of indexes) {
          const res = await window.api.pendingResolve(record.runId, index, approved);
          if (!res.ok) return addError(res.error);
        }
        return addInfo(`${approved ? 'Approved' : 'Denied'} ${indexes.length} parked call(s) on ${record.runId}.`
          + ` /pending resume${listed.records.length > 1 ? ' ' + record.runId : ''} to continue the run.`);
      }

      const listed = await window.api.pendingList();
      if (!listed.ok) return addError('Could not read suspended runs.');
      const lines = [];
      for (const record of listed.expired || []) lines.push(`(expired unanswered: "${record.goal}")`);
      if (!listed.records.length) lines.push('No suspended runs. When an unattended run parks a call, it appears here.');
      for (const record of listed.records) {
        lines.push(`${record.runId} — "${record.goal}"`, `  suspended ${record.suspendedAt} in ${record.cwd}`);
        for (const entry of record.parked) {
          lines.push(`  [${entry.index}] ${entry.name}${entry.target ? ` on ${entry.target}` : ''} — ${entry.reason}${entry.decision ? ` (${entry.decision})` : ''}`);
        }
        lines.push('');
      }
      lines.push(listed.records.length === 1
        ? '/pending approve [n|all] · /pending deny [n|all] · /pending resume — the run id is optional while only this one is waiting'
        : '/pending approve <run> [n|all] · /pending deny <run> [n|all] · /pending resume <run>');
      return showOverlay('PARKED CALLS', lines.join('\n'));
    }

    case 'policies': {
      const state = await window.api.autonomyState();
      if (!state?.ok) return addError('Could not read autonomy policies.');
      if (arg === 'edit' || arg === 'new') {
        const opened = await window.api.autonomyOpenConfig();
        return addInfo(`Edit custom policies in ${opened.path}, then reload with /policies.`);
      }
      if (/^promote\b/.test(arg)) {
        const [, policyId = '', toolName = ''] = arg.split(/\s+/);
        if (!policyId || !toolName) return addError('Usage: /policies promote <custom-policy> <tool> — adds the tool to that policy\'s allow list.');
        const res = await window.api.autonomyPromote(policyId, toolName);
        if (!res.ok) return addError(res.error);
        return addInfo(res.already
          ? `${toolName} is already on ${policyId}'s allow list.`
          : `Promoted ${toolName} into ${policyId}'s allow list (${res.configPath}).`);
      }
      const lines = ['AUTONOMY POLICIES', ''];
      for (const policy of state.policies) {
        lines.push(`${policy.id === state.current ? '▶ ' : '  '}${policy.id}${policy.builtIn ? '' : ' (custom)'} — ${policy.description || policy.label}`);
        // Reaching outside the project is the one policy setting worth seeing
        // without opening the config file.
        if (policy.roots?.length) lines.push(`      reaches outside the project: ${policy.roots.join(', ')}`);
        if (policy.rejectedRoots?.length) lines.push(`      ⚠ unusable roots ignored: ${policy.rejectedRoots.join(', ')}`);
      }
      if (state.configError) lines.push('', `autonomy.json: ${state.configError}`);
      if (state.deferred.length) {
        lines.push('', 'HELD FOR REVIEW (last unattended run):');
        for (const entry of state.deferred) {
          lines.push(`- ${entry.name}${entry.target ? ` on ${entry.target}` : ''} — ${entry.reason}`);
        }
      }
      // The learning loop: patterns held often across runs and never denied by
      // a human are evidence a policy is too tight. Promotion is always a
      // person's click, never automatic.
      const learned = await window.api.autonomySuggestions();
      if (learned?.ok && learned.suggestions.length) {
        lines.push('', 'SUGGESTIONS (held often across runs, never denied by you):');
        for (const suggestion of learned.suggestions) {
          lines.push(`- ${suggestion.key} — held ${suggestion.held}× across ${suggestion.runs} run(s)`
            + (suggestion.example ? ` (e.g. ${suggestion.example})` : '')
            + ` → /policies promote <custom-policy> ${suggestion.name}`);
        }
      }
      lines.push('', 'Set with the AUTONOMY dial, or /policies edit to define a custom one.');
      return showOverlay('AUTONOMY POLICIES', lines.join('\n'));
    }

    case 'ledger': {
      const res = await window.api.ledgerGet();
      if (!res.ok) return addError(res.error || 'Could not read the session ledger.');
      const parts = [];
      parts.push(res.live || '(no tool activity in the current conversation yet)');
      if (res.snapshots.length) {
        parts.push('', `EARLIER, SAVED AT COMPACTION (${res.path}):`);
        for (const snapshot of res.snapshots) {
          const when = snapshot.at ? new Date(snapshot.at).toLocaleString() : 'unknown time';
          parts.push(`- ${when} — ${snapshot.before} → ${snapshot.after} tokens · `
            + `${snapshot.changed} files changed · ${snapshot.commands} commands · ${snapshot.errors} errors`
            + (snapshot.degraded ? ' · no usable summary' : ''));
        }
      }
      return showOverlay('SESSION LEDGER — ' + res.sessionId, parts.join('\n'));
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
  if (!res.ok) return addError('Could not load diff: ' + res.error);
  window.DiffViewer.show(res, { $, hideOverlay });
}

$('diff-btn').addEventListener('click', showDiff);
$('commit-btn').addEventListener('click', () => {
  input.value = '/commit ';
  input.focus();
});

async function showContextInspector() {
  const res = await window.api.contextInspect({
    model: modelSelect.value,
    cwd,
    mode: appMode,
    onlineResearch: onlineResearchToggle.checked,
  });
  if (!res.ok) return addError(res.error || 'Failed to inspect context.');

  const handleControl = async (payload) => {
    if (busy) {
      addError('Wait for the current run to finish before changing context controls.');
      return false;
    }
    const ctrlRes = await window.api.contextControl(payload);
    if (!ctrlRes.ok) {
      addError(ctrlRes.error);
      return false;
    }
    const updated = await window.api.contextInspect({
      model: modelSelect.value,
      cwd,
      mode: appMode,
      onlineResearch: onlineResearchToggle.checked,
    });
    if (updated.ok && window.ContextViewer) {
      window.ContextViewer.show(updated, { $, hideOverlay, onControl: handleControl });
    }
    return true;
  };

  if (window.ContextViewer) {
    window.ContextViewer.show(res, { $, hideOverlay, onControl: handleControl });
  } else {
    const toolLabel = res.toolCount
      ? `TOOL SCHEMAS  — ${res.toolTokens.toLocaleString()} tok (${res.toolCount} definitions${res.mcpToolCount ? `, ${res.mcpToolCount} from MCP` : ''})`
      : 'TOOL SCHEMAS  — 0 tok (no tools sent in this mode)';
    const lines = [
      `SYSTEM PROMPT — ${res.systemTokens.toLocaleString()} tok`,
      toolLabel,
      '',
      `${res.messageCount} message(s) in conversation:`,
    ];
    res.rows.forEach((r, i) => {
      const label = r.toolName ? `${r.role} [${window.ToolNames ? window.ToolNames.displayToolName(r.toolName) : r.toolName}]` : r.role;
      const flagStr = r.flags?.length ? `  ⚠ ${r.flags.join(', ')}` : '';
      lines.push(`${String(i + 1).padStart(3)}. ${label.padEnd(18)} ~${String(r.tokens).padStart(6)} tok  "${r.preview}"${flagStr}`);
    });
    if (res.pinnedFiles?.length) lines.push('', 'PINNED FILES:', ...res.pinnedFiles.map((file) => `  ${file}`));
    lines.push('', `TOTAL: ~${res.totalTokens.toLocaleString()} / ${res.contextLength.toLocaleString()} tok (${res.percentUsed}% of window)`);
    showOverlay('CONTEXT — what will actually be sent', lines.join('\n'));
  }
}

const ctxSummaryEl = $('ctx-summary');
if (ctxSummaryEl) ctxSummaryEl.addEventListener('click', showContextInspector);
const ctxBarWrapEl = $('ctx-bar-wrap');
if (ctxBarWrapEl) ctxBarWrapEl.addEventListener('click', showContextInspector);

// ---------- overlay ----------
function showOverlay(title, text, opts = {}) {
  $('overlay-title').textContent = title;
  $('overlay-box').classList.remove('recommendations-overlay');
  $('overlay-box').classList.remove('diff-v2-overlay');
  $('overlay-box').classList.remove('context-v2-overlay');
  const body = $('overlay-body');
  body.className = '';
  body.replaceChildren();
  if (opts.diff) {
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

function showRecommendations(result) {
  return window.RecommendationsView.show(result, {
    $,
    modelSelect,
    hideOverlay,
    addInfo,
    installModel: installRecommendedModel,
    modelInstalled: refreshAfterModelInstall,
  });
}

async function installRecommendedModel(model, onProgress) {
  const removeProgressListener = window.api.onModelInstallProgress((progress) => {
    if (progress?.model === model) onProgress(progress);
  });
  try {
    return await window.api.installModel(model);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    removeProgressListener();
  }
}

async function refreshAfterModelInstall(model) {
  const models = await reloadModels(model);
  if (!models.includes(model)) {
    addError(`Ollama completed the pull, but ${model} is not in the installed-model list yet. Use CHECK AGAIN to refresh.`);
    return;
  }
  modelSelect.value = model;
  modelSelect.dispatchEvent(new Event('change'));
  const refreshed = await window.api.getModelRecommendations(appMode);
  if (refreshed.ok) showRecommendations(refreshed);
  addInfo(`Installed ${model} with Ollama and set it as the active model.`);
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
    if (!$('settings-modal').classList.contains('hidden')) hideSettings();
    else if (!$('overlay').classList.contains('hidden')) hideOverlay();
    else if (busy) window.api.stop();
  }
});
