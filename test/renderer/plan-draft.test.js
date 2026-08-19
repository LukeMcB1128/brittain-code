const test = require('node:test');
const assert = require('node:assert/strict');

const { lines, validatePlan } = require('../../renderer/features/plan-draft');

test('plan draft validation accepts edited structured tasks', () => {
  const result = validatePlan({
    summary: 'Implement the plan gate',
    tasks: [{
      title: 'Add the flow',
      objective: 'Connect planning to approval.',
      acceptance_criteria: ['The plan can run.', 'The plan can be cancelled.'],
      relevant_files: ['main.js'],
      constraints: [],
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.tasks[0].title, 'Add the flow');
  assert.deepEqual(lines(' one \n\n two '), ['one', 'two']);
});

test('plan draft validation rejects incomplete user edits', () => {
  assert.match(validatePlan({ summary: '', tasks: [] }).error, /summary/i);
  assert.match(validatePlan({ summary: 'Plan', tasks: [] }).error, /at least one task/i);
  assert.match(validatePlan({
    summary: 'Plan',
    tasks: [{ title: 'Task', objective: 'Do it', acceptance_criteria: [] }],
  }).error, /acceptance criterion/i);
});
