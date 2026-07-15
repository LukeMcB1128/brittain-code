const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('coder loop is wired through renderer, preload, main workflow, and benchmark telemetry', () => {
  const renderer = source('renderer/app.js');
  const preload = source('preload.js');
  const main = source('main.js');
  const grader = source('benchmark/grade.js');

  assert.match(renderer, /\/loop \[--coder] \[n] <goal>/);
  assert.match(renderer, /const coderFlag = goal\.match/);
  assert.match(renderer, /coderModel,\n\s+useCoder,/);

  assert.match(preload, /useCoder: !!payload\.useCoder/);
  assert.match(preload, /coderModel: payload\.coderModel \|\| ''/);

  assert.match(main, /ipcMain\.handle\('chat:loop',[\s\S]*coderModel, useCoder/);
  assert.match(main, /if \(useCoder\) \{[\s\S]*runCoderGoalLoop/);
  assert.match(main, /runCoderGoalLoop[\s\S]*runOrchestrationVerifier/);
  assert.match(main, /coderLoopIterations \+= 1/);

  assert.match(grader, /metrics\.coderLoopIterations/);
  assert.match(grader, /ORCHESTRATE\|CODER LOOP/);
});

test('Code and Chat modes are wired through UI, persistence, and the agent boundary', () => {
  const html = source('renderer/index.html');
  const renderer = source('renderer/app.js');
  const main = source('main.js');

  assert.match(html, /id="mode-code"/);
  assert.match(html, /id="mode-chat"/);
  assert.match(renderer, /mode: appMode/);
  assert.match(renderer, /appMode === 'code' && !cwd/);
  assert.match(renderer, /appMode === 'chat'\s*\? chatEntry\.mode === 'chat'\s*:\s*chatEntry\.mode !== 'chat'/);
  assert.match(main, /mode: meta\.mode === 'chat' \? 'chat' : 'code'/);
  assert.match(main, /const runMode = mode === 'chat' \? 'chat' : 'code'/);
  assert.match(main, /const modeTools = chatMode \? CHAT_TOOLS : TOOL_DEFS/);
  assert.match(main, /if \(!activeToolNames\.has\(name\)\)/);
});
