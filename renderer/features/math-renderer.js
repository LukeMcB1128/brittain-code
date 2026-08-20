(function initMathRenderer(global) {
  'use strict';

  const MARKER_PREFIX = '\uE000BRITTAIN_MATH_';
  const MARKER_SUFFIX = '\uE001';
  const MARKER_PATTERN = /\uE000BRITTAIN_MATH_(\d+)\uE001/g;

  function isEscaped(source, index) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1;
    return slashes % 2 === 1;
  }

  function runLength(source, index, character) {
    let end = index;
    while (source[end] === character) end += 1;
    return end - index;
  }

  function codeEnd(source, index) {
    if (source[index] === '`') {
      const length = runLength(source, index, '`');
      const delimiter = '`'.repeat(length);
      const closing = source.indexOf(delimiter, index + length);
      if (closing < 0) return length >= 3 ? source.length : -1;
      return closing + length;
    }

    if (source[index] !== '~') return -1;
    const length = runLength(source, index, '~');
    const lineStart = source.lastIndexOf('\n', index - 1) + 1;
    const indentation = source.slice(lineStart, index);
    if (length < 3 || !/^ {0,3}$/.test(indentation)) return -1;
    const delimiter = '~'.repeat(length);
    const closing = source.indexOf(delimiter, index + length);
    return closing < 0 ? source.length : closing + length;
  }

  function findClosing(source, start, delimiter, allowNewline) {
    let cursor = start;
    while (cursor < source.length) {
      const closing = source.indexOf(delimiter, cursor);
      if (closing < 0) return -1;
      if (!allowNewline && source.slice(start, closing).includes('\n')) return -1;
      if (!isEscaped(source, closing)) return closing;
      cursor = closing + delimiter.length;
    }
    return -1;
  }

  function delimiterAt(source, index) {
    if (source.startsWith('$$', index) && !isEscaped(source, index)) {
      const closing = findClosing(source, index + 2, '$$', true);
      if (closing >= 0 && source.slice(index + 2, closing).trim()) {
        return { open: '$$', close: '$$', closing, display: true };
      }
      return null;
    }

    if (source.startsWith('\\[', index) && !isEscaped(source, index)) {
      const closing = findClosing(source, index + 2, '\\]', true);
      if (closing >= 0 && source.slice(index + 2, closing).trim()) {
        return { open: '\\[', close: '\\]', closing, display: true };
      }
      return null;
    }

    if (source.startsWith('\\(', index) && !isEscaped(source, index)) {
      const closing = findClosing(source, index + 2, '\\)', false);
      if (closing >= 0 && source.slice(index + 2, closing).trim()) {
        return { open: '\\(', close: '\\)', closing, display: false };
      }
      return null;
    }

    if (source[index] !== '$' || isEscaped(source, index) || /\s/.test(source[index + 1] || '')) return null;
    const closing = findClosing(source, index + 1, '$', false);
    if (closing < 0 || closing === index + 1 || /\s/.test(source[closing - 1] || '')) return null;
    // Do not join currency values such as "$5 and $10" into one formula.
    if (/\d/.test(source[closing + 1] || '')) return null;
    return { open: '$', close: '$', closing, display: false };
  }

  function protectMath(markdown) {
    const source = String(markdown || '');
    const segments = [];
    let protectedText = '';
    let index = 0;

    while (index < source.length) {
      const protectedCodeEnd = codeEnd(source, index);
      if (protectedCodeEnd >= 0) {
        protectedText += source.slice(index, protectedCodeEnd);
        index = protectedCodeEnd;
        continue;
      }

      const delimiter = delimiterAt(source, index);
      if (!delimiter) {
        protectedText += source[index];
        index += 1;
        continue;
      }

      const contentStart = index + delimiter.open.length;
      const rawEnd = delimiter.closing + delimiter.close.length;
      const segment = {
        source: source.slice(contentStart, delimiter.closing).trim(),
        raw: source.slice(index, rawEnd),
        display: delimiter.display,
      };
      const marker = `${MARKER_PREFIX}${segments.length}${MARKER_SUFFIX}`;
      segments.push(segment);
      protectedText += marker;
      index = rawEnd;
    }

    return { text: protectedText, segments };
  }

  function textNodes(root) {
    const nodes = [];
    const visit = (node) => {
      for (const child of [...(node.childNodes || [])]) {
        if (child.nodeType === 3) nodes.push(child);
        else if (child.nodeType === 1) visit(child);
      }
    };
    visit(root);
    return nodes;
  }

  function renderProtectedMath(root, segments, katex = global.katex) {
    if (!root || !Array.isArray(segments) || !segments.length) return;
    const documentRef = root.ownerDocument || global.document;

    for (const node of textNodes(root)) {
      const value = String(node.nodeValue || '');
      const insideCode = !!node.parentElement?.closest?.('code, pre');
      MARKER_PATTERN.lastIndex = 0;
      if (!MARKER_PATTERN.test(value)) continue;
      MARKER_PATTERN.lastIndex = 0;

      const fragment = documentRef.createDocumentFragment();
      let cursor = 0;
      let match;
      while ((match = MARKER_PATTERN.exec(value)) !== null) {
        if (match.index > cursor) fragment.appendChild(documentRef.createTextNode(value.slice(cursor, match.index)));
        const segment = segments[Number(match[1])];
        if (!segment) {
          fragment.appendChild(documentRef.createTextNode(match[0]));
        } else if (insideCode) {
          fragment.appendChild(documentRef.createTextNode(segment.raw));
        } else {
          const math = documentRef.createElement('span');
          math.className = segment.display ? 'math-display' : 'math-inline';
          math.setAttribute('aria-label', segment.source);
          if (katex?.render) {
            try {
              katex.render(segment.source, math, {
                displayMode: segment.display,
                throwOnError: true,
                strict: 'ignore',
                trust: false,
                output: 'htmlAndMathml',
              });
            } catch {
              math.textContent = segment.raw;
              math.classList.add('math-error');
            }
          } else {
            math.textContent = segment.raw;
          }
          fragment.appendChild(math);
        }
        cursor = match.index + match[0].length;
      }
      if (cursor < value.length) fragment.appendChild(documentRef.createTextNode(value.slice(cursor)));
      node.replaceWith(fragment);
    }
  }

  const api = { delimiterAt, isEscaped, protectMath, renderProtectedMath };
  global.MathRenderer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window === 'undefined' ? globalThis : window));
