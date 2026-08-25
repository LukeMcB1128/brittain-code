const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('mission owns the durable coder workflow while loop stays single-model', () => {
  const renderer = source('renderer/app.js');
  const preload = source('preload.js');
  const main = source('main.js');
  const grader = source('benchmark/grade.js');

  assert.match(renderer, /\/loop \[n] <goal>/);
  assert.doesNotMatch(renderer, /--coder/);
  assert.match(renderer, /window\.api\.loop\(\{/);

  assert.match(preload, /loop: \(payload = \{\}\) => ipcRenderer\.invoke\('chat:loop', payload\)/);
  assert.doesNotMatch(preload, /useCoder/);

  assert.match(main, /ipcMain\.handle\('chat:loop',[\s\S]*\{ model, subModel, goal/);
  assert.doesNotMatch(main, /if \(useCoder\)/);
  assert.match(main, /runCoderGoalLoop[\s\S]*runOrchestrationVerifier/);
  assert.match(main, /coderLoopIterations \+= 1/);
  assert.match(main, /function buildCoderHandoff/);
  assert.match(main, /previous_attempt: priorAttempt/);
  assert.match(main, /forceCoderWrapUp/);
  assert.match(main, /instead of continuing broad exploration/);
  assert.match(main, /reachedToolCap/);

  assert.match(grader, /metrics\.coderLoopIterations/);
  // Team scoring is claimed only by an explicitly recorded team run or a real
  // orchestration in the telemetry. It must NOT be inferred from the chat
  // title, which used to promote ordinary solo runs to team runs.
  assert.match(grader, /const mode = explicitMode \|\| \(Number\(metrics\.orchestrations\) > 0 \? 'team' : 'solo'\)/);
  assert.doesNotMatch(grader, /ORCHESTRATE\|MISSION/);
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
  assert.match(renderer, /function shouldDisplayMission/);
  assert.match(renderer, /appMode === 'code'/);
  assert.match(renderer, /mission\?\.chatId === currentChatId/);
  assert.match(renderer, /normalizedMissionPath\(cwd\) === normalizedMissionPath\(mission\.projectPath\)/);
  assert.match(renderer, /chatId: currentChatId/);
  assert.match(renderer, /missionControl =/);
  assert.match(renderer, /busy && !missionControl/);
  assert.match(preload, /missionStart: \(payload\) => ipcRenderer\.invoke\('mission:start'/);
  assert.match(preload, /missionStop: \(\) => ipcRenderer\.invoke\('mission:stop'/);
  assert.match(preload, /missionResume: \(payload\) => ipcRenderer\.invoke\('mission:resume'/);
  // Starting a mission is callable without IPC, so a trigger or a queue can do
  // it; the handler is a wrapper that records who asked.
  assert.match(main, /async function startMission\(\{[\s\S]*origin = 'ui',/);
  assert.match(main, /ipcMain\.handle\('mission:start', async \(_e, payload = \{\}\) => startMission\(\{ \.\.\.payload, origin: 'ui' \}\)\)/);
  assert.match(main, /chatId,\n\s*origin,\n\s*startedAt/);
  assert.match(main, /runCoderGoalLoop\(\{/);
  assert.match(main, /ipcMain\.handle\('mission:stop'/);
  assert.match(main, /ipcMain\.handle\('mission:resume'/);
  assert.match(main, /validateMissionRecovery/);
  assert.match(main, /interruptRunningMission/);
  assert.equal(packageJson.build.files.includes('missions.js'), true);
});

test('plan command stops for editable approval and reuses the approved plan', () => {
  const html = source('renderer/index.html');
  const renderer = source('renderer/app.js');
  const planView = source('renderer/features/plan-draft.js');
  const preload = source('preload.js');
  const main = source('main.js');

  assert.match(html, /features\/plan-draft\.js/);
  assert.match(html, /styles\/plan-draft\.css/);
  assert.match(renderer, /\/plan <goal>/);
  assert.match(renderer, /case 'plan'/);
  assert.match(renderer, /window\.api\.plan\(\{/);
  assert.match(renderer, /plan,\n\s+\}\);/);
  assert.match(planView, /'RUN'/);
  assert.match(planView, /'EDIT'/);
  assert.match(planView, /'CANCEL'/);
  assert.match(preload, /plan: \(payload\) => ipcRenderer\.invoke\('chat:plan', payload\)/);
  assert.match(main, /ipcMain\.handle\('chat:plan'/);
  assert.match(main, /if \(approvedPlan\)[\s\S]*normalizeImplementationPlan\(approvedPlan, goal\.trim\(\)\)[\s\S]*else \{[\s\S]*runOrchestratorPlan/);
});

test('Code and Chat modes are wired through UI, persistence, and the agent boundary', () => {
  const html = source('renderer/index.html');
  const renderer = source('renderer/app.js');
  const main = source('main.js');
  const historyStore = source('src/main/history-store.js');

  assert.match(html, /id="mode-code"/);
  assert.match(html, /id="mode-chat"/);
  assert.match(renderer, /mode: appMode/);
  assert.match(renderer, /appMode === 'code' && !cwd/);
  assert.match(renderer, /appMode === 'chat'\s*\? chatEntry\.mode === 'chat'\s*:\s*chatEntry\.mode !== 'chat'/);
  assert.match(historyStore, /mode: meta\.mode === 'chat' \? 'chat' : 'code'/);
  assert.match(main, /const runMode = mode === 'chat' \? 'chat' : 'code'/);
  assert.match(main, /const modeTools = chatMode \? CHAT_TOOLS : TOOL_DEFS/);
  // MCP is chat mode's only route to anything outside the conversation, and it
  // must not be gated behind the unrelated ONLINE switch.
  assert.match(main, /return \(mcpDefs\.length \|\| onlineResearch\) \? chatTools : null;/);
  assert.match(main, /if \(!activeToolNames\.has\(name\)\)/);
});

test('local browser verification is loopback-only and available to coding workers', () => {
  const main = source('main.js');
  const tools = source('tools.js');
  const service = source('src/main/local-browser-service.js');
  const policy = source('src/tools/policy.js');

  assert.match(main, /createLocalBrowserService/);
  assert.match(main, /localBrowser\.closeAll\(\)/);
  assert.match(tools, /name: 'browser_snapshot'/);
  assert.match(tools, /name: 'browser_screenshot'/);
  assert.match(service, /Only localhost, 127\.0\.0\.0\/8, and ::1 are allowed/);
  assert.match(service, /onBeforeRequest/);
  assert.match(service, /capturePage/);
  assert.match(policy, /'browser_open', 'browser_snapshot', 'browser_click', 'browser_type'/);
});

test('atomic patch editing previews before approval and records changed paths', () => {
  const main = source('main.js');
  const tools = source('tools.js');
  const patchService = source('src/tools/apply-patch.js');

  assert.match(tools, /name: 'apply_patch'/);
  assert.match(main, /name === 'apply_patch' && args\.dry_run !== false/);
  assert.match(main, /ORCHESTRATION_MUTATING_TOOLS[\s\S]*'apply_patch'/);
  assert.match(patchService, /Atomic patch failed and was rolled back/);
  assert.match(patchService, /resolveForWrite\(cwd, section\.path\)/);
});

test('context controls persist pins and exclude tool content only from inference', () => {
  const renderer = source('renderer/app.js');
  const preload = source('preload.js');
  const main = source('main.js');
  const historyStore = source('src/main/history-store.js');
  const controls = source('src/main/context-controls.js');

  assert.match(renderer, /case 'pin'/);
  assert.match(renderer, /case 'exclude'/);
  assert.match(renderer, /decorateContextControls/);
  assert.match(preload, /contextControl: \(payload\) => ipcRenderer\.invoke\('context:control'/);
  assert.match(main, /Tool result content excluded from inference by the user/);
  assert.match(main, /pinnedMessagesPrompt\(conversation\)/);
  assert.match(main, /pinnedFilesPrompt\(contextState, cwd\)/);
  assert.match(historyStore, /contextState: meta\.contextState/);
  assert.match(controls, /Pinned file path escapes the working directory through a symlink/);
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

test('model recommendations are wired through the command, bridge, and packaged runtime', () => {
  const html = source('renderer/index.html');
  const renderer = source('renderer/app.js');
  const recommendationsView = source('renderer/features/recommendations.js');
  const preload = source('preload.js');
  const main = source('main.js');
  const hardwareProfile = source('src/main/hardware-profile.js');
  const recommendationsService = source('src/main/recommendations-service.js');
  const packageJson = JSON.parse(source('package.json'));

  assert.match(html, /id="overlay-body"/);
  assert.match(html, /id="onboarding-recommendations"/);
  assert.match(html, /features\/recommendations\.js/);
  assert.match(html, /styles\/recommendations\.css/);
  assert.match(renderer, /case 'recs'/);
  assert.match(renderer, /window\.api\.getModelRecommendations\(appMode\)/);
  assert.match(renderer, /function showRecommendations/);
  assert.match(recommendationsView, /global\.RecommendationsView/);
  assert.match(preload, /ipcRenderer\.invoke\('models:recommendations'/);
  assert.match(preload, /ipcRenderer\.invoke\('models:install'/);
  assert.match(main, /ipcMain\.handle\('models:recommendations'/);
  assert.match(main, /ipcMain\.handle\('models:install'/);
  assert.match(main, /createRecommendationsService/);
  assert.match(hardwareProfile, /processRef\.getSystemMemoryInfo/);
  assert.match(hardwareProfile, /systemInformationRef\.graphics\(\)/);
  assert.match(recommendationsService, /buildRecommendations/);
  assert.equal(packageJson.build.files.includes('recommendations.js'), true);
  assert.equal(packageJson.build.files.includes('model-presets.json'), true);
  assert.equal(packageJson.build.files.includes('model-baselines.json'), true);
  assert.equal(packageJson.build.files.includes('src/**'), true);
  assert.equal(packageJson.dependencies.systeminformation, '^5.33.1');
});

test('AUTO routes a request through recommendations and replaces the old best command', () => {
  const renderer = source('renderer/app.js');
  const preload = source('preload.js');
  const main = source('main.js');

  assert.match(renderer, /case 'auto'/);
  assert.match(renderer, /window\.api\.autoRouteModel/);
  assert.match(renderer, /input\.value = arg;\n\s+return send\(\)/);
  assert.doesNotMatch(renderer, /case 'best'/);
  assert.doesNotMatch(renderer, /\/best/);
  assert.match(preload, /ipcRenderer\.invoke\('models:autoRoute'/);
  assert.doesNotMatch(preload, /bench:query/);
  assert.match(main, /ipcMain\.handle\('models:autoRoute'/);
  assert.doesNotMatch(main, /ipcMain\.handle\('bench:query'/);
});

test('Diff v2 is structured by state and keeps the existing review entry point', () => {
  const html = source('renderer/index.html');
  const renderer = source('renderer/app.js');
  const main = source('main.js');

  assert.match(html, /features\/diff-viewer\.js/);
  assert.match(html, /styles\/diff-viewer\.css/);
  assert.match(renderer, /window\.DiffViewer\.show/);
  assert.match(renderer, /'review-diff-btn'\)\.addEventListener\('click', showDiff\)/);
  assert.match(main, /createDiffService/);
  assert.match(main, /ipcMain\.handle\('git:diff'/);
});

test('structured review can send selected findings to the coder', () => {
  const html = source('renderer/index.html');
  const renderer = source('renderer/app.js');
  const preload = source('preload.js');
  const main = source('main.js');

  assert.match(html, /features\/review-findings\.js/);
  assert.match(renderer, /case 'review'/);
  assert.match(renderer, /window\.api\.reviewFix/);
  assert.match(preload, /chat:reviewFix/);
  assert.match(main, /submit_code_review/);
  assert.match(main, /ipcMain\.handle\('chat:review'/);
  assert.match(main, /ipcMain\.handle\('chat:reviewFix'/);
  assert.match(main, /await createCheckpoint\(cwd\)/);
});

test('Context viewer is structured with 2-column layout and wired through renderer', () => {
  const html = source('renderer/index.html');
  const renderer = source('renderer/app.js');
  const main = source('main.js');

  assert.match(html, /features\/context-viewer\.js/);
  assert.match(html, /styles\/context-viewer\.css/);
  assert.match(renderer, /window\.ContextViewer\.show/);
  assert.match(renderer, /showContextInspector/);
  assert.match(main, /ipcMain\.handle\('context:inspect'/);
});

