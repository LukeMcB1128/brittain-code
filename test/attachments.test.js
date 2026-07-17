const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractFileAttachments,
  isSupportedTextFile,
  validateImageAttachments,
} = require('../attachments');

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function simplePdf(text) {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

test('recognizes common text and source-code attachments', () => {
  assert.equal(isSupportedTextFile('notes.md', ''), true);
  assert.equal(isSupportedTextFile('component.tsx', 'application/octet-stream'), true);
  assert.equal(isSupportedTextFile('data', 'application/json'), true);
  assert.equal(isSupportedTextFile('archive.zip', 'application/zip'), false);
});

test('extracts and caps text attachments locally', async () => {
  const result = await extractFileAttachments([{
    name: '../notes.md',
    type: 'text/markdown',
    data: base64('A'.repeat(5000)),
  }], { maxTotalChars: 1000 });
  assert.equal(result[0].name, 'notes.md');
  assert.equal(result[0].kind, 'text');
  assert.equal(result[0].truncated, true);
  assert.equal(result[0].extractedCharacters, 1000);
  assert.match(result[0].text, /Attachment truncated/);
});

test('extracts PDF text with page markers', async () => {
  const pdf = simplePdf('Hello PDF attachment');
  const result = await extractFileAttachments([{
    name: 'sample.pdf',
    type: 'application/pdf',
    data: pdf.toString('base64'),
  }], { maxTotalChars: 10_000 });
  assert.equal(result[0].kind, 'pdf');
  assert.equal(result[0].pages, 1);
  assert.match(result[0].text, /\[Page 1\]/);
  assert.match(result[0].text, /Hello PDF attachment/);
});

test('rejects binary documents and mismatched image contents', async () => {
  await assert.rejects(() => extractFileAttachments([{
    name: 'fake.txt',
    type: 'text/plain',
    data: Buffer.from([0, 1, 0, 2, 0, 3]).toString('base64'),
  }]), /binary file/);

  assert.throws(() => validateImageAttachments(
    [base64('not actually a png')],
    ['image/png'],
    [{ name: 'fake.png' }],
  ), /do not match/);
});
