'use strict';

const MAX_IMPLEMENTATION_TASKS = 6;

function cleanStringList(value, cap = 20, itemCap = 2000) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim().slice(0, itemCap)).filter(Boolean).slice(0, cap)
    : [];
}

function normalizeImplementationPlan(value, goal) {
  const safeGoal = String(goal || '').trim();
  const rawTasks = Array.isArray(value?.tasks)
    ? value.tasks.slice(0, MAX_IMPLEMENTATION_TASKS)
    : [];
  const tasks = rawTasks.map((task, index) => {
    const defaultTitle = `Implementation task ${index + 1}`;
    const title = String(task?.title || '').trim() || defaultTitle;
    return {
      id: `task-${index + 1}`,
      title: title.slice(0, 120),
      objective: String(task?.objective || '').trim().slice(0, 8000),
      acceptance_criteria: cleanStringList(task?.acceptance_criteria, 12),
      relevant_files: cleanStringList(task?.relevant_files, 30, 500),
      constraints: cleanStringList(task?.constraints, 20),
    };
  }).filter((task) => task.objective);

  if (!tasks.length) {
    tasks.push({
      id: 'task-1',
      title: 'Implement the requested goal',
      objective: safeGoal,
      acceptance_criteria: ['The requested goal is implemented and verified with available project checks.'],
      relevant_files: [],
      constraints: [],
    });
  }

  const summary = String(value?.summary || '').trim() || 'Implement and verify the requested goal.';
  return {
    summary: summary.slice(0, 2000),
    tasks,
  };
}

module.exports = {
  MAX_IMPLEMENTATION_TASKS,
  cleanStringList,
  normalizeImplementationPlan,
};
