const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');

function writeJsonAtomic(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    // Persist the directory entry where the platform supports it.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function indexEntry(chat) {
  const { id, title, model, mode, cwd, think, autoApprove, onlineResearch, timestamp } = chat;
  return { id, title, model, mode, cwd, think, autoApprove, onlineResearch, timestamp };
}

function safeChatId(id) {
  return String(id).replace(/[^\w.-]/g, '');
}

function createHistoryStore({ userDataDir, runtimeMetadata }) {
  const directory = () => path.join(userDataDir(), 'chats');
  const indexPath = () => path.join(directory(), 'index.json');

  function list() {
    let entries = [];
    try {
      const value = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
      entries = Array.isArray(value) ? value.filter((entry) => entry && typeof entry.id === 'string') : [];
    } catch {}
    // The detail files are authoritative. Recover a lost index or an orphan
    // detail saved just before a crash. Ignore incomplete temporary files.
    let files;
    try { files = new Set(fs.readdirSync(directory())); } catch { return entries; }
    entries = entries.filter((entry) => files.has(entry.id + '.json') && entry.id !== 'index');
    const known = new Set(entries.map((entry) => entry.id));
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'index.json') continue;
      const id = file.slice(0, -5);
      if (known.has(id)) continue;
      const loaded = load(id);
      if (loaded.ok && loaded.chat.id === id && Array.isArray(loaded.chat.conversation)) {
        entries.push(indexEntry(loaded.chat));
      }
    }
    return entries;
  }

  function writeIndex(entries) {
    fs.mkdirSync(directory(), { recursive: true });
    writeJsonAtomic(indexPath(), entries);
  }

  async function save(meta, conversation) {
    try {
      const id = safeChatId(meta?.id);
      if (!id || id === 'index') return { ok: false, error: 'invalid chat id' };
      const entry = {
        id,
        title: meta.title || 'Chat',
        model: meta.model || '',
        mode: meta.mode === 'chat' ? 'chat' : 'code',
        cwd: meta.cwd || '',
        think: !!meta.think,
        autoApprove: !!meta.autoApprove,
        // In the index as well as the detail, so "did this session go online?"
        // is answerable from the list without opening every chat file.
        onlineResearch: !!meta.onlineResearch,
        timestamp: meta.timestamp || new Date().toISOString(),
      };
      const mainRuntime = await runtimeMetadata(meta.model || '');
      const roleNames = {
        main: meta.model || '',
        coder: meta.coderModel || '',
        subagent: meta.subModel || '',
      };
      const roleEntries = await Promise.all(Object.entries(roleNames)
        .map(async ([role, name]) => [role, (await runtimeMetadata(name)).model]));
      const detailed = {
        subModel: meta.subModel || '',
        coderModel: meta.coderModel || '',
        // A temporary title must survive navigation and an app restart.
        // The main chat lifecycle clears this after it saves a generated title.
        autoTitlePending: !!meta.autoTitlePending,
        autoTitleAttempts: Math.max(0, Number(meta.autoTitleAttempts) || 0),
        // This is the switch snapshot, not the permanent provenance flag in
        // `onlineResearch`. Older chats do not have it and therefore reopen
        // offline.
        onlineResearchEnabled: !!meta.onlineResearchEnabled,
        onlineResearch: !!meta.onlineResearch,
        runMetrics: meta.runMetrics || null,
        spend: meta.spend || null,
        contextState: meta.contextState || { projectPath: '', pinnedFiles: [] },
        runtime: { ...mainRuntime, roles: Object.fromEntries(roleEntries) },
      };
      fs.mkdirSync(directory(), { recursive: true });
      writeJsonAtomic(path.join(directory(), id + '.json'), {
        ...entry,
        ...detailed,
        conversation: conversation || [],
      });
      const index = list().filter((chat) => chat.id !== id);
      index.push(entry);
      writeIndex(index);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function load(id) {
    try {
      if (!safeChatId(id) || safeChatId(id) === 'index') throw new Error('invalid chat id');
      const chat = JSON.parse(fs.readFileSync(path.join(directory(), safeChatId(id) + '.json'), 'utf8'));
      return { ok: true, chat };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function remove(id) {
    const safeId = safeChatId(id);
    if (!safeId || safeId === 'index') return { ok: false, error: 'invalid chat id' };
    try {
      try { fs.unlinkSync(path.join(directory(), safeId + '.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      writeIndex(list().filter((chat) => chat.id !== safeId));
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  }

  return { directory, list, save, load, remove };
}

module.exports = { createHistoryStore, safeChatId };
