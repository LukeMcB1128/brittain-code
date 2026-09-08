'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const archive = path.resolve(process.argv[2]);
  const { PDFDocument, rgb } = require(path.join(archive, 'node_modules/pdf-lib'));
  const { renderPdfPages } = require(path.join(archive, 'attachments.js'));
  const document = await PDFDocument.create();
  document.addPage([72, 72]).drawRectangle({ x: 5, y: 5, width: 50, height: 50, color: rgb(0, 0, 0) });
  const result = await renderPdfPages(Buffer.from(await document.save()), 1);
  assert.equal(result.rendered, 1);
  assert.equal(Buffer.from(result.images[0], 'base64').subarray(1, 4).toString(), 'PNG');
  console.log('Packaged scanned-PDF rendering passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
