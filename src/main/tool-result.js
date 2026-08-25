'use strict';

// A tool result becomes part of every later model request. A single full-page
// DOM dump can be larger than the complete context window, so keep a useful
// start and end while the full result remains available to the tool UI event.
const MAX_TOOL_RESULT_CHARS = 32_000;

function boundToolResult(value, { maxChars = MAX_TOOL_RESULT_CHARS, toolName = 'tool' } = {}) {
  const text = String(value ?? '');
  const limit = Math.max(200, Number(maxChars) || MAX_TOOL_RESULT_CHARS);
  if (text.length <= limit) {
    return { content: text, truncated: false, originalChars: text.length, omittedChars: 0 };
  }

  const omittedChars = text.length - limit;
  const notice = `\n\n[${toolName} result shortened: approximately ${omittedChars.toLocaleString()} characters omitted. Use a narrower query, a page snapshot, or a targeted search.]\n\n`;
  if (notice.length >= limit) {
    return { content: notice.slice(0, limit), truncated: true, originalChars: text.length, omittedChars };
  }

  const available = limit - notice.length;
  const headChars = Math.ceil(available * 0.6);
  const tailChars = available - headChars;
  return {
    content: text.slice(0, headChars) + notice + text.slice(text.length - tailChars),
    truncated: true,
    originalChars: text.length,
    omittedChars: text.length - headChars - tailChars,
  };
}

// Full DOM extraction is almost never useful to an agent. It also caused a
// 1.6-million-character tool result in a real Discord run. Block only the
// known unbounded forms; targeted evaluate calls remain available.
function isUnboundedBrowserEvaluation(name, args) {
  if (!/(?:^|_)browser_evaluate$/i.test(String(name || ''))) return false;
  const source = typeof args === 'string' ? args : JSON.stringify(args || {});
  return /document\s*\.\s*(?:documentElement|body)\s*\.\s*(?:outerHTML|innerHTML)\b/i.test(source);
}

module.exports = { MAX_TOOL_RESULT_CHARS, boundToolResult, isUnboundedBrowserEvaluation };
