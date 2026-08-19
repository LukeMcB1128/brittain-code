'use strict';

const ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

function validOllamaModelName(value) {
  const name = String(value || '').trim();
  return name.length > 0 && name.length <= 200 && MODEL_NAME.test(name);
}

function progressFromChunk(value) {
  const lines = String(value || '')
    .replace(ANSI_ESCAPE, '')
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const status = lines.at(-1) || '';
  const percentMatch = status.match(/(?:^|\s)(\d{1,3})%(?!\d)/);
  const percent = percentMatch ? Math.min(100, Number(percentMatch[1])) : null;
  return { status: status.slice(0, 240), percent };
}

function createModelInstallService({ spawnImpl, getEndpoint, isLocalEndpoint }) {
  const active = new Map();

  async function install(model, onProgress = () => {}) {
    const name = String(model || '').trim();
    if (!validOllamaModelName(name)) {
      return { ok: false, error: 'The Ollama model name is not valid.' };
    }
    const endpoint = getEndpoint();
    if (!isLocalEndpoint(endpoint)) {
      return { ok: false, error: 'Install is available only for a local Ollama endpoint.' };
    }
    if (active.has(name)) {
      return { ok: false, error: `${name} is already being installed.` };
    }

    let host;
    try { host = new URL(endpoint).origin; }
    catch { return { ok: false, error: 'The Ollama endpoint is not valid.' }; }

    return new Promise((resolve) => {
      let settled = false;
      let recentOutput = '';
      let child;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        active.delete(name);
        resolve(result);
      };
      const publish = (value) => {
        const progress = progressFromChunk(value);
        if (!progress.status) return;
        recentOutput = (recentOutput + '\n' + progress.status).slice(-4000);
        try { onProgress({ model: name, ...progress }); } catch {}
      };

      try {
        child = spawnImpl('ollama', ['pull', name], {
          env: { ...process.env, OLLAMA_HOST: host },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        finish({ ok: false, error: `Could not start ollama pull: ${err.message || err}` });
        return;
      }

      active.set(name, child);
      try { onProgress({ model: name, status: 'Starting ollama pull…', percent: null }); } catch {}
      child.stdout?.on('data', publish);
      child.stderr?.on('data', publish);
      child.once('error', (err) => {
        finish({ ok: false, error: `Could not run ollama pull: ${err.message || err}` });
      });
      child.once('close', (code, signal) => {
        if (code === 0) {
          try { onProgress({ model: name, status: 'Install complete.', percent: 100 }); } catch {}
          finish({ ok: true, model: name });
          return;
        }
        const reason = signal
          ? `ollama pull stopped with ${signal}.`
          : `ollama pull exited with code ${code}.`;
        const detail = recentOutput.trim().split('\n').at(-1);
        finish({ ok: false, error: detail ? `${reason} ${detail}` : reason });
      });
    });
  }

  function stopAll() {
    for (const child of active.values()) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  return { install, stopAll };
}

module.exports = {
  createModelInstallService,
  progressFromChunk,
  validOllamaModelName,
};
