// Which suspended run a /pending subcommand refers to.
//
// Run ids are long (`run-1787440224174-djqc7p`) and there is usually exactly
// one run waiting, so making the user retype it is pure friction: `/pending
// approve` should mean the obvious thing. That also makes a bare index or
// "all" in the run slot unambiguous — `/pending approve all` and `/pending
// approve 2` are about the one waiting run, not a run named "all".
//
// With several runs waiting the ambiguity is real, so the user is asked to
// pick rather than having one chosen for them.
(function (global) {
  function resolvePendingTarget(records, runArg, callArg) {
    const isSelector = runArg === 'all' || /^\d+$/.test(runArg);
    if (!runArg || isSelector) {
      if (!records.length) {
        return { error: 'No suspended runs. When an unattended run parks a call, it appears here.' };
      }
      if (records.length > 1) {
        return { error: 'Several runs are suspended — name one: ' + records.map((entry) => entry.runId).join(', ') };
      }
      return { record: records[0], selector: isSelector ? runArg : callArg };
    }
    // A suffix match so a short, unique tail of an id is enough to name a run.
    const record = records.find((entry) => entry.runId === runArg || entry.runId.endsWith(runArg));
    if (!record) return { error: `No suspended run matching "${runArg}".` };
    return { record, selector: callArg };
  }

  const api = { resolvePendingTarget };
  global.PendingTarget = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
