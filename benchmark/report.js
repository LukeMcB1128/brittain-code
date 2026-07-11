#!/usr/bin/env node
/* Builds a self-contained aggregate benchmark report. */
const fs = require('fs');
const path = require('path');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const median = (values) => {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function normalize(row) {
  if (row.schemaVersion === 2) return row;
  return {
    ...row,
    schemaVersion: 1,
    task: 'cart',
    taskVersion: 1,
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
  };
}

function aggregate(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.configKey || [row.task, row.mode, row.modelLabel].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, runs]) => {
    const totals = runs.map((run) => number(run.total));
    const settings = runs[0].settings || {};
    const settingParts = [];
    if (settings.contextCap) settingParts.push(`${Math.round(settings.contextCap / 1024)}k ctx`);
    if (settings.think !== undefined) settingParts.push(settings.think ? 'think on' : 'think off');
    const displayLabel = settingParts.length ? `${runs[0].modelLabel} (${settingParts.join(', ')})` : runs[0].modelLabel;
    return {
      key,
      task: runs[0].task,
      mode: runs[0].mode,
      think: settings.think === undefined ? 'unknown' : settings.think ? 'on' : 'off',
      label: displayLabel,
      runs: runs.length,
      median: median(totals),
      min: Math.min(...totals),
      max: Math.max(...totals),
      passRate: runs.filter((run) => run.fullPass).length / runs.length,
      wallMs: median(runs.map((run) => run.wallTimeMs).filter(Boolean)),
      generated: median(runs.map((run) => run.generatedTokens).filter(Boolean)),
      tools: median(runs.map((run) => run.toolCalls).filter((value) => value !== undefined)),
      correctness: median(runs.map((run) => run.correctness)),
      reliability: median(runs.map((run) => run.reliability)),
      efficiency: median(runs.map((run) => run.efficiency)),
    };
  }).sort((a, b) => b.median - a.median || b.passRate - a.passRate || a.label.localeCompare(b.label));
}

const mean = (values) => {
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? Math.round((usable.reduce((sum, value) => sum + value, 0) / usable.length) * 10) / 10 : null;
};

function averageAcrossTasks(groups, totalTaskCount) {
  const configs = new Map();
  for (const group of groups) {
    const key = [group.mode, group.think, group.label].join('|');
    if (!configs.has(key)) configs.set(key, []);
    configs.get(key).push(group);
  }
  return [...configs.values()].map((entries) => ({
    ...entries[0],
    task: 'all',
    taskCount: new Set(entries.map((entry) => entry.task)).size,
    totalTaskCount,
    runs: entries.reduce((sum, entry) => sum + entry.runs, 0),
    median: mean(entries.map((entry) => entry.median)),
    min: Math.min(...entries.map((entry) => entry.min)),
    max: Math.max(...entries.map((entry) => entry.max)),
    passRate: entries.reduce((sum, entry) => sum + entry.passRate * entry.runs, 0) / entries.reduce((sum, entry) => sum + entry.runs, 0),
    wallMs: mean(entries.map((entry) => entry.wallMs).filter(Boolean)),
    generated: mean(entries.map((entry) => entry.generated).filter((value) => value !== null)),
    tools: mean(entries.map((entry) => entry.tools).filter((value) => value !== null)),
    correctness: mean(entries.map((entry) => entry.correctness)),
    reliability: mean(entries.map((entry) => entry.reliability)),
    efficiency: mean(entries.map((entry) => entry.efficiency)),
  })).sort((a, b) => b.median - a.median || b.taskCount - a.taskCount || b.passRate - a.passRate || a.label.localeCompare(b.label));
}

