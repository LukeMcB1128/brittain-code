const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_IMPLEMENTATION_TASKS,
  normalizeImplementationPlan,
} = require('../../src/main/orchestration-plan');

test('approved plans are normalized at the main-process boundary', () => {
  const plan = normalizeImplementationPlan({
    summary: '  Approved approach  ',
    tasks: [
      {
        title: '  Build it  ',
        objective: '  Add the feature  ',
        acceptance_criteria: ['  It works  ', '', 'Tests pass'],
        relevant_files: ['  src/app.js  '],
        constraints: ['  Keep compatibility  '],
      },
    ],
  }, 'Fallback goal');

  assert.equal(plan.summary, 'Approved approach');
  assert.deepEqual(plan.tasks, [{
    id: 'task-1',
    title: 'Build it',
    objective: 'Add the feature',
    acceptance_criteria: ['It works', 'Tests pass'],
    relevant_files: ['src/app.js'],
    constraints: ['Keep compatibility'],
  }]);
});

test('approved plans stay bounded and receive a safe fallback task', () => {
  const tooManyTasks = Array.from({ length: MAX_IMPLEMENTATION_TASKS + 3 }, (_value, index) => ({
    title: `Task ${index + 1}`,
    objective: `Objective ${index + 1}`,
    acceptance_criteria: ['Done'],
  }));
  assert.equal(normalizeImplementationPlan({ tasks: tooManyTasks }, 'Goal').tasks.length, MAX_IMPLEMENTATION_TASKS);

  const fallback = normalizeImplementationPlan({ summary: ' ', tasks: [{ objective: ' ' }] }, 'Ship the feature');
  assert.equal(fallback.summary, 'Implement and verify the requested goal.');
  assert.equal(fallback.tasks[0].objective, 'Ship the feature');
  assert.equal(fallback.tasks[0].acceptance_criteria.length, 1);
});
