(function attachDiffViewer(global) {
  function parseHunk(line) {
    const match = String(line).match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    return match ? { oldLine: Number(match[1]), newLine: Number(match[2]) } : null;
  }

  function parsePatchLines(patch) {
    let oldLine = null;
    let newLine = null;
    return String(patch || '').split('\n').map((text) => {
      const hunk = parseHunk(text);
      if (hunk) {
        oldLine = hunk.oldLine;
        newLine = hunk.newLine;
        return { type: 'hunk', text, oldNumber: '', newNumber: '' };
      }
      if (text.startsWith('diff --git') || text.startsWith('index ') || text.startsWith('---') || text.startsWith('+++') || text.startsWith('new file mode') || text.startsWith('deleted file mode')) {
        return { type: 'meta', text, oldNumber: '', newNumber: '' };
      }
      if (oldLine !== null && text.startsWith('+')) {
        return { type: 'add', text, oldNumber: '', newNumber: newLine++ };
      }
      if (oldLine !== null && text.startsWith('-')) {
        return { type: 'delete', text, oldNumber: oldLine++, newNumber: '' };
      }
      if (oldLine !== null && text.startsWith(' ')) {
        return { type: 'context', text, oldNumber: oldLine++, newNumber: newLine++ };
      }
      return { type: 'meta', text, oldNumber: '', newNumber: '' };
    });
  }

  function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fileId(sectionId, index) {
    return `diff-${sectionId}-${index}`;
  }

  function show(result, dependencies) {
    const { $, hideOverlay, documentRef = document } = dependencies;
    const overlay = $('overlay');
    const box = $('overlay-box');
    const body = $('overlay-body');
    $('overlay-title').textContent = `DIFF — ${result.totals.files} files  +${result.totals.additions}  -${result.totals.deletions}`;
    box.classList.remove('recommendations-overlay');
    box.classList.add('diff-v2-overlay');
    body.className = 'diff-v2';
    body.replaceChildren();

    if (result.scope) {
      const scope = element(documentRef, 'div', 'diff-scope');
      scope.appendChild(element(documentRef, 'strong', 'diff-scope-label', result.scope.label));
      scope.appendChild(element(documentRef, 'span', 'diff-scope-note', result.scope.note));
      body.appendChild(scope);
    }

    const layout = element(documentRef, 'div', 'diff-layout');
    const navigation = element(documentRef, 'nav', 'diff-navigation');
    const content = element(documentRef, 'div', 'diff-content');

    for (const section of result.sections) {
      const group = element(documentRef, 'div', 'diff-nav-group');
      group.appendChild(element(documentRef, 'div', 'diff-nav-title', `${section.label.toUpperCase()}  ${section.files.length}`));
      const sectionBlock = element(documentRef, 'section', 'diff-section');
      sectionBlock.appendChild(element(documentRef, 'h3', 'diff-section-title', `${section.label} (${section.files.length})`));

      if (!section.files.length) {
        group.appendChild(element(documentRef, 'div', 'diff-nav-empty', 'No files'));
        sectionBlock.appendChild(element(documentRef, 'div', 'diff-empty', `No ${section.label.toLowerCase()} changes.`));
      }

      section.files.forEach((file, index) => {
        const id = fileId(section.id, index);
        const navButton = element(documentRef, 'button', 'diff-nav-file', file.path);
        navButton.type = 'button';
        navButton.title = file.path;
        navButton.addEventListener('click', () => {
          const target = documentRef.getElementById(id);
          if (!target) return;
          target.open = true;
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        group.appendChild(navButton);

        const details = element(documentRef, 'details', 'diff-file-card');
        details.id = id;
        details.open = true;
        const summary = element(documentRef, 'summary', 'diff-file-summary');
        summary.appendChild(element(documentRef, 'span', 'diff-file-status', file.status));
        summary.appendChild(element(documentRef, 'span', 'diff-file-path', file.path));
        summary.appendChild(element(documentRef, 'span', 'diff-file-counts', `+${file.additions}  -${file.deletions}${file.binary ? '  BINARY' : ''}${file.truncated ? '  TRUNCATED' : ''}`));
        details.appendChild(summary);
        const rows = element(documentRef, 'div', 'diff-rows');
        for (const line of parsePatchLines(file.patch)) {
          const row = element(documentRef, 'div', `diff-row diff-row-${line.type}`);
          row.appendChild(element(documentRef, 'span', 'diff-line-number', line.oldNumber));
          row.appendChild(element(documentRef, 'span', 'diff-line-number', line.newNumber));
          row.appendChild(element(documentRef, 'span', 'diff-line-text', line.text || ' '));
          rows.appendChild(row);
        }
        details.appendChild(rows);
        sectionBlock.appendChild(details);
      });
      navigation.appendChild(group);
      content.appendChild(sectionBlock);
    }

    layout.appendChild(navigation);
    layout.appendChild(content);
    body.appendChild(layout);
    overlay.classList.remove('hidden');
    $('overlay-close').onclick = hideOverlay;
  }

  const api = { parseHunk, parsePatchLines, show };
  global.DiffViewer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
