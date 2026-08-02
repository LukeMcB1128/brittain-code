const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BRITTAIN_TOOLS, BRITTAIN_TOOL_NAMES, TOOL_DEFS, resolveAnywhere } = require('../tools');
const source = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const HOME = os.homedir();

const denied = (p) => assert.throws(() => resolveAnywhere(p, HOME), /^Error: Refused:/, `should refuse ${p}`);
const allowed = (p) => assert.doesNotThrow(() => resolveAnywhere(p, HOME), `should allow ${p}`);

test('brittain deny-list blocks credential stores and secret files', () => {
  denied('~/.ssh/id_ed25519');
  denied('~/.ssh');
  denied('~/.aws/credentials');
  denied('~/.gnupg/secring.gpg');
  denied('~/.kube/config');
  denied('~/anything/.env');
  denied('~/anything/.env.production');
  denied('/tmp/server.pem');
  denied('~/Downloads/private.key');
  denied('~/.zsh_history');
  denied('~/.git-credentials');
  denied('~/proj/secrets.json');
});

test('brittain deny-list blocks personal data stores', () => {
  denied('~/Library/Keychains/login.keychain-db');
  denied('~/Library/Messages/chat.db');
  denied('~/Library/Application Support/Google/Chrome/Default/Cookies');
  denied('~/Library/Safari/History.db');
});

