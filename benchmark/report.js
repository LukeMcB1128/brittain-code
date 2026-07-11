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

function writeReport(resultsPath, htmlPath) {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(resultsPath, 'utf8')); } catch {}
  const rows = raw.map(normalize);
  const groups = aggregate(rows);
  const tasks = [...new Set(rows.map((row) => row.task))].sort();
  const modes = [...new Set(rows.map((row) => row.mode))].sort();

  const padL = 42, padT = 24, padB = 118, chartH = 260, barW = 48, gap = 24;
  const width = Math.max(480, padL + groups.length * (barW + gap) + gap);
  const height = padT + chartH + padB;
  const y = (value) => padT + (1 - value / 100) * chartH;
  const grid = [0, 25, 50, 75, 100].map((value) =>
    `<line x1="${padL}" y1="${y(value)}" x2="${width - 8}" y2="${y(value)}" class="grid"/><text x="${padL - 7}" y="${y(value) + 4}" class="tick">${value}</text>`
  ).join('');
  const bars = groups.map((group, index) => {
    const x = padL + gap + index * (barW + gap);
    const top = y(group.median);
    const errorTop = y(group.max);
    const errorBottom = y(group.min);
    const title = `${group.task} · ${group.mode}\n${group.label}\nmedian ${group.median}/100, range ${group.min}–${group.max}, pass ${(group.passRate * 100).toFixed(0)}%, n=${group.runs}`;
    return `<g data-task="${esc(group.task)}" data-mode="${esc(group.mode)}"><title>${esc(title)}</title>` +
      `<rect x="${x}" y="${top}" width="${barW}" height="${padT + chartH - top}" class="bar"/>` +
      `<line x1="${x + barW / 2}" y1="${errorTop}" x2="${x + barW / 2}" y2="${errorBottom}" class="error"/>` +
      `<line x1="${x + 12}" y1="${errorTop}" x2="${x + barW - 12}" y2="${errorTop}" class="error"/><line x1="${x + 12}" y1="${errorBottom}" x2="${x + barW - 12}" y2="${errorBottom}" class="error"/>` +
      `<text x="${x + barW / 2}" y="${top - 7}" class="score">${group.median}</text>` +
      `<text x="${x + barW / 2}" y="${padT + chartH + 15}" transform="rotate(-35 ${x + barW / 2} ${padT + chartH + 15})" class="xlabel">${esc(group.label)}</text></g>`;
  }).join('');
  const chart = groups.length ? `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${grid}${bars}</svg>` : '<p class="muted">No results yet.</p>';

  const maxWall = Math.max(1, ...groups.map((group) => group.wallMs || 0));
  const scatterW = 700, scatterH = 310, sL = 48, sT = 22, sB = 42;
  const sx = (ms) => sL + (number(ms) / maxWall) * (scatterW - sL - 18);
  const sy = (score) => sT + (1 - number(score) / 55) * (scatterH - sT - sB);
  const dots = groups.filter((group) => group.wallMs).map((group) =>
    `<g><title>${esc(`${group.label}\n${group.correctness}/55 correctness · ${(group.wallMs / 1000).toFixed(1)}s median`)}</title><circle cx="${sx(group.wallMs)}" cy="${sy(group.correctness)}" r="6" class="dot"/><text x="${sx(group.wallMs) + 9}" y="${sy(group.correctness) + 4}" class="dotlabel">${esc(group.label)}</text></g>`
  ).join('');
  const scatter = dots ? `<svg viewBox="0 0 ${scatterW} ${scatterH}" width="${scatterW}" height="${scatterH}"><line x1="${sL}" y1="${sT}" x2="${sL}" y2="${scatterH - sB}" class="axis"/><line x1="${sL}" y1="${scatterH - sB}" x2="${scatterW - 10}" y2="${scatterH - sB}" class="axis"/><text x="${scatterW / 2}" y="${scatterH - 7}" class="axislabel">median wall time (max ${(maxWall / 1000).toFixed(0)}s)</text><text x="12" y="${scatterH / 2}" transform="rotate(-90 12 ${scatterH / 2})" class="axislabel">correctness /55</text>${dots}</svg>` : '<p class="muted">New telemetry-backed runs will appear here.</p>';

  const aggregateRows = groups.map((group) => `<tr data-task="${esc(group.task)}" data-mode="${esc(group.mode)}"><td>${esc(group.task)}</td><td>${esc(group.mode)}</td><td class="left">${esc(group.label)}</td><td><b>${group.median}</b></td><td>${group.min}–${group.max}</td><td>${group.runs}</td><td>${(group.passRate * 100).toFixed(0)}%</td><td>${group.correctness}</td><td>${group.reliability}</td><td>${group.efficiency}</td><td>${group.wallMs ? (group.wallMs / 1000).toFixed(1) + 's' : '—'}</td><td>${group.generated ?? '—'}</td><td>${group.tools ?? '—'}</td></tr>`).join('');
  const runRows = rows.slice().sort((a, b) => String(b.gradedAt).localeCompare(String(a.gradedAt))).map((row) => `<tr data-task="${esc(row.task)}" data-mode="${esc(row.mode)}"><td>${esc(row.task)}</td><td>${esc(row.mode)}</td><td class="left">${esc(row.modelLabel)}</td><td><b>${row.total}</b></td><td>${row.correctness}</td><td>${row.safety}</td><td>${row.reliability}</td><td>${row.efficiency}</td><td>${row.visible}/${row.visibleTotal}</td><td>${row.hidden}/${row.hiddenTotal}</td><td>${row.wallTimeMs ? (row.wallTimeMs / 1000).toFixed(1) + 's' : '—'}</td><td>${row.generatedTokens || '—'}</td><td>${row.toolCalls ?? '—'}</td><td>${esc((row.gradedAt || '').slice(0, 16).replace('T', ' '))}</td></tr>`).join('');

  const options = (values) => '<option value="all">all</option>' + values.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brittain Code benchmark v2</title><style>
  :root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--card:#f6f8fa;--line:#d0d7de;--accent:#0969da;--dot:#2da44e} @media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--line:#30363d;--accent:#58a6ff;--dot:#3fb950}}
  *{box-sizing:border-box}body{margin:0;padding:26px;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}h1{font-size:21px;margin:0}.muted,.sub{color:var(--muted)}.sub{margin:3px 0 18px}.filters{display:flex;gap:14px;margin-bottom:18px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:20px;overflow:auto}h2{font-size:15px;margin:0 0 10px}.grid{stroke:var(--line)}.tick{fill:var(--muted);font-size:11px;text-anchor:end}.bar{fill:var(--accent)}.error{stroke:var(--fg);stroke-width:1.5}.score{fill:var(--fg);font-weight:700;text-anchor:middle}.xlabel{fill:var(--fg);font-size:11px;text-anchor:end}.axis{stroke:var(--muted)}.axislabel{fill:var(--muted);font-size:11px;text-anchor:middle}.dot{fill:var(--dot)}.dotlabel{fill:var(--fg);font-size:10px}table{border-collapse:collapse;width:100%;white-space:nowrap;font-size:12px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right}th{color:var(--muted);position:sticky;top:0;background:var(--card)}td.left,th.left{text-align:left}select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
  </style></head><body><h1>Brittain Code benchmark v2</h1><p class="sub">${rows.length} runs · ${groups.length} configurations · correctness-gated, deterministic grading</p><div class="filters"><label>Task <select id="task">${options(tasks)}</select></label><label>Mode <select id="mode">${options(modes)}</select></label></div>
  <div class="card"><h2>Median total score with observed range</h2>${chart}</div><div class="card"><h2>Correctness versus elapsed time</h2>${scatter}</div>
  <div class="card"><h2>Configuration aggregates</h2><table><thead><tr><th>Task</th><th>Mode</th><th class="left">Model/team</th><th>Median</th><th>Range</th><th>n</th><th>Pass</th><th>Correct</th><th>Reliable</th><th>Efficient</th><th>Time</th><th>Gen tok</th><th>Tools</th></tr></thead><tbody>${aggregateRows}</tbody></table></div>
  <div class="card"><h2>Individual runs</h2><table><thead><tr><th>Task</th><th>Mode</th><th class="left">Model/team</th><th>Total</th><th>Correct</th><th>Safe</th><th>Reliable</th><th>Efficient</th><th>Visible</th><th>Hidden</th><th>Time</th><th>Gen tok</th><th>Tools</th><th>Graded</th></tr></thead><tbody>${runRows}</tbody></table></div>
  <script>const task=document.getElementById('task'),mode=document.getElementById('mode');function filter(){document.querySelectorAll('[data-task]').forEach(el=>{el.style.display=(task.value==='all'||el.dataset.task===task.value)&&(mode.value==='all'||el.dataset.mode===mode.value)?'':'none'})}task.onchange=mode.onchange=filter;</script></body></html>`;
  fs.writeFileSync(htmlPath, html);
  return htmlPath;
}

module.exports = { writeReport, aggregate, normalize };
if (require.main === module) {
  const out = writeReport(path.join(__dirname, 'results.json'), path.join(__dirname, 'report.html'));
  console.log('Wrote ' + out);
}
