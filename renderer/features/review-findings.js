(function attachReviewFindings(global) {
  const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

  function sortedFindings(findings) {
    return [...(findings || [])].sort((a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
      || b.confidence - a.confidence
      || a.file.localeCompare(b.file)
      || a.line - b.line);
  }

  function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function create(review, { documentRef = document, onSend, onClose }) {
    const card = element(documentRef, 'section', 'review-findings-card');
    const header = element(documentRef, 'div', 'review-findings-header');
    header.appendChild(element(documentRef, 'strong', '', `CODE REVIEW — ${review.base}`));
    header.appendChild(element(documentRef, 'span', '', `${review.findings.length} finding${review.findings.length === 1 ? '' : 's'}`));
    card.appendChild(header);
    card.appendChild(element(documentRef, 'p', 'review-findings-summary', review.summary));

    const list = element(documentRef, 'div', 'review-findings-list');
    const checkboxes = [];
    for (const finding of sortedFindings(review.findings)) {
      const label = element(documentRef, 'label', `review-finding severity-${finding.severity}`);
      const checkbox = element(documentRef, 'input');
      checkbox.type = 'checkbox';
      checkbox.checked = finding.severity === 'critical' || finding.severity === 'high';
      checkbox.dataset.findingId = finding.id;
      checkboxes.push(checkbox);
      const content = element(documentRef, 'div', 'review-finding-content');
      const title = element(documentRef, 'div', 'review-finding-title');
      title.appendChild(element(documentRef, 'span', 'review-severity', finding.severity.toUpperCase()));
      title.appendChild(element(documentRef, 'strong', '', finding.title));
      title.appendChild(element(documentRef, 'span', 'review-confidence', `${finding.confidence}% confidence`));
      content.appendChild(title);
      content.appendChild(element(documentRef, 'div', 'review-location', `${finding.file}:${finding.line}`));
      content.appendChild(element(documentRef, 'p', 'review-evidence', finding.evidence));
      content.appendChild(element(documentRef, 'p', 'review-fix', `Suggested fix: ${finding.suggestedFix}`));
      label.appendChild(checkbox);
      label.appendChild(content);
      list.appendChild(label);
    }
    if (!review.findings.length) list.appendChild(element(documentRef, 'div', 'review-no-findings', 'No actionable findings.'));
    card.appendChild(list);

    const error = element(documentRef, 'div', 'review-findings-error');
    const actions = element(documentRef, 'div', 'review-findings-actions');
    const close = element(documentRef, 'button', '', 'CLOSE');
    const send = element(documentRef, 'button', 'approve', 'SEND SELECTED TO CODER');
    send.disabled = !review.findings.length;
    close.addEventListener('click', () => {
      card.remove();
      if (onClose) onClose();
    });
    send.addEventListener('click', async () => {
      const selectedIds = new Set(checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.dataset.findingId));
      const selected = review.findings.filter((finding) => selectedIds.has(finding.id));
      if (!selected.length) {
        error.textContent = 'Select at least one finding.';
        return;
      }
      error.textContent = '';
      send.disabled = true;
      close.disabled = true;
      try {
        await onSend(selected, card);
      } finally {
        if (card.isConnected) {
          send.disabled = false;
          close.disabled = false;
        }
      }
    });
    actions.appendChild(close);
    actions.appendChild(send);
    card.appendChild(error);
    card.appendChild(actions);
    return card;
  }

  const api = { create, sortedFindings };
  global.ReviewFindings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
