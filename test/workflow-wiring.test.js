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
  assert.match(main, /function buildCoderHandoff/);
  assert.match(main, /previous_attempt: priorAttempt/);
  assert.match(main, /forceCoderWrapUp/);
  assert.match(main, /instead of continuing broad exploration/);
  assert.match(main, /reachedToolCap/);

  assert.match(grader, /metrics\.coderLoopIterations/);
  assert.match(grader, /ORCHESTRATE\|CODER LOOP/);
});

test('missions wrap the bounded coder loop with persisted status and explicit stop controls', () => {
  const renderer = source('renderer/app.js');
  const preload = source('preload.js');
  const main = source('main.js');
  const packageJson = JSON.parse(source('package.json'));

  assert.match(renderer, /\/mission \[iterations] <goal>/);
  assert.match(renderer, /window\.api\.missionStart/);
  assert.match(renderer, /window\.api\.missionStop/);
  assert.match(renderer, /chat\.appendChild\(missionCard\)/);
  assert.match(renderer, /missionControl =/);
  assert.match(renderer, /busy && !missionControl/);
  assert.match(preload, /missionStart: \(payload\) => ipcRenderer\.invoke\('mission:start'/);
  assert.match(preload, /missionStop: \(\) => ipcRenderer\.invoke\('mission:stop'/);
  assert.match(main, /ipcMain\.handle\('mission:start'/);
  assert.match(main, /runCoderGoalLoop\(\{/);
  assert.match(main, /ipcMain\.handle\('mission:stop'/);
  assert.match(main, /interruptRunningMission/);
  assert.equal(packageJson.build.files.includes('missions.js'), true);
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

test('general attachments are wired from the picker through local extraction and history rendering', () => {
  const html = source('renderer/index.html');
  const renderer = source('renderer/app.js');
  const main = source('main.js');
  const packageJson = JSON.parse(source('package.json'));

  assert.match(html, /id="attach-btn"/);
  assert.match(html, /application\/pdf/);
  assert.match(renderer, /files,\n\s+\}\);/);
  assert.match(renderer, /msg\.attachments \|\| \[\]/);
  assert.match(main, /extractFileAttachments\(files/);
  assert.match(main, /contentWithAttachments\(text, fileAttachments\)/);
  assert.equal(packageJson.build.files.includes('attachments.js'), true);
  assert.equal(packageJson.dependencies.unpdf, '^1.6.2');
});

test('settings are wired through the modal, bridge, persistence, and inference runtime', () => {
  const html = source('renderer/index.html');
  const renderer = source('renderer/app.js');
  const preload = source('preload.js');
  const main = source('main.js');
  const packageJson = JSON.parse(source('package.json'));

  assert.match(html, /id="settings-modal"/);
  assert.match(html, /id="setting-endpoint"/);
  assert.match(html, /id="setting-main-context"/);
  assert.match(renderer, /window\.api\.settingsSave\(next\)/);
  assert.match(renderer, /defaultLoopIterations \|\| 8/);
  assert.match(preload, /settingsTestEndpoint/);
  assert.match(main, /ipcMain\.handle\('settings:save'/);
  assert.match(main, /fetch\(inferenceEndpoint\(\) \+ '\/api\/chat'/);
  assert.match(main, /keep_alive: runtimeSettings\.keepAlive/);
  assert.equal(packageJson.build.files.includes('settings.js'), true);
});