test('brittain deny-list cannot be bypassed by symlink or traversal', () => {
  denied('~/Downloads/../.ssh/id_rsa');
  denied(path.join(HOME, '.aws', 'credentials'));

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-link-'));
  try {
    const link = path.join(sandbox, 'harmless');
    fs.symlinkSync(path.join(HOME, '.ssh'), link);
    // A deny list that only checks the literal string is defeated by this.
    denied(path.join(link, 'id_ed25519'));
    denied(link);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EEXIST') throw err;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('brittain still reads ordinary files anywhere on the machine', () => {
  allowed('~/Downloads');
  allowed('~');
  allowed('/tmp');
  allowed('~/Documents/notes.md');
  allowed('main.js');
  assert.equal(resolveAnywhere('~', HOME), HOME, '~ expands to home');
  assert.equal(path.isAbsolute(resolveAnywhere('main.js', HOME)), true, 'relative resolves against cwd');
});

test('brittain toolset is read-only and curated', () => {
  const names = BRITTAIN_TOOLS.map((d) => d.function.name);
  for (const forbidden of ['write_file', 'edit_file', 'edit_files', 'append_file', 'delete_file',
    'run_command', 'move_file', 'copy_file', 'create_directory', 'start_process', 'revert_to_last_commit']) {
    assert.equal(names.includes(forbidden), false, `Brittain must not have ${forbidden}`);
  }
  for (const expected of ['read_file', 'app_status', 'run_subagent', 'remember', 'web_search', 'web_fetch']) {
    assert.equal(names.includes(expected), true, `Brittain should have ${expected}`);
  }
  // Tool-call count tracks inversely with quality; keep the list deliberately small.
  assert.ok(names.length <= 22, `Brittain toolset should stay curated, got ${names.length}`);
  assert.equal(BRITTAIN_TOOLS.length, BRITTAIN_TOOL_NAMES.size);
  const all = new Set(TOOL_DEFS.map((d) => d.function.name));
  for (const n of BRITTAIN_TOOL_NAMES) assert.equal(all.has(n), true, `${n} must exist in TOOL_DEFS`);
});

test('brittain mode reaches the agent without being coerced to code', () => {
  const main = source('main.js');
  // The bug this guards: runMode fed runAgentTurn, so coercing brittain->code
  // silently handed Brittain the full code toolset and prompt.
  assert.match(main, /const runMode = mode === 'chat' \? 'chat' : mode === 'brittain' \? 'brittain' : 'code'/);
  assert.match(main, /const brittainMode = mode === 'brittain'/);
  assert.match(main, /const modeTools = brittainMode \? BRITTAIN_TOOLS/);
  assert.match(main, /brittainSystemPrompt\(cwd, onlineResearch\)/);
  // broad read must be scoped to brittain only
  assert.match(main, /const execOpts = \{ broadRead: mode === 'brittain' \}/);
});

test('brittain history and cwd are wired distinctly', () => {
  const main = source('main.js');
  const renderer = source('renderer/app.js');
  assert.match(main, /mode: meta\.mode === 'chat' \? 'chat' : meta\.mode === 'brittain' \? 'brittain' : 'code'/);
  assert.match(renderer, /\(chatEntry\.mode \|\| 'code'\) === appMode/);
  // Brittain needs a cwd for git tools and app_status; only Chat is directory-less.
  assert.match(renderer, /cwd: appMode === 'chat' \? null : cwd/);
});

test('brittain speech sanitizer keeps prose and drops code', () => {
  const { speakableText } = loadSpeech();

  const spoken = speakableText('Here is the fix:\n```js\nconst x = 1;\n```\nIt works now.');
  assert.match(spoken, /Here is the fix/);
  assert.match(spoken, /It works now/);
  assert.doesNotMatch(spoken, /const x = 1/, 'must not read code aloud');

  assert.doesNotMatch(speakableText('See `foo.bar()` there'), /foo\.bar/);
  assert.doesNotMatch(speakableText('open /Users/user/proj/src/main.js now'), /Users/);
  assert.doesNotMatch(speakableText('visit https://example.com/x'), /example\.com/);
  assert.equal(speakableText('**Bold** and _italic_'), 'Bold and italic');
  assert.ok(speakableText('word '.repeat(400)).length <= 740, 'long replies are capped');
});

test('brittain ambient watchers are rate limited and never model-generated', () => {
  const main = source('main.js');
  assert.match(main, /BRITTAIN_MIN_GAP_MS/);
  assert.match(main, /BRITTAIN_MAX_PER_HOUR/);
  assert.match(main, /function brittainAnnounce/);
  // Announcements must be canned strings sent straight to the renderer —
  // never a model call, which would cost tokens continuously and could fabricate.
  const start = main.indexOf('function brittainAnnounce');
  const end = main.indexOf('async function brittainCheckGit');
  const body = main.slice(start, end);
  assert.doesNotMatch(body, /streamChat|ollamaJson/, 'ambient announcements must not call a model');
  assert.match(main, /ipcMain\.handle\('brittain:watch'/);
});

test('brittain settings exist with safe defaults', () => {
  const { DEFAULT_SETTINGS, normalizeSettings } = require('../settings');
  assert.equal(DEFAULT_SETTINGS.userName, '');
  assert.equal(DEFAULT_SETTINGS.brittainModel, '');
  assert.equal(DEFAULT_SETTINGS.brittainSpeak, true);
  assert.equal(DEFAULT_SETTINGS.brittainWatch, true);
  assert.deepEqual(DEFAULT_SETTINGS.brittainWatchTools, [], 'no background polling until the user names a tool');

  const n = normalizeSettings({ brittainWatchTools: ['a', '', 42, 'b', 'c', 'd', 'e', 'f'] });
  assert.deepEqual(n.brittainWatchTools, ['a', 'b', 'c', 'd', 'e'], 'capped at 5, strings only');
});

test('functions reachable from the module-level setAppMode call are hoisted', () => {
  // The bug this guards: setAppMode() runs at module top level, and Brittain added
  // a stopSpeaking() call to it. stopSpeaking -> speechAvailable, which was a
  // `const` arrow declared ~300 lines lower, so boot died with a temporal-dead-zone
  // ReferenceError and the whole UI stayed blank. Every other test still passed.
  const src = source('renderer/app.js');
  const bootCall = src.indexOf('\nsetAppMode(');
  assert.ok(bootCall > 0, 'setAppMode should still be called at module top level');

  // Bindings that are only initialized *after* the top-level call runs.
  const lateBindings = new Map();
  const bindingRe = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm;
  for (let m; (m = bindingRe.exec(src)); ) {
    if (m.index > bootCall) lateBindings.set(m[1], m.index);
  }

  const bodyOf = (name) => {
    const start = src.search(new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`));
    if (start < 0) return null;
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i);
    }
    return null;
  };

  const seen = new Set();
  const offenders = [];
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const body = bodyOf(name);
    if (!body) return;
    for (let m, callRe = /([A-Za-z_$][\w$]*)\s*\(/g; (m = callRe.exec(body)); ) {
      const callee = m[1];
      if (lateBindings.has(callee)) offenders.push(`${name}() calls ${callee}(), declared later as const/let`);
      walk(callee);
    }
  };
  walk('setAppMode');

  assert.deepEqual(offenders, [], `boot-time call into the temporal dead zone:\n${offenders.join('\n')}`);
});

// Load the renderer's speech section into a stubbed environment so the streaming
// behaviour itself is tested, not just the presence of the source text.
function loadSpeech({ appMode = 'brittain', brittainMuted = false, appSettings = null } = {}) {
  const src = source('renderer/app.js');
  const a = src.indexOf('function speakableText');
  const b = src.indexOf('function initBrittainMuteButton');
  assert.ok(a > 0 && b > a, 'speech section should be locatable');
  // eslint-disable-next-line no-new-func
  return new Function('appMode', 'brittainMuted', 'appSettings', `
    let speechBuf = ''; let spokenChars = 0; let speechCapped = false; let cachedVoice = null;
    const spoken = [];
    const window = { speechSynthesis: {
      speak: (u) => { if (u.volume !== 0) spoken.push(u.text); },
      cancel: () => {}, getVoices: () => [],
    } };
    function SpeechSynthesisUtterance(t) { this.text = t; this.volume = 1; }
    function speechAvailable() { return true; }
    function pickBrittainVoice() { return null; }
    ${src.slice(a, b)}
    return { feedSpeech, flushSpeech, stopSpeaking, speak, warmUpSpeech, spoken, speakableText,
             state: () => ({ buf: speechBuf, chars: spokenChars }) };
  `)(appMode, brittainMuted, appSettings);
}

test('brittain speaks each sentence as it streams, not after the whole reply', () => {
  const s = loadSpeech();
  // The bug this guards: speak() ran only from finalizeAssistant(), so Brittain
  // stayed silent for the entire generation before saying a word.
  for (const tok of ['Good ', 'morning', '. ', 'The build ', 'is green', '. ']) s.feedSpeech(tok);
  assert.deepEqual(s.spoken, ['Good morning.', 'The build is green.'],
    'both sentences should already be spoken before the reply finishes');

  s.feedSpeech('One more thing');   // no terminator yet
  assert.equal(s.spoken.length, 2, 'an unfinished sentence waits');
  s.flushSpeech();
  assert.equal(s.spoken[2], 'One more thing', 'the tail is spoken on finalize');
  assert.deepEqual(s.state(), { buf: '', chars: 0 }, 'state resets for the next reply');
});

test('brittain never reads out a code fence that is still open', () => {
  const s = loadSpeech();
  s.feedSpeech('Here it is. ');
  s.feedSpeech('```js\nconst secret = 1;\n');
  assert.deepEqual(s.spoken, ['Here it is.'], 'must not speak inside an unclosed fence');
  s.feedSpeech('```\nThat is all. ');
  assert.equal(s.spoken.length, 2);
  assert.doesNotMatch(s.spoken.join(' '), /const secret/, 'code must never be spoken');
});

test('brittain speech respects mute, mode and the per-reply budget', () => {
  assert.equal(loadSpeech({ brittainMuted: true }).spoken.length, 0);
  const muted = loadSpeech({ brittainMuted: true });
  muted.feedSpeech('Hello. ');
  assert.deepEqual(muted.spoken, [], 'muted speaks nothing');

  const code = loadSpeech({ appMode: 'code' });
  code.feedSpeech('Hello. ');
  assert.deepEqual(code.spoken, [], 'speech is Brittain-only');

  const off = loadSpeech({ appSettings: { brittainSpeak: false } });
  off.feedSpeech('Hello. ');
  assert.deepEqual(off.spoken, [], 'brittainSpeak=false silences');

  const long = loadSpeech();
  for (let i = 0; i < 60; i++) long.feedSpeech('This is a fairly long sentence used to fill the budget. ');
  assert.ok(long.spoken.includes('The rest is on screen.'), 'budget caps the monologue');
  assert.ok(long.spoken.length < 60, 'and stops speaking after the cap');
});

test('stopSpeaking clears pending stream state', () => {
  const s = loadSpeech();
  s.feedSpeech('Half a sentence');
  s.stopSpeaking();
  assert.deepEqual(s.state(), { buf: '', chars: 0 });
  s.flushSpeech();
  assert.deepEqual(s.spoken, [], 'nothing left over to blurt out after a stop');
});

test('brittain voice pick tolerates the platform name for Daniel', () => {
  const renderer = source('renderer/app.js');
  // macOS reports "Daniel (English (United Kingdom))", not "Daniel", so an exact
  // match silently fell through to whatever en-GB voice happened to sort first.
  assert.match(renderer, /\/\^Daniel\\b\/\.test\(v\.name \|\| ''\)/);
  assert.doesNotMatch(renderer, /v\.name === 'Daniel'/, 'exact match misses the real voice name');
  assert.match(renderer, /if \(cachedVoice\) return cachedVoice/, 'voice lookup should be cached');
  assert.match(renderer, /voiceschanged/, 'cache must be invalidated when voices load');
});