function scoreChart(groups, averaging = false) {
  if (!groups.length) return '<p class="muted empty-view">No matching results yet.</p>';
  const chartW = 1100, labelW = 360, plotRight = 1060, rowH = 46, chartTop = 34;
  const chartH = Math.max(90, chartTop + groups.length * rowH + 12);
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
    const title = `${averaging ? 'all-task average' : group.task} · ${group.mode}\n${group.label}\nscore ${group.median}/100, observed range ${group.min}–${group.max}, pass ${(group.passRate * 100).toFixed(0)}%, n=${group.runs}${coverage}`;
    return `<g><title>${esc(title)}</title>` +
      `<text x="${labelW - 16}" y="${y + 17}" class="bar-label">${esc(group.label)}</text>` +
      `<text x="${labelW - 16}" y="${y + 34}" class="bar-meta">${esc(`${averaging ? 'average' : group.task} · ${group.mode} · n=${group.runs} · pass ${(group.passRate * 100).toFixed(0)}%${coverage}`)}</text>` +
      `<rect x="${labelW}" y="${y + 8}" width="${Math.max(1, end - labelW)}" height="25" rx="4" class="bar"/>` +
      `<line x1="${rangeStart}" y1="${y + 37}" x2="${rangeEnd}" y2="${y + 37}" class="error"/>` +
      `<line x1="${rangeStart}" y1="${y + 33}" x2="${rangeStart}" y2="${y + 41}" class="error"/><line x1="${rangeEnd}" y1="${y + 33}" x2="${rangeEnd}" y2="${y + 41}" class="error"/>` +
      `<text x="${Math.min(end + 9, chartW - 24)}" y="${y + 26}" class="bar-score">${group.median}</text></g>`;
  }).join('');
  return `<svg class="score-chart" viewBox="0 0 ${chartW} ${chartH}" role="img" aria-label="${averaging ? 'Average' : 'Median'} benchmark scores">${grid}${bars}</svg>`;
}

function scatterChart(groups, averaging = false) {
  const scatterGroups = groups.filter((group) => group.wallMs);
  if (!scatterGroups.length) return '<p class="muted empty-view">No matching telemetry-backed results yet.</p>';
  const maxWall = Math.max(1, ...scatterGroups.map((group) => group.wallMs || 0));
  const scatterW = 1100, scatterH = 390, sL = 70, sT = 28, sB = 55;
  const sx = (ms) => sL + (number(ms) / maxWall) * (scatterW - sL - 30);
  const sy = (score) => sT + (1 - number(score) / 55) * (scatterH - sT - sB);
  const scatterGrid = [0, 11, 22, 33, 44, 55].map((value) => `<line x1="${sL}" y1="${sy(value)}" x2="${scatterW - 20}" y2="${sy(value)}" class="grid"/><text x="${sL - 12}" y="${sy(value) + 4}" class="tick">${value}</text>`).join('');
  const dots = scatterGroups.map((group, index) => {
    const color = `hsl(${(index * 47 + 130) % 360} 62% 52%)`;
    return `<g><title>${esc(`${group.label}\n${group.correctness}/55 correctness · ${(group.wallMs / 1000).toFixed(1)}s ${averaging ? 'average' : 'median'}`)}</title><circle cx="${sx(group.wallMs)}" cy="${sy(group.correctness)}" r="12" style="fill:${color}"/><text x="${sx(group.wallMs)}" y="${sy(group.correctness) + 4}" class="dot-number">${index + 1}</text></g>`;
  }).join('');
  const legend = scatterGroups.map((group, index) => `<div class="legend-item"><span class="legend-number" style="background:hsl(${(index * 47 + 130) % 360} 62% 52%)">${index + 1}</span><span><b>${esc(group.label)}</b><small>${group.correctness}/55 · ${(group.wallMs / 1000).toFixed(1)}s · ${averaging ? `${group.taskCount}/${group.totalTaskCount} tasks` : `${esc(group.task)} ${esc(group.mode)}`}</small></span></div>`).join('');
  return `<svg class="scatter-chart" viewBox="0 0 ${scatterW} ${scatterH}" role="img" aria-label="Correctness versus elapsed time">${scatterGrid}<line x1="${sL}" y1="${sT}" x2="${sL}" y2="${scatterH - sB}" class="axis"/><line x1="${sL}" y1="${scatterH - sB}" x2="${scatterW - 20}" y2="${scatterH - sB}" class="axis"/><text x="${scatterW / 2}" y="${scatterH - 10}" class="axislabel">${averaging ? 'average' : 'median'} wall time (max ${(maxWall / 1000).toFixed(0)}s)</text><text x="18" y="${scatterH / 2}" transform="rotate(-90 18 ${scatterH / 2})" class="axislabel">correctness /55</text>${dots}</svg><div class="legend">${legend}</div>`;
}

