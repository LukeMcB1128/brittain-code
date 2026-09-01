const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractFileAttachments } = require('../attachments');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

// A one-page PDF with a MediaBox and no text layer — exactly what a scan is.
const SCAN = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBl'
  + 'L1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBS'
  + 'L01lZGlhQm94WzAgMCAyMDAgMjAwXT4+CmVuZG9iagp0cmFpbGVyCjw8L1Jvb3QgMSAwIFI+Pg==', 'base64');

const attach = (buffer, name = 'scan.pdf') =>
  extractFileAttachments([{ name, type: 'application/pdf', data: buffer.toString('base64') }]);

test('a scan becomes page images instead of an error', async () => {
  // It used to throw "scanned PDFs need OCR, which is not supported yet",
  // which was a dead end for exactly the documents people photograph.
  const [file] = await attach(SCAN);
  assert.equal(file.scanned, true);
  assert.equal(file.images.length, 1);
  assert.equal(Buffer.from(file.images[0], 'base64').subarray(1, 4).toString('ascii'), 'PNG');
});

test('the text says what happened, so the model is not guessing', async () => {
  const [file] = await attach(SCAN);
  assert.match(file.text, /no text layer/);
  assert.match(file.text, /1 of 1 page\(s\) attached as images/);
});

test('a PDF with real text is untouched by any of this', async () => {
  // The rendering path must only ever be a fallback. The gate used to be
  // emptiness alone; it is now a judgement about whether the extracted text is
  // legible, which catches a broken text layer as well as a missing one.
  const source = read('attachments.js');
  const body = source.slice(source.indexOf('async function extractPdfText'));
  assert.ok(body.indexOf('renderPdfPages') > body.indexOf('const quality = assessText(text)'),
    'rendering happens only after the extracted text is judged unusable');
  const { assessText } = require('../attachments');
  assert.deepEqual(assessText('Ordinary readable prose about the subject at hand. '.repeat(10)), { usable: true });
});

test('rendering is capped, because pages are expensive', () => {
  const source = read('attachments.js');
  assert.match(source, /const MAX_RENDERED_PAGES = 8;/);
  assert.match(source, /Pages \$\{rendered \+ 1\}-\$\{total\} were not rendered\./,
    'and it says which pages it left out');
});

test('each page is rendered from its own copy of the source', () => {
  // unpdf consumes the typed array it is given; sharing one renders page 1 and
  // then fails on an empty buffer.
  const source = read('attachments.js');
  const loop = source.slice(source.indexOf('for (let page = 1;'), source.indexOf('return { images, total'));
  assert.match(loop, /renderPageAsImage\(new Uint8Array\(buffer\), page/);
});

test('a model that cannot see is told why, not just that it failed', () => {
  const main = read('main.js');
  assert.match(main, /is a scan with no text layer, so it can only be read as images/);
  assert.match(main, /qwen2\.5vl, llava, gemma3/, 'and what to switch to');
});

test('rendered pages reach the model and stay out of the history file', () => {
  const main = read('main.js');
  assert.match(main, /const scannedPages = fileAttachments\.flatMap\(\(file\) => file\.images \|\| \[\]\)/);
  assert.match(main, /const allImages = \[\.\.\.validatedImages\.images, \.\.\.scannedPages\]/);
  // Megabytes of base64 in a saved chat helps nobody.
  assert.match(main, /images: _images, \.\.\.metadata/);
});

test('the native canvas is unpacked from the asar', () => {
  // A native module cannot be loaded from inside an asar archive, so a packaged
  // build would fail exactly where a dev build works.
  const unpacked = require('../package.json').build.asarUnpack;
  assert.ok(unpacked.some((glob) => glob.includes('@napi-rs/canvas')));
});
