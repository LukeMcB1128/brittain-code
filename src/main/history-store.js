const fs = require('fs');
const path = require('path');

function safeChatId(id) {
  return String(id).replace(/[^\w.-]/g, '');
}

function createHistoryStore({ userDataDir, runtimeMetadata }) {
  const directory = () => path.join(userDataDir(), 'chats');
  const indexPath = () => path.join(directory(), 'index.json');

  function list() {
    try {
      const value = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function writeIndex(entries) {
    fs.mkdirSync(directory(), { recursive: true });
    fs.writeFileSync(indexPath(), JSON.stringify(entries, null, 2), 'utf8');
  }

  async function save(meta, conversation) {
    try {
      const id = safeChatId(meta?.id);
      if (!id) return { ok: false, error: 'invalid chat id' };
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
        // This is the switch snapshot, not the permanent provenance flag in
        // `onlineResearch`. Older chats do not have it and therefore reopen
        // offline.
        onlineResearchEnabled: !!meta.onlineResearchEnabled,
        onlineResearch: !!meta.onlineResearch,
        runMetrics: meta.runMetrics || null,
        contextState: meta.contextState || { projectPath: '', pinnedFiles: [] },
        runtime: { ...mainRuntime, roles: Object.fromEntries(roleEntries) },
      };
      fs.mkdirSync(directory(), { recursive: true });
      fs.writeFileSync(path.join(directory(), id + '.json'), JSON.stringify({
        ...entry,
        ...detailed,
        conversation: conversation || [],
      }), 'utf8');
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
      const chat = JSON.parse(fs.readFileSync(path.join(directory(), safeChatId(id) + '.json'), 'utf8'));
      return { ok: true, chat };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function remove(id) {
    const safeId = safeChatId(id);
    try { fs.unlinkSync(path.join(directory(), safeId + '.json')); } catch {}
    writeIndex(list().filter((chat) => chat.id !== safeId));
    return { ok: true };
  }

  return { directory, list, save, load, remove };
}

module.exports = { createHistoryStore, safeChatId };
