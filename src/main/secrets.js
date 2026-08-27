'use strict';

// API keys, kept out of settings.json.
//
// settings.json is plain text the user is invited to open and edit. A provider
// key is not configuration in that sense: it is a credential that pays for
// things, and it should not sit in a file that gets pasted into bug reports or
// synced somewhere by accident.
//
// Electron's safeStorage encrypts against the OS keychain where one is
// available. Where it is not, the key is still stored separately with tight
// permissions and the caller is told plainly that it is unencrypted, rather
// than being quietly given weaker protection than it thinks it has.

const fs = require('fs');
const path = require('path');

function secretPath(userDataDir) {
  return path.join(userDataDir, 'credentials.json');
}

function read(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretPath(userDataDir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function write(userDataDir, value) {
  const target = secretPath(userDataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch {}
}

function createSecretStore({ userDataDir, safeStorage = null }) {
  const usable = () => {
    try { return !!safeStorage?.isEncryptionAvailable?.(); } catch { return false; }
  };

  return {
    encrypted: usable,

    get(name) {
      const record = read(userDataDir())[name];
      if (!record?.value) return '';
      if (record.encrypted) {
        if (!usable()) return '';
        try { return safeStorage.decryptString(Buffer.from(record.value, 'base64')); } catch { return ''; }
      }
      return record.value;
    },

    set(name, value) {
      const store = read(userDataDir());
      const text = String(value || '');
      if (!text) delete store[name];
      else if (usable()) {
        store[name] = { encrypted: true, value: safeStorage.encryptString(text).toString('base64') };
      } else {
        store[name] = { encrypted: false, value: text };
      }
      write(userDataDir(), store);
      return { ok: true, encrypted: usable() };
    },

    // Never return the key itself to the renderer: the UI only needs to know
    // whether one is set, and showing it invites it into a screenshot.
    describe(name) {
      const record = read(userDataDir())[name];
      const value = record?.value ? this.get(name) : '';
      return {
        set: !!value,
        encrypted: !!record?.encrypted,
        hint: value ? `${value.slice(0, 4)}…${value.slice(-4)}` : '',
      };
    },
  };
}

module.exports = { createSecretStore, secretPath };
