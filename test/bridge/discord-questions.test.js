const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderQuestion, parseAnswer } = require('../../src/bridge/discord-protocol');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

const one = [{ question: 'Which database?', options: ['Postgres', 'SQLite'] }];
const two = [
  { question: 'Which database?', options: ['Postgres', 'SQLite'] },
  { question: 'Name the service?', options: [] },
];

test('a question reaches the person driving the run, options numbered', () => {
  const text = renderQuestion({ questions: one });
  assert.match(text, /Which database\?/);
  assert.match(text, /`1` Postgres/);
  assert.match(text, /`2` SQLite/);
  assert.match(text, /number of an option/);
});

test('a bare number picks that option', () => {
  // On a phone, retyping "Postgres" is the difference between answering and
  // not bothering.
  assert.deepEqual(parseAnswer('2', one), ['SQLite']);
  assert.deepEqual(parseAnswer(' 1 ', one), ['Postgres']);
});

test('free text is always valid, even when options were offered', () => {
  assert.deepEqual(parseAnswer('actually use mysql', one), ['actually use mysql']);
  // A number outside the range is an answer, not an index.
  assert.deepEqual(parseAnswer('7', one), ['7']);
});

test('several questions take one line each', () => {
  assert.deepEqual(parseAnswer('1\nbilling', two), ['Postgres', 'billing']);
  const text = renderQuestion({ questions: two });
  assert.match(text, /one line per question/);
  assert.match(text, /\*\*1\.\*\*/);
});

test('an empty question set renders nothing rather than an empty prompt', () => {
  assert.equal(renderQuestion({ questions: [] }), '');
  assert.equal(renderQuestion({}), '');
});

// --- wiring ---

test('ask_user goes through the sink, not straight to the window', () => {
  // It used to call win.webContents directly, so a run started from Discord
  // asked into the void and was told the user had cancelled.
  const main = read('main.js');
  assert.match(main, /sink\.emit\('question:request', \{ id, \.\.\.info \}\)/);
  assert.ok(!main.includes("win.webContents.send('question:request'"), 'the window must not be the only listener');
  assert.match(read('src/main/run-sink.js'), /'question:request',/, 'the sink must carry it to attached clients');
});

test('a question with nobody to answer it times out instead of hanging', () => {
  const main = read('main.js');
  assert.match(main, /const REMOTE_QUESTION_TIMEOUT_MS = 10 \* 60 \* 1000;/);
  assert.match(main, /if \(!hasWindow\) timer = setTimeout\(\(\) => settle\(null\), REMOTE_QUESTION_TIMEOUT_MS\);/);
  // With a window someone may still come back to it, so that path is unchanged.
  assert.match(main, /const hasWindow = !!win && !win\.isDestroyed\?\.\(\);/);
});

test('the answer can arrive from any transport', () => {
  const main = read('main.js');
  assert.match(main, /answer: \(\{ id, answers \}\) => answerQuestion\(id, answers\)/);
  assert.match(main, /ipcMain\.on\('question:response', \(_e, \{ id, answer \}\) => answerQuestion\(id, answer\)\)/);
});

test('a pending question takes the next plain message, but never a command', () => {
  const client = read('src/bridge/discord-client.js');
  assert.match(client, /if \(awaitingQuestion && content && !content\.startsWith\('!'\)\)/,
    '!stop must not be swallowed by a question you would rather abandon');
  assert.match(client, /cmd: 'answer', payload: \{ id, answers: parseAnswer\(content, questions\) \}/);
});
