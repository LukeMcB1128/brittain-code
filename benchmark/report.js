const fs = require('fs');
const path = require('path');
const { TASKS } = require('./tasks');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const median = (values) => {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
};
const mean = (values) => {
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? Math.round((usable.reduce((sum, value) => sum + value, 0) / usable.length) * 10) / 10 : null;
};

function stripOllamaPrefix(value) {
  return String(value ?? '').replace(/\bollama:/g, '');
}

function canonicalThink(settings = {}) {
  return settings.think === undefined ? 'unknown' : settings.think ? 'on' : 'off';
}

function canonicalContext(settings = {}) {
  return settings.contextCap || settings.requestedContextCap || null;
}

function unique(values) {
  return [...new Set(values)];
}

function mergedDisplayLabel(entries) {
  const baseLabel = entries[0]?.baseLabel || entries[0]?.modelLabel || entries[0]?.label || '(unknown)';
  const allLabels = unique(entries.map((entry) => entry.label));
  const contextFragments = unique(allLabels.map((label) => {
    const match = String(label).match(/\(([^)]*ctx[^)]*)\)/);
    return match ? match[1] : null;
  }).filter(Boolean));
  const settingParts = [];
  if (contextFragments.length === 1 && entries.every((entry) => /\bctx\b/.test(String(entry.label)))) settingParts.push(contextFragments[0]);
  if (entries[0]?.think !== 'unknown') settingParts.push(entries[0].think === 'on' ? 'think on' : 'think off');
  return settingParts.length ? `${baseLabel} (${settingParts.join(', ')})` : baseLabel;
}

function canonicalGroupKey(row) {
  const settings = row.settings || {};
  return [
    row.task || 'unknown',
    number(row.taskVersion, 0),
    row.mode || 'unknown',
    stripOllamaPrefix(row.modelLabel || row.model || '(unknown)'),
    canonicalThink(settings),
  ].join('|');
}

function normalize(row) {
  if (row.schemaVersion === 3) {
    const model = stripOllamaPrefix(row.model || '');
    const plannerModel = stripOllamaPrefix(row.plannerModel || row.model || '');
    const coderModel = row.coderModel ? stripOllamaPrefix(row.coderModel) : row.coderModel;
    const verifierModel = row.verifierModel ? stripOllamaPrefix(row.verifierModel) : row.verifierModel;
    return {
      ...row,
      model: model || row.model,
      plannerModel: plannerModel || row.plannerModel || row.model,
      coderModel,
      verifierModel,
      modelLabel: stripOllamaPrefix(row.modelLabel || row.model || '(unknown)'),
    };
  }
  if (row.schemaVersion === 2) {
    return {
      ...row,
      suiteVersion: 2,
      graderVersion: 2,
      scoreModel: 'brittainmark-v2',
      taskLanguage: row.taskLanguage || 'javascript',
      zeroed: false,
      zeroedReasons: [],
      scorePerMinute: row.wallTimeMs ? Math.round((number(row.total) / (row.wallTimeMs / 60000)) * 100) / 100 : null,
    };
  }
  return {
    ...row,
    schemaVersion: 1,
    suiteVersion: 1,
    graderVersion: 1,
    scoreModel: 'legacy',
    task: 'cart',
    taskVersion: 1,
    taskLanguage: 'javascript',
    mode: 'solo',
    modelLabel: row.model || '(unknown)',
    correctness: number(row.output),
    safety: 0,
    reliability: number(row.discipline),
    efficiency: 0,
    visibleTotal: 8,
    hiddenTotal: 6,
    fullPass: number(row.visible) === 8 && number(row.hidden) === 6,
    configKey: `legacy|cart|${row.model || '(unknown)'}`,
    zeroed: false,
    zeroedReasons: [],
    scorePerMinute: row.wallTimeMs ? Math.round((number(row.total) / (row.wallTimeMs / 60000)) * 100) / 100 : null,
  };
}

