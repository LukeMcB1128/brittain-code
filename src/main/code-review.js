const REVIEW_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

const SUBMIT_CODE_REVIEW_TOOL = {
  type: 'function',
  function: {
    name: 'submit_code_review',
    description: 'Finish the review with structured, actionable findings. Call this exactly once after checking the changed code.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Concise overall review result.' },
        findings: {
          type: 'array',
          maxItems: 30,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short defect title.' },
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
              confidence: { type: 'number', minimum: 0, maximum: 100 },
              file: { type: 'string', description: 'Project-relative file path.' },
              line: { type: 'integer', minimum: 1 },
              evidence: { type: 'string', description: 'Concrete evidence that explains the failure or risk.' },
              suggested_fix: { type: 'string', description: 'A specific correction.' },
            },
            required: ['title', 'severity', 'confidence', 'file', 'line', 'evidence', 'suggested_fix'],
          },
        },
      },
      required: ['summary', 'findings'],
    },
  },
};

function cleanText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function cleanProjectFile(value) {
  const file = cleanText(value, 500).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!file || file.startsWith('/') || file.split('/').includes('..')) return '';
  return file;
}

function normalizeCodeReview(input, base = 'HEAD') {
  const source = input && typeof input === 'object' ? input : {};
  const findings = Array.isArray(source.findings) ? source.findings.slice(0, 30) : [];
  return {
    base: cleanText(base, 200) || 'HEAD',
    summary: cleanText(source.summary, 5000) || 'Review completed.',
    findings: findings.map((finding, index) => {
      const severity = cleanText(finding?.severity, 20).toLowerCase();
      const confidence = Number(finding?.confidence);
      const line = Number(finding?.line);
      return {
        id: `finding-${index + 1}`,
        title: cleanText(finding?.title, 240) || `Finding ${index + 1}`,
        severity: REVIEW_SEVERITIES.has(severity) ? severity : 'medium',
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : 50,
        file: cleanProjectFile(finding?.file),
        line: Number.isInteger(line) && line > 0 ? line : 1,
        evidence: cleanText(finding?.evidence, 5000) || 'No evidence was supplied.',
        suggestedFix: cleanText(finding?.suggested_fix ?? finding?.suggestedFix, 5000) || 'Inspect and correct the reported behavior.',
      };
    }).filter((finding) => finding.file),
  };
}

module.exports = { normalizeCodeReview, SUBMIT_CODE_REVIEW_TOOL };
