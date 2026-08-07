const fs = require('fs');

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function readBenchResults(resultsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function queryBenchmarks(entries, taskFilter) {
  if (!entries.length) return { ok: true, available: false, tasks: [], rows: [] };
  const tasks = [...new Set(entries.map((entry) => entry.task).filter(Boolean))].sort();
  const filtered = taskFilter
    ? entries.filter((entry) => entry.task === taskFilter)
    : entries;
  const groups = new Map();
  for (const entry of filtered) {
    if (typeof entry.total !== 'number' || !entry.model) continue;
    const key = `${entry.task}\u0000${entry.model}`;
    if (!groups.has(key)) {
      groups.set(key, {
        task: entry.task,
        model: entry.model,
        mode: entry.mode,
        scores: [],
      });
    }
    groups.get(key).scores.push(entry.total);
  }
  const rows = [...groups.values()]
    .map((group) => ({
      task: group.task,
      model: group.model,
      mode: group.mode,
      runs: group.scores.length,
      median: median(group.scores),
    }))
    .sort((a, b) => b.median - a.median || b.runs - a.runs);
  return { ok: true, available: true, tasks, rows };
}

module.exports = { median, queryBenchmarks, readBenchResults };