function aggregate(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = canonicalGroupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, runs]) => {
    const totals = runs.map((run) => number(run.total));
    const settings = runs[0].settings || {};
    const baseLabel = runs[0].modelLabel;
    const thinkState = canonicalThink(settings);
    const contextCaps = unique(runs.map((run) => canonicalContext(run.settings || {})).filter(Boolean));
    const everyRunHasSameContext = contextCaps.length === 1 && runs.every((run) => canonicalContext(run.settings || {}) === contextCaps[0]);
    const settingParts = [];
    if (everyRunHasSameContext) settingParts.push(`${Math.round(contextCaps[0] / 1024)}k ctx`);
    if (settings.think !== undefined) settingParts.push(settings.think ? 'think on' : 'think off');
    const displayLabel = settingParts.length ? `${baseLabel} (${settingParts.join(', ')})` : baseLabel;
    return {
      key,
      baseLabel,
      task: runs[0].task,
      taskVersion: number(runs[0].taskVersion, 1),
      taskLanguage: runs[0].taskLanguage || 'unknown',
      suiteVersion: number(runs[0].suiteVersion, 0),
      mode: runs[0].mode,
      think: thinkState,
      label: displayLabel,
      modelLabel: runs[0].modelLabel,
      runs: runs.length,
      median: median(totals),
      min: Math.min(...totals),
      max: Math.max(...totals),
      passRate: runs.filter((run) => run.fullPass).length / runs.length,
      zeroedRate: runs.filter((run) => run.zeroed).length / runs.length,
      wallMs: median(runs.map((run) => run.wallTimeMs).filter(Boolean)),
      generated: median(runs.map((run) => run.generatedTokens).filter((value) => value !== undefined && value !== null)),
      tools: median(runs.map((run) => run.toolCalls).filter((value) => value !== undefined)),
      scorePerMinute: median(runs.map((run) => run.scorePerMinute).filter((value) => value !== undefined && value !== null)),
      correctness: median(runs.map((run) => run.correctness)),
      safety: median(runs.map((run) => run.safety)),
      reliability: median(runs.map((run) => run.reliability)),
      efficiency: median(runs.map((run) => run.efficiency)),
    };
  }).sort((a, b) => b.median - a.median || b.passRate - a.passRate || a.label.localeCompare(b.label));
}

function averageAcrossTasks(groups, totalTaskCount) {
  const configs = new Map();
  for (const group of groups) {
    const key = [group.mode, group.think, group.baseLabel || group.modelLabel || group.label].join('|');
    if (!configs.has(key)) configs.set(key, []);
    configs.get(key).push(group);
  }
  return [...configs.values()].map((entries) => {
    const byTask = new Map(entries.map((entry) => [entry.task, entry]));
    const qualified = [...byTask.values()].length === totalTaskCount && [...byTask.values()].every((entry) => entry.runs >= 3);
    const baseLabel = entries[0].baseLabel || entries[0].modelLabel || entries[0].label;
    const mergedLabel = mergedDisplayLabel(entries);
    return {
      ...entries[0],
      baseLabel,
      task: 'all',
      taskCount: byTask.size,
      totalTaskCount,
      qualified,
      label: mergedLabel,
      runs: entries.reduce((sum, entry) => sum + entry.runs, 0),
      median: mean(entries.map((entry) => entry.median)),
      min: Math.min(...entries.map((entry) => entry.min)),
      max: Math.max(...entries.map((entry) => entry.max)),
      passRate: entries.reduce((sum, entry) => sum + entry.passRate * entry.runs, 0) / entries.reduce((sum, entry) => sum + entry.runs, 0),
      zeroedRate: entries.reduce((sum, entry) => sum + entry.zeroedRate * entry.runs, 0) / entries.reduce((sum, entry) => sum + entry.runs, 0),
      wallMs: mean(entries.map((entry) => entry.wallMs).filter(Boolean)),
      generated: mean(entries.map((entry) => entry.generated).filter((value) => value !== null)),
      tools: mean(entries.map((entry) => entry.tools).filter((value) => value !== null)),
      scorePerMinute: mean(entries.map((entry) => entry.scorePerMinute).filter((value) => value !== null)),
      correctness: mean(entries.map((entry) => entry.correctness)),
      safety: mean(entries.map((entry) => entry.safety)),
      reliability: mean(entries.map((entry) => entry.reliability)),
      efficiency: mean(entries.map((entry) => entry.efficiency)),
    };
  }).sort((a, b) => {
    if (b.qualified !== a.qualified) return Number(b.qualified) - Number(a.qualified);
    return b.median - a.median || b.taskCount - a.taskCount || b.passRate - a.passRate || a.label.localeCompare(b.label);
  });
}