function writeReport(resultsPath, htmlPath) {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(resultsPath, 'utf8')); } catch {}
  const rows = raw.map(normalize);
  const groups = aggregate(rows);
  const tasks = [...new Set(rows.map((row) => row.task))].sort();
  const modes = [...new Set(rows.map((row) => row.mode))].sort();
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
        views.push({ key, score: scoreChart(displayed, taskChoice === 'all'), scatter: scatterChart(displayed, taskChoice === 'all') });
      }
    }
  }
  const chart = views.map((view) => `<div class="chart-view" data-view-key="${esc(view.key)}">${view.score}</div>`).join('');
  const scatter = views.map((view) => `<div class="chart-view" data-view-key="${esc(view.key)}">${view.scatter}</div>`).join('');

  const aggregateRows = groups.map((group) => `<tr data-task="${esc(group.task)}" data-mode="${esc(group.mode)}" data-think="${group.think}"><td>${esc(group.task)}</td><td>${esc(group.mode)}</td><td class="left">${esc(group.label)}</td><td><b>${group.median}</b></td><td>${group.min}–${group.max}</td><td>${group.runs}</td><td>${(group.passRate * 100).toFixed(0)}%</td><td>${group.correctness}</td><td>${group.reliability}</td><td>${group.efficiency}</td><td>${group.wallMs ? (group.wallMs / 1000).toFixed(1) + 's' : '—'}</td><td>${group.generated ?? '—'}</td><td>${group.tools ?? '—'}</td></tr>`).join('');
  const runRows = rows.slice().sort((a, b) => String(b.gradedAt).localeCompare(String(a.gradedAt))).map((row) => `<tr data-task="${esc(row.task)}" data-mode="${esc(row.mode)}" data-think="${row.settings?.think === undefined ? 'unknown' : row.settings.think ? 'on' : 'off'}"><td>${esc(row.task)}</td><td>${esc(row.mode)}</td><td class="left">${esc(row.modelLabel)}</td><td><b>${row.total}</b></td><td>${row.correctness}</td><td>${row.safety}</td><td>${row.reliability}</td><td>${row.efficiency}</td><td>${row.visible}/${row.visibleTotal}</td><td>${row.hidden}/${row.hiddenTotal}</td><td>${row.wallTimeMs ? (row.wallTimeMs / 1000).toFixed(1) + 's' : '—'}</td><td>${row.generatedTokens || '—'}</td><td>${row.toolCalls ?? '—'}</td><td>${esc((row.gradedAt || '').slice(0, 16).replace('T', ' '))}</td></tr>`).join('');

  const options = (values) => '<option value="all">all</option>' + values.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brittain Code benchmark v2</title><style>
  :root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--card:#f6f8fa;--line:#d0d7de;--accent:#0969da;--dot:#2da44e} @media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--line:#30363d;--accent:#58a6ff;--dot:#3fb950}}
  *{box-sizing:border-box}body{margin:0;padding:30px;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}h1{font-size:22px;margin:0}.muted,.sub{color:var(--muted)}.sub{margin:3px 0 20px}.filters{display:flex;flex-wrap:wrap;gap:12px 18px;margin-bottom:20px}.filters label{display:flex;align-items:center;gap:7px;font-weight:600}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:22px;overflow:auto}h2{font-size:15px;margin:0 0 16px}.chart-view{display:none}.score-chart,.scatter-chart{display:block;width:100%;height:auto;min-width:720px}.empty-view{padding:18px 2px}.grid{stroke:var(--line);stroke-width:1}.top-tick{fill:var(--muted);font-size:11px;text-anchor:middle}.tick{fill:var(--muted);font-size:11px;text-anchor:end}.bar{fill:var(--accent);opacity:.9}.error{stroke:var(--fg);stroke-width:1.5}.bar-label{fill:var(--fg);font-size:13px;font-weight:650;text-anchor:end}.bar-meta{fill:var(--muted);font-size:10px;text-anchor:end}.bar-score{fill:var(--fg);font-size:13px;font-weight:750}.axis{stroke:var(--muted);stroke-width:1.3}.axislabel{fill:var(--muted);font-size:11px;text-anchor:middle}.dot-number{fill:white;font-size:10px;font-weight:750;text-anchor:middle;pointer-events:none}.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:9px 22px;padding:8px 10px 2px}.legend-item{display:flex;gap:9px;align-items:flex-start;min-width:0}.legend-item>span:last-child{min-width:0}.legend-item b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.legend-item small{display:block;color:var(--muted);font-size:10px}.legend-number{flex:0 0 22px;height:22px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:10px;font-weight:750}table{border-collapse:collapse;width:100%;white-space:nowrap;font-size:12px}th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:right}th{color:var(--muted);position:sticky;top:0;background:var(--card)}td.left,th.left{text-align:left}select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 9px}@media(max-width:760px){body{padding:16px}.card{padding:14px}.score-chart,.scatter-chart{min-width:650px}}
  </style></head><body><h1>Brittain Code benchmark v2</h1><p class="sub">${rows.length} runs · ${groups.length} configurations · correctness-gated, deterministic grading</p><div class="filters"><label>Task <select id="task">${options(tasks)}</select></label><label>Mode <select id="mode">${options(modes)}</select></label><label>Thinking <select id="think">${options(thinks)}</select></label></div>
  <div class="card"><h2 id="score-heading">Average total score across tasks</h2>${chart}</div><div class="card"><h2 id="scatter-heading">Average correctness versus elapsed time</h2>${scatter}</div>
  <div class="card"><h2>Configuration aggregates</h2><table><thead><tr><th>Task</th><th>Mode</th><th class="left">Model/team</th><th>Median</th><th>Range</th><th>n</th><th>Pass</th><th>Correct</th><th>Reliable</th><th>Efficient</th><th>Time</th><th>Gen tok</th><th>Tools</th></tr></thead><tbody>${aggregateRows}</tbody></table></div>
  <div class="card"><h2>Individual runs</h2><table><thead><tr><th>Task</th><th>Mode</th><th class="left">Model/team</th><th>Total</th><th>Correct</th><th>Safe</th><th>Reliable</th><th>Efficient</th><th>Visible</th><th>Hidden</th><th>Time</th><th>Gen tok</th><th>Tools</th><th>Graded</th></tr></thead><tbody>${runRows}</tbody></table></div>
  <script>const task=document.getElementById('task'),mode=document.getElementById('mode'),think=document.getElementById('think');function filter(){const key=[task.value,mode.value,think.value].join('|');document.querySelectorAll('[data-view-key]').forEach(el=>{el.style.display=el.dataset.viewKey===key?'block':'none'});document.querySelectorAll('[data-task]').forEach(el=>{el.style.display=(task.value==='all'||el.dataset.task===task.value)&&(mode.value==='all'||el.dataset.mode===mode.value)&&(think.value==='all'||el.dataset.think===think.value)?'':'none'});document.getElementById('score-heading').textContent=task.value==='all'?'Average total score across tasks':'Median total score for '+task.value;document.getElementById('scatter-heading').textContent=(task.value==='all'?'Average':'Median')+' correctness versus elapsed time'}task.onchange=mode.onchange=think.onchange=filter;filter();</script></body></html>`;
  fs.writeFileSync(htmlPath, html);
  return htmlPath;
}

module.exports = { writeReport, aggregate, normalize };
if (require.main === module) {
  const out = writeReport(path.join(__dirname, 'results.json'), path.join(__dirname, 'report.html'));
  console.log('Wrote ' + out);
}
