#!/usr/bin/env node
/*
 * Builds a self-contained report.html (inline SVG chart + table) from results.json.
 * Used automatically by grade.js, or run standalone to rebuild the chart:
 *   node benchmark/report.js
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function writeReport(resultsPath, htmlPath) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(resultsPath, 'utf8')); } catch {}
  rows = rows.slice().sort((a, b) => b.total - a.total || String(a.model).localeCompare(String(b.model)));

  // disambiguate repeated model names for the axis labels
  const counts = {};
  rows.forEach((r) => { counts[r.model] = (counts[r.model] || 0) + 1; });
  const seen = {};
  rows.forEach((r) => { seen[r.model] = (seen[r.model] || 0) + 1; r._label = counts[r.model] > 1 ? `${r.model} ·${seen[r.model]}` : r.model; });

  // ---- chart geometry ----
  const padL = 44, padT = 28, padB = 104, chartH = 300;
  const bw = 52, gap = 26;
  const width = Math.max(360, padL + rows.length * (bw + gap) + gap);
  const height = padT + chartH + padB;
  const y = (v) => padT + (1 - v / 100) * chartH;

  const gridlines = [0, 25, 50, 75, 100].map((v) =>
    `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${width - 10}" y2="${y(v).toFixed(1)}" class="grid"/>` +
    `<text x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" class="ytick">${v}</text>`
  ).join('');

  const bars = rows.map((r, i) => {
    const x = padL + gap + i * (bw + gap);
    const oH = (r.output / 100) * chartH;
    const dH = (r.discipline / 100) * chartH;
    const oY = y(r.output);
    const dY = y(r.output + r.discipline);
    const title = `${r.model}\nTotal ${r.total}/100  (output ${r.output}/45, discipline ${r.discipline}/55)\n` +
      `O1 ${r.O1} O2 ${r.O2} O3 ${r.O3} | D1 ${r.D1} D2 ${r.D2} D3 ${r.D3} D4 ${r.D4} D5 ${r.D5} D6 ${r.D6}\n` +
      `${r.visible}/8 visible, ${r.hidden}/6 hidden, ${r.toolCalls} tool calls`;
    return `<g><title>${esc(title)}</title>` +
      `<rect x="${x}" y="${oY.toFixed(1)}" width="${bw}" height="${oH.toFixed(1)}" class="seg-out"/>` +
      `<rect x="${x}" y="${dY.toFixed(1)}" width="${bw}" height="${dH.toFixed(1)}" class="seg-dis"/>` +
      `<text x="${x + bw / 2}" y="${(dY - 8).toFixed(1)}" class="total">${r.total}</text>` +
      `<text x="${x + bw / 2}" y="${padT + chartH + 16}" transform="rotate(-35 ${x + bw / 2} ${padT + chartH + 16})" class="xlabel">${esc(r._label)}</text>` +
      `</g>`;
  }).join('');

  const svg = rows.length
    ? `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img">
        ${gridlines}
        <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + chartH}" class="axis"/>
        ${bars}
      </svg>`
    : `<p class="empty">No results yet. Run <code>node benchmark/grade.js</code> after a model finishes.</p>`;

  const cols = ['O1', 'O2', 'O3', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
  const tableRows = rows.map((r) =>
    `<tr><td class="l">${esc(r._label)}</td><td class="n b">${r.total}</td><td class="n">${r.output}</td><td class="n">${r.discipline}</td>` +
    cols.map((c) => `<td class="n">${r[c]}</td>`).join('') +
    `<td class="n">${r.visible}/8</td><td class="n">${r.hidden}/6</td><td class="n">${r.toolCalls}</td>` +
    `<td class="d">${esc((r.gradedAt || '').slice(0, 16).replace('T', ' '))}</td></tr>`
  ).join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brittain Code — model benchmark</title>
<style>
  :root { --bg:#ffffff; --fg:#1b1f24; --muted:#6a737d; --grid:#e3e6ea; --card:#f6f8fa; --out:#2da44e; --dis:#0969da; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --grid:#21262d; --card:#161b22; --out:#3fb950; --dis:#58a6ff; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  h1 { font-size:19px; margin:0 0 2px; }
  .sub { color:var(--muted); margin:0 0 22px; font-size:13px; }
  .card { background:var(--card); border:1px solid var(--grid); border-radius:10px; padding:16px; margin-bottom:22px; overflow-x:auto; }
  .legend { display:flex; gap:18px; margin:2px 0 14px; font-size:13px; color:var(--muted); }
  .sw { display:inline-block; width:12px; height:12px; border-radius:3px; vertical-align:-1px; margin-right:6px; }
  .grid { stroke:var(--grid); stroke-width:1; }
  .axis { stroke:var(--muted); stroke-width:1; }
  .ytick { fill:var(--muted); font-size:11px; text-anchor:end; }
  .xlabel { fill:var(--fg); font-size:12px; text-anchor:end; }
  .total { fill:var(--fg); font-size:12px; font-weight:600; text-anchor:middle; }
  .seg-out { fill:var(--out); } .seg-dis { fill:var(--dis); }
  .empty { color:var(--muted); }
  table { border-collapse:collapse; width:100%; font-size:12.5px; white-space:nowrap; }
  th,td { padding:6px 9px; border-bottom:1px solid var(--grid); text-align:center; }
  th { color:var(--muted); font-weight:600; position:sticky; top:0; background:var(--card); }
  td.l { text-align:left; font-weight:600; } td.n { text-align:right; font-variant-numeric:tabular-nums; }
  td.b { font-weight:700; } td.d { color:var(--muted); text-align:left; }
  thead .grp { font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
</style></head>
<body>
  <h1>Brittain Code — model benchmark</h1>
  <p class="sub">Auto-graded 0–100. ${rows.length} run${rows.length === 1 ? '' : 's'} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</p>
  <div class="card">
    <div class="legend"><span><span class="sw" style="background:var(--out)"></span>Output /45</span><span><span class="sw" style="background:var(--dis)"></span>Discipline /55</span><span>hover a bar for the full breakdown</span></div>
    ${svg}
  </div>
  <div class="card">
    <table>
      <thead>
        <tr><th class="l">Model</th><th>Total</th><th>Out /45</th><th>Disc /55</th>
        <th title="tests pass">O1</th><th title="generalizes">O2</th><th title="no collateral">O3</th>
        <th title="explored first">D1</th><th title="right file">D2</th><th title="precise edits">D3</th><th title="respected spec">D4</th><th title="verified">D5</th><th title="honest">D6</th>
        <th>Vis</th><th>Hid</th><th>Tools</th><th class="d">Graded</th></tr>
      </thead>
      <tbody>${tableRows || '<tr><td colspan="17" class="d">no data</td></tr>'}</tbody>
    </table>
  </div>
</body></html>`;

  fs.writeFileSync(htmlPath, html);
  return htmlPath;
}

module.exports = { writeReport };

if (require.main === module) {
  const dir = __dirname;
  const out = writeReport(path.join(dir, 'results.json'), path.join(dir, 'report.html'));
  console.log('Wrote ' + out);
}
