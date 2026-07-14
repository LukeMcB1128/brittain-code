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
