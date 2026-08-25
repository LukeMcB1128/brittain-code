'use strict';

function stableSerialize(value) {
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',') + '}';
  }
  return JSON.stringify(value);
}

function callSignature(name, args) {
  return `${String(name || '')}:${stableSerialize(args || {})}`;
}

function isToolErrorResult(result) {
  return /^\s*(?:\[MCP auto-approved\]\s*)?(?:MCP tool error:|Error:)/i.test(String(result || ''));
}

function createToolFailureTracker(limit = 2) {
  const failures = new Map();
  const threshold = Math.max(1, Number(limit) || 2);

  return {
    shouldBlock(name, args) {
      return (failures.get(callSignature(name, args)) || 0) >= threshold;
    },
    record(name, args, result) {
      const signature = callSignature(name, args);
      if (!isToolErrorResult(result)) {
        failures.delete(signature);
        return { count: 0, reachedLimit: false };
      }
      const count = (failures.get(signature) || 0) + 1;
      failures.set(signature, count);
      return { count, reachedLimit: count === threshold };
    },
  };
}

module.exports = { callSignature, createToolFailureTracker, isToolErrorResult, stableSerialize };