function scoreChart(groups, averaging = false) {
  if (!groups.length) return '<p class="muted empty-view">No matching V3 results yet.</p>';
  const chartW = 1140, labelW = 380, plotRight = 1090, rowH = 52, chartTop = 34;
  const chartH = Math.max(100, chartTop + groups.length * rowH + 12);
  const scoreX = (value) => labelW + (number(value) / 100) * (plotRight - labelW);
  const grid = [0, 25, 50, 75, 100].map((value) =>
    `<line x1="${scoreX(value)}" y1="24" x2="${scoreX(value)}" y2="${chartH - 8}" class="grid"/><text x="${scoreX(value)}" y="15" class="top-tick">${value}</text>`
  ).join('');
  const bars = groups.map((group, index) => {
    const y = chartTop + index * rowH;
    const end = scoreX(group.median);
    const rangeStart = scoreX(group.min);
    const rangeEnd = scoreX(group.max);
    const coverage = averaging ? ` · tasks ${group.taskCount}/${group.totalTaskCount}` : '';
    const title = `${averaging ? 'suite average' : `${group.task} v${group.taskVersion}`} · ${group.mode}\n${group.label}\nscore ${group.median}/100, range ${group.min}–${group.max}, pass ${(group.passRate * 100).toFixed(0)}%, n=${group.runs}${coverage}`;
    return `<g><title>${esc(title)}</title>` +
      `<text x="${labelW - 16}" y="${y + 17}" class="bar-label">${esc(group.label)}</text>` +
      `<text x="${labelW - 16}" y="${y + 34}" class="bar-meta">${esc(`${averaging ? 'suite average' : `${group.task} v${group.taskVersion}`} · ${group.mode} · n=${group.runs} · pass ${(group.passRate * 100).toFixed(0)}%${group.qualified ? ' · qualified' : ''}${coverage}`)}</text>` +
      `<rect x="${labelW}" y="${y + 8}" width="${Math.max(1, end - labelW)}" height="25" rx="4" class="bar"/>` +
      `<line x1="${rangeStart}" y1="${y + 37}" x2="${rangeEnd}" y2="${y + 37}" class="error"/>` +
      `<line x1="${rangeStart}" y1="${y + 33}" x2="${rangeStart}" y2="${y + 41}" class="error"/><line x1="${rangeEnd}" y1="${y + 33}" x2="${rangeEnd}" y2="${y + 41}" class="error"/>` +
      `<text x="${Math.min(end + 9, chartW - 24)}" y="${y + 26}" class="bar-score">${group.median}</text></g>`;
  }).join('');
  return `<svg class="score-chart" viewBox="0 0 ${chartW} ${chartH}" role="img" aria-label="${averaging ? 'Average' : 'Median'} benchmark scores">${grid}${bars}</svg>`;
}

