'use strict';

(function attachPlanDraftView(global) {
  const MAX_TASKS = 6;

  function lines(value) {
    return String(value || '').split('\n').map((item) => item.trim()).filter(Boolean);
  }

  function validatePlan(value) {
    const summary = String(value?.summary || '').trim();
    if (!summary) return { ok: false, error: 'The plan summary is required.' };
    if (!Array.isArray(value?.tasks) || !value.tasks.length) {
      return { ok: false, error: 'The plan needs at least one task.' };
    }
    if (value.tasks.length > MAX_TASKS) {
      return { ok: false, error: `The plan can contain at most ${MAX_TASKS} tasks.` };
    }

    const tasks = [];
    for (let index = 0; index < value.tasks.length; index++) {
      const task = value.tasks[index] || {};
      const title = String(task.title || '').trim();
      const objective = String(task.objective || '').trim();
      const acceptanceCriteria = Array.isArray(task.acceptance_criteria)
        ? task.acceptance_criteria.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      if (!title) return { ok: false, error: `Task ${index + 1} needs a title.` };
      if (!objective) return { ok: false, error: `Task ${index + 1} needs an objective.` };
      if (!acceptanceCriteria.length) {
        return { ok: false, error: `Task ${index + 1} needs at least one acceptance criterion.` };
      }
      tasks.push({
        title,
        objective,
        acceptance_criteria: acceptanceCriteria,
        relevant_files: Array.isArray(task.relevant_files) ? task.relevant_files : [],
        constraints: Array.isArray(task.constraints) ? task.constraints : [],
      });
    }
    return { ok: true, plan: { summary, tasks } };
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function planField(labelText, fieldName, value, rows = 1) {
    const label = node('label', 'plan-field');
    label.appendChild(node('span', 'plan-field-label', labelText));
    const input = rows > 1 ? node('textarea', 'plan-input') : node('input', 'plan-input');
    if (rows > 1) input.rows = rows;
    else input.type = 'text';
    input.value = value || '';
    input.dataset.planField = fieldName;
    input.dataset.planInput = 'true';
    label.appendChild(input);
    return label;
  }

  function taskElement(task, index) {
    const section = node('section', 'plan-task');
    section.dataset.planTask = 'true';
    const head = node('div', 'plan-task-head');
    head.appendChild(node('span', 'plan-task-number', `TASK ${index + 1}`));
    const remove = node('button', 'mini deny plan-remove', 'REMOVE');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      const card = section.closest('.plan-card');
      if (card.querySelectorAll('[data-plan-task]').length <= 1) {
        card.dispatchEvent(new CustomEvent('plan:error', { detail: 'The plan needs at least one task.' }));
        return;
      }
      section.remove();
      renumberTasks(card);
    });
    head.appendChild(remove);
    section.appendChild(head);
    section.appendChild(planField('Title', 'title', task?.title, 1));
    section.appendChild(planField('Objective', 'objective', task?.objective, 3));
    section.appendChild(planField('Acceptance criteria · one per line', 'acceptance_criteria', (task?.acceptance_criteria || []).join('\n'), 3));
    const details = node('div', 'plan-task-details');
    details.appendChild(planField('Relevant files · one per line', 'relevant_files', (task?.relevant_files || []).join('\n'), 2));
    details.appendChild(planField('Constraints · one per line', 'constraints', (task?.constraints || []).join('\n'), 2));
    section.appendChild(details);
    return section;
  }

  function renumberTasks(card) {
    [...card.querySelectorAll('[data-plan-task]')].forEach((task, index) => {
      task.querySelector('.plan-task-number').textContent = `TASK ${index + 1}`;
    });
  }

  function readPlan(card) {
    const tasks = [...card.querySelectorAll('[data-plan-task]')].map((task) => ({
      title: task.querySelector('[data-plan-field="title"]').value,
      objective: task.querySelector('[data-plan-field="objective"]').value,
      acceptance_criteria: lines(task.querySelector('[data-plan-field="acceptance_criteria"]').value),
      relevant_files: lines(task.querySelector('[data-plan-field="relevant_files"]').value),
      constraints: lines(task.querySelector('[data-plan-field="constraints"]').value),
    }));
    return {
      summary: card.querySelector('[data-plan-field="summary"]').value,
      tasks,
    };
  }

  function setEditing(card, editing) {
    card.dataset.editing = editing ? 'true' : 'false';
    card.querySelector('.plan-status').textContent = editing ? 'EDITING' : 'READY';
    card.querySelector('.plan-edit').textContent = editing ? 'DONE' : 'EDIT';
    card.querySelector('.plan-add').classList.toggle('hidden', !editing);
    for (const input of card.querySelectorAll('[data-plan-input]')) input.readOnly = !editing;
    for (const button of card.querySelectorAll('.plan-remove')) button.classList.toggle('hidden', !editing);
  }

  function setActionsDisabled(card, disabled) {
    for (const button of card.querySelectorAll('.plan-actions button')) button.disabled = disabled;
  }

  function create({ draft, onRun, onCancel, onError }) {
    const card = node('section', 'plan-card');
    card.dataset.status = 'ready';
    const head = node('div', 'plan-head');
    head.appendChild(node('span', 'plan-title', 'IMPLEMENTATION PLAN'));
    head.appendChild(node('span', 'plan-status', 'READY'));
    card.appendChild(head);
    card.appendChild(node('div', 'plan-goal', draft.goal));
    const projectName = String(draft.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '(unknown project)';
    card.appendChild(node('div', 'plan-meta', `${projectName} · planned by ${draft.plannerModel}`));
    card.appendChild(planField('Summary', 'summary', draft.plan.summary, 3));

    const tasks = node('div', 'plan-tasks');
    for (const [index, task] of draft.plan.tasks.entries()) tasks.appendChild(taskElement(task, index));
    card.appendChild(tasks);

    const actions = node('div', 'plan-actions');
    const add = node('button', 'mini plan-add hidden', 'ADD TASK');
    const run = node('button', 'approve plan-run', 'RUN');
    const edit = node('button', 'plan-edit', 'EDIT');
    const cancel = node('button', 'deny plan-cancel', 'CANCEL');
    for (const button of [add, run, edit, cancel]) button.type = 'button';
    actions.appendChild(add);
    actions.appendChild(run);
    actions.appendChild(edit);
    actions.appendChild(cancel);
    card.appendChild(actions);

    card.addEventListener('plan:error', (event) => onError(event.detail));
    add.addEventListener('click', () => {
      const count = tasks.querySelectorAll('[data-plan-task]').length;
      if (count >= MAX_TASKS) return onError(`The plan can contain at most ${MAX_TASKS} tasks.`);
      tasks.appendChild(taskElement({ acceptance_criteria: [], relevant_files: [], constraints: [] }, count));
      renumberTasks(card);
      tasks.lastElementChild.querySelector('[data-plan-field="title"]').focus();
    });
    edit.addEventListener('click', () => setEditing(card, card.dataset.editing !== 'true'));
    cancel.addEventListener('click', () => {
      onCancel();
      card.remove();
    });
    run.addEventListener('click', async () => {
      const validated = validatePlan(readPlan(card));
      if (!validated.ok) return onError(validated.error);
      setEditing(card, false);
      setActionsDisabled(card, true);
      card.dataset.status = 'running';
      card.querySelector('.plan-status').textContent = 'RUNNING';
      let result;
      try {
        result = await onRun(validated.plan);
      } catch (error) {
        result = { ok: false, error: error.message || String(error) };
      }
      if (result?.ok && !result.stopped) {
        card.dataset.status = 'executed';
        card.querySelector('.plan-status').textContent = 'EXECUTED';
        run.classList.add('hidden');
        edit.classList.add('hidden');
        add.classList.add('hidden');
        cancel.textContent = 'DISMISS';
        cancel.disabled = false;
      } else {
        card.dataset.status = 'ready';
        card.querySelector('.plan-status').textContent = result?.stopped ? 'STOPPED' : 'READY';
        setActionsDisabled(card, false);
        if (result?.error) onError(result.error);
      }
    });

    setEditing(card, false);
    return card;
  }

  const api = { MAX_TASKS, create, lines, validatePlan };
  global.PlanDraftView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window === 'undefined' ? globalThis : window));