function velocityChart(groups, averaging = false) {
  const velocityGroups = groups.filter((group) => number(group.scorePerMinute, null) !== null);
  if (!velocityGroups.length) return '<p class="muted empty-view">No telemetry-backed V3 results yet.</p>';
  const maxVelocity = Math.max(1, ...velocityGroups.map((group) => group.scorePerMinute || 0));
  const chartW = 1140, labelW = 380, plotRight = 1090, rowH = 48, chartTop = 34;
  const chartH = Math.max(100, chartTop + velocityGroups.length * rowH + 12);
  const velocityX = (value) => labelW + (number(value) / maxVelocity) * (plotRight - labelW);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const value = Math.round(maxVelocity * fraction * 10) / 10;
    return `<line x1="${velocityX(value)}" y1="24" x2="${velocityX(value)}" y2="${chartH - 8}" class="grid"/><text x="${velocityX(value)}" y="15" class="top-tick">${value}</text>`;
  }).join('');
  const bars = velocityGroups.map((group, index) => {
    const y = chartTop + index * rowH;
    const end = velocityX(group.scorePerMinute);
    const meta = averaging ? `suite average · tasks ${group.taskCount}/${group.totalTaskCount}` : `${group.task} v${group.taskVersion} · ${group.mode}`;
    return `<g><title>${esc(`${group.label}\n${group.scorePerMinute} score/min · ${(group.wallMs / 1000).toFixed(1)}s`)}</title>` +
      `<text x="${labelW - 16}" y="${y + 17}" class="bar-label">${esc(group.label)}</text>` +
      `<text x="${labelW - 16}" y="${y + 34}" class="bar-meta">${esc(`${meta} · ${(group.wallMs / 1000).toFixed(1)}s median · zeroed ${(group.zeroedRate * 100).toFixed(0)}%`)}</text>` +
      `<rect x="${labelW}" y="${y + 8}" width="${Math.max(1, end - labelW)}" height="25" rx="4" class="bar velocity"/>` +
      `<text x="${Math.min(end + 9, chartW - 24)}" y="${y + 26}" class="bar-score">${group.scorePerMinute}</text></g>`;
  }).join('');
  return `<svg class="score-chart" viewBox="0 0 ${chartW} ${chartH}" role="img" aria-label="${averaging ? 'Average' : 'Median'} score per elapsed minute">${grid}${bars}</svg>`;
}

function heatmap(groups, taskChoice, modeChoice, thinkChoice, tasks) {
  const filtered = groups.filter((group) =>
    (taskChoice === 'all' || group.task === taskChoice)
    && (modeChoice === 'all' || group.mode === modeChoice)
    && (thinkChoice === 'all' || group.think === thinkChoice));
  if (!filtered.length || taskChoice !== 'all') return '<p class="muted empty-view">Task matrix is available when viewing all tasks.</p>';
  const modelGroups = new Map();
  for (const group of filtered) {
    const key = group.baseLabel || group.modelLabel || group.label;
    if (!modelGroups.has(key)) modelGroups.set(key, []);
    modelGroups.get(key).push(group);
  }
  const labels = [...modelGroups.entries()]
    .sort((a, b) => {
      const scoreA = mean(a[1].map((group) => group.median)) || 0;
      const scoreB = mean(b[1].map((group) => group.median)) || 0;
      return scoreB - scoreA || a[0].localeCompare(b[0]);
    })
    .map(([key, entries]) => ({ key, label: mergedDisplayLabel(entries), entries }));
  const cell = (group) => {
    if (!group) return '<td class="heat empty">—</td>';
    const alpha = Math.max(0.08, number(group.median) / 100);
    return `<td class="heat" style="background:rgba(9,105,218,${alpha})"><b>${group.median}</b><small>n=${group.runs}</small></td>`;
  };
  const rows = labels.map(({ key, label, entries }) => {
    const row = tasks.map((task) => entries.find((group) => group.task === task));
    const qualified = row.every((entry) => entry && entry.runs >= 3);
    return `<tr><th class="left">${esc(label)}${qualified ? ' <span class="badge">qualified</span>' : ''}</th>${row.map(cell).join('')}</tr>`;
  }).join('');
  return `<table class="heatmap"><thead><tr><th class="left">Model / team</th>${tasks.map((task) => `<th>${esc(task)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}

function writeReport(resultsPath, htmlPath) {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(resultsPath, 'utf8')); } catch {}
  const rows = raw.map(normalize);
  const currentVersion = Object.fromEntries(Object.entries(TASKS).map(([id, task]) => [id, task.version]));
  const currentRows = rows.filter((row) => row.suiteVersion === 3 && number(row.taskVersion, 0) === currentVersion[row.task]);
  const archivedRows = rows.filter((row) => !(row.suiteVersion === 3 && number(row.taskVersion, 0) === currentVersion[row.task]));
  const groups = aggregate(currentRows);
  const archivedGroups = aggregate(archivedRows);
  const tasks = Object.keys(TASKS).sort();
  const modes = [...new Set(currentRows.map((row) => row.mode))].sort();
  const thinks = [...new Set(groups.map((group) => group.think))].sort();

  const taskChoices = ['all', ...tasks];
  const modeChoices = ['all', ...modes];
  const thinkChoices = ['all', ...thinks];
  const views = [];
  for (const taskChoice of taskChoices) {
    for (const modeChoice of modeChoices) {
      for (const thinkChoice of thinkChoices) {
        const matching = groups.filter((group) =>
          (taskChoice === 'all' || group.task === taskChoice)
          && (modeChoice === 'all' || group.mode === modeChoice)
          && (thinkChoice === 'all' || group.think === thinkChoice));
        const displayed = taskChoice === 'all' ? averageAcrossTasks(matching, tasks.length) : matching;
        const key = [taskChoice, modeChoice, thinkChoice].join('|');
        views.push({
          key,
          score: scoreChart(displayed, taskChoice === 'all'),
          velocity: velocityChart(displayed, taskChoice === 'all'),
          heatmap: heatmap(groups, taskChoice, modeChoice, thinkChoice, tasks),
        });
      }
    }
  }
  const chart = views.map((view) => `<div class="chart-view" data-view-key="${esc(view.key)}">${view.score}</div>`).join('');
  const velocity = views.map((view) => `<div class="chart-view" data-view-key="${esc(view.key)}">${view.velocity}</div>`).join('');
  const matrix = views.map((view) => `<div class="chart-view" data-view-key="${esc(view.key)}">${view.heatmap}</div>`).join('');

  const qualifiedConfigs = averageAcrossTasks(groups, tasks.length).filter((group) => group.qualified).length;
  const aggregateRow = (group, filterable = false) => `<tr${filterable ? ` data-task="${esc(group.task)}" data-mode="${esc(group.mode)}" data-think="${group.think}"` : ''}><td>${esc(group.task)}</td><td>v${group.taskVersion}</td><td>${esc(group.taskLanguage || '—')}</td><td>${esc(group.mode)}</td><td class="left">${esc(group.label)}</td><td><b>${group.median}</b></td><td>${group.min}–${group.max}</td><td>${group.runs}</td><td>${(group.passRate * 100).toFixed(0)}%</td><td>${(group.zeroedRate * 100).toFixed(0)}%</td><td>${group.correctness}</td><td>${group.safety}</td><td>${group.reliability}</td><td>${group.efficiency}</td><td>${group.scorePerMinute ?? '—'}</td><td>${group.wallMs ? (group.wallMs / 1000).toFixed(1) + 's' : '—'}</td></tr>`;
  const runRow = (row, filterable = false) => `<tr${filterable ? ` data-task="${esc(row.task)}" data-mode="${esc(row.mode)}" data-think="${row.settings?.think === undefined ? 'unknown' : row.settings.think ? 'on' : 'off'}"` : ''}><td>${esc(row.task)}</td><td>v${number(row.taskVersion, 1)}</td><td>${esc(row.taskLanguage || '—')}</td><td>${esc(row.mode)}</td><td class="left">${esc(row.modelLabel)}</td><td><b>${row.total}</b></td><td>${row.correctness}</td><td>${row.safety}</td><td>${row.reliability}</td><td>${row.efficiency}</td><td>${row.visible}/${row.visibleTotal}</td><td>${row.hidden}/${row.hiddenTotal}</td><td>${row.scorePerMinute ?? '—'}</td><td>${row.wallTimeMs ? (row.wallTimeMs / 1000).toFixed(1) + 's' : '—'}</td><td>${row.zeroed ? esc(row.zeroedReasons.join('; ')) : '—'}</td><td>${esc((row.gradedAt || '').slice(0, 16).replace('T', ' '))}</td></tr>`;
  const aggregateRows = groups.map((group) => aggregateRow(group, true)).join('');
  const runRows = currentRows.slice().sort((a, b) => String(b.gradedAt).localeCompare(String(a.gradedAt))).map((row) => runRow(row, true)).join('');
  const archivedAggregateRows = archivedGroups.map((group) => aggregateRow(group)).join('');
  const archivedRunRows = archivedRows.slice().sort((a, b) => String(b.gradedAt).localeCompare(String(a.gradedAt))).map((row) => runRow(row)).join('');
  const versionBadges = tasks.map((task) => {
    const count = currentRows.filter((row) => row.task === task).length;
    return `<span class="version-badge"><b>${esc(task)} v${currentVersion[task]}</b><small>${count} V3 run${count === 1 ? '' : 's'}</small></span>`;
  }).join('');
  const options = (values) => '<option value="all">all</option>' + values.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brittainmark v3</title><style>
  :root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--card:#f6f8fa;--line:#d0d7de;--accent:#0969da;--accent2:#1a7f37;--badge:#8250df}
  @media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--line:#30363d;--accent:#58a6ff;--accent2:#3fb950;--badge:#a371f7}}
  *{box-sizing:border-box}body{margin:0;padding:30px;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}h1{font-size:24px;margin:0}.muted,.sub{color:var(--muted)}.sub{margin:4px 0 18px}.version-strip{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}.version-badge{display:flex;align-items:baseline;gap:7px;padding:6px 9px;border:1px solid var(--line);border-radius:7px;background:var(--card);font-size:11px}.version-badge small{color:var(--muted)}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:20px}.summary .stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.summary b{display:block;font-size:22px}.filters{display:flex;flex-wrap:wrap;gap:12px 18px;margin-bottom:20px}.filters label{display:flex;align-items:center;gap:7px;font-weight:600}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:22px;overflow:auto}h2{font-size:15px;margin:0 0 16px}.chart-view{display:none}.score-chart{display:block;width:100%;height:auto;min-width:760px}.empty-view{padding:18px 2px}.grid{stroke:var(--line);stroke-width:1}.top-tick{fill:var(--muted);font-size:11px;text-anchor:middle}.bar{fill:var(--accent);opacity:.9}.bar.velocity{fill:var(--accent2)}.error{stroke:var(--fg);stroke-width:1.5}.bar-label{fill:var(--fg);font-size:13px;font-weight:650;text-anchor:end}.bar-meta{fill:var(--muted);font-size:10px;text-anchor:end}.bar-score{fill:var(--fg);font-size:13px;font-weight:750}.heatmap{border-collapse:collapse;width:100%;font-size:12px}.heatmap th,.heatmap td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:center}.heatmap th.left,.heatmap td.left{text-align:left}.heat{min-width:82px}.heat b{display:block}.heat small{display:block;color:rgba(255,255,255,.86)}.heat.empty{background:transparent;color:var(--muted)}.badge{display:inline-block;padding:1px 6px;border-radius:999px;background:color-mix(in srgb, var(--badge) 20%, transparent);color:var(--badge);font-size:10px;font-weight:700}.archive h3{font-size:13px;margin:18px 0 8px}table{border-collapse:collapse;width:100%;white-space:nowrap;font-size:12px}th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:right}th{color:var(--muted);position:sticky;top:0;background:var(--card)}td.left,th.left{text-align:left}select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 9px}details.archive>summary{cursor:pointer;padding:18px 20px;font-weight:700}details.archive>.archive-body{padding:0 20px 20px}@media(max-width:760px){body{padding:16px}.card{padding:14px}.score-chart{min-width:680px}}
  </style></head><body>
  <h1>Brittainmark v3</h1>
  <p class="sub">${currentRows.length} current V3 runs · ${archivedRows.length} archived runs · qualified leaderboard requires all ${tasks.length} tasks with at least 3 runs each</p>
  <div class="summary">
    <div class="stat"><b>${currentRows.length}</b><span class="muted">Current V3 runs</span></div>
    <div class="stat"><b>${archivedRows.length}</b><span class="muted">Archived / legacy runs</span></div>
    <div class="stat"><b>${qualifiedConfigs}</b><span class="muted">Qualified configurations</span></div>
    <div class="stat"><b>${tasks.length}</b><span class="muted">Current tasks</span></div>
  </div>
  <div class="version-strip">${versionBadges}</div>
  <div class="filters"><label>Task <select id="task">${options(tasks)}</select></label><label>Mode <select id="mode">${options(modes)}</select></label><label>Thinking <select id="think">${options(thinks)}</select></label></div>
  <div class="card"><h2 id="score-heading">Average total score across tasks</h2>${chart}</div>
  <div class="card"><h2 id="velocity-heading">Average score per elapsed minute</h2>${velocity}</div>
  <div class="card"><h2>Task matrix</h2>${matrix}</div>
  <div class="card"><h2>Current configuration aggregates</h2><table><thead><tr><th>Task</th><th>Version</th><th>Lang</th><th>Mode</th><th class="left">Model/team</th><th>Median</th><th>Range</th><th>n</th><th>Pass</th><th>Zeroed</th><th>Correct</th><th>Safe</th><th>Reliable</th><th>Efficient</th><th>Score/min</th><th>Time</th></tr></thead><tbody>${aggregateRows}</tbody></table></div>
  <div class="card"><h2>Current individual runs</h2><table><thead><tr><th>Task</th><th>Version</th><th>Lang</th><th>Mode</th><th class="left">Model/team</th><th>Total</th><th>Correct</th><th>Safe</th><th>Reliable</th><th>Efficient</th><th>Visible</th><th>Hidden</th><th>Score/min</th><th>Time</th><th>Zeroed reason</th><th>Graded</th></tr></thead><tbody>${runRows}</tbody></table></div>
  <details class="card archive"><summary>Archived results (${archivedRows.length} runs)</summary><div class="archive-body">${archivedRows.length ? `<p class="muted">Legacy scoring and pre-V3 task versions are preserved here for reference only and never participate in the V3 leaderboard.</p><h3>Archived configurations</h3><table><thead><tr><th>Task</th><th>Version</th><th>Lang</th><th>Mode</th><th class="left">Model/team</th><th>Median</th><th>Range</th><th>n</th><th>Pass</th><th>Zeroed</th><th>Correct</th><th>Safe</th><th>Reliable</th><th>Efficient</th><th>Score/min</th><th>Time</th></tr></thead><tbody>${archivedAggregateRows}</tbody></table><h3>Archived individual runs</h3><table><thead><tr><th>Task</th><th>Version</th><th>Lang</th><th>Mode</th><th class="left">Model/team</th><th>Total</th><th>Correct</th><th>Safe</th><th>Reliable</th><th>Efficient</th><th>Visible</th><th>Hidden</th><th>Score/min</th><th>Time</th><th>Zeroed reason</th><th>Graded</th></tr></thead><tbody>${archivedRunRows}</tbody></table>` : '<p class="muted">No archived runs.</p>'}</div></details>
  <script>
    const task=document.getElementById('task'),mode=document.getElementById('mode'),think=document.getElementById('think');
    function filter(){
      const key=[task.value,mode.value,think.value].join('|');
      document.querySelectorAll('[data-view-key]').forEach(el=>{el.style.display=el.dataset.viewKey===key?'block':'none'});
      document.querySelectorAll('[data-task]').forEach(el=>{
        el.style.display=(task.value==='all'||el.dataset.task===task.value)&&(mode.value==='all'||el.dataset.mode===mode.value)&&(think.value==='all'||el.dataset.think===think.value)?'':'none';
      });
      document.getElementById('score-heading').textContent=task.value==='all'?'Average total score across tasks':'Median total score for '+task.value;
      document.getElementById('velocity-heading').textContent=(task.value==='all'?'Average':'Median')+' score per elapsed minute';
    }
    task.onchange=mode.onchange=think.onchange=filter; filter();
  </script></body></html>`;
  fs.writeFileSync(htmlPath, html);
  return htmlPath;
}

module.exports = { writeReport, aggregate, normalize };
if (require.main === module) {
  const out = writeReport(path.join(__dirname, 'results.json'), path.join(__dirname, 'report.html'));
  console.log('Wrote ' + out);
}
