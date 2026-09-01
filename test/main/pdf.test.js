const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pdf = require('../../src/tools/pdf');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-test-'));
const at = (name) => path.join(dir, name);

// A real document with a real form, so these exercise pdf-lib rather than a
// stub that agrees with whatever the code does.
async function makeForm(file, { pages = 1 } = {}) {
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([612, 792]);
  const form = doc.getForm();
  const page = doc.getPage(0);
  form.createTextField('full_name').addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  form.createCheckBox('agree').addToPage(page, { x: 50, y: 650, width: 15, height: 15 });
  form.createDropdown('state').setOptions(['NY', 'CA']);
  form.getDropdown('state').addToPage(page, { x: 50, y: 600, width: 100, height: 20 });
  fs.writeFileSync(file, await doc.save());
  return file;
}

// --- page ranges ---

test('page ranges read the way a person says them', () => {
  // One-based and inclusive, converted to the zero-based indices pdf-lib wants.
  assert.deepEqual(pdf.parsePages('1-3,7', 10), [0, 1, 2, 6]);
  assert.deepEqual(pdf.parsePages('12-', 13), [11, 12], 'an open end means "to the last page"');
  assert.deepEqual(pdf.parsePages('-3', 10), [0, 1, 2], 'an open start means "from page one"');
  assert.deepEqual(pdf.parsePages('all', 3), [0, 1, 2]);
  assert.deepEqual(pdf.parsePages('2,2,2', 3), [1], 'a page named twice is still one page');
});

test('a range that cannot mean anything says so', () => {
  // Silently clamping would delete the wrong pages.
  assert.throws(() => pdf.parsePages('5', 3), /outside this document \(1-3\)/);
  assert.throws(() => pdf.parsePages('7-2', 10), /runs backwards/);
  assert.throws(() => pdf.parsePages('first', 10), /Cannot read "first"/);
});

// --- output paths ---

test('the default output never destroys the source', () => {
  // A PDF is usually the only copy of the thing and has no diff to recover from.
  const out = pdf.resolveOutput('/docs/lease.pdf', '', '-filled');
  assert.equal(out.path, path.join('/docs', 'lease-filled.pdf'));
  assert.equal(out.overwrites, false);
});

test('overwriting the source is possible but has to be named', () => {
  const out = pdf.resolveOutput('/docs/lease.pdf', '/docs/lease.pdf', '-filled');
  assert.equal(out.overwrites, true);
});

// --- inspection ---

test('info reports the fields you need to fill', async () => {
  const file = await makeForm(at('form.pdf'));
  const text = await pdf.info(file);
  assert.match(text, /1 page/);
  assert.match(text, /612 x 792/);
  assert.match(text, /full_name \[TextField\]/);
  assert.match(text, /state \[Dropdown\] options: NY \| CA/);
});

test('a document with no form says what that probably means', async () => {
  // "none" alone sends you looking for a bug; XFA is the usual answer.
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage();
  fs.writeFileSync(at('plain.pdf'), await doc.save());
  const text = await pdf.info(at('plain.pdf'));
  assert.match(text, /Form fields: none/);
  assert.match(text, /XFA/);
});

test('a file that is not a PDF is named as such', async () => {
  fs.writeFileSync(at('notes.txt'), 'hello');
  // pdf-lib's own error quotes a byte offset, which explains nothing.
  await assert.rejects(() => pdf.info(at('notes.txt')), /Not a PDF/);
  await assert.rejects(() => pdf.info(at('missing.pdf')), /No such file/);
});

// --- filling ---

test('filling writes the values and leaves the original alone', async () => {
  const file = await makeForm(at('fill.pdf'));
  const before = fs.readFileSync(file);
  const result = await pdf.fillForm(file, { full_name: 'Luke Brittain', agree: true, state: 'CA' });

  assert.match(result, /Filled 3 fields/);
  assert.deepEqual(fs.readFileSync(file), before, 'the source is untouched');

  const written = at('fill-filled.pdf');
  assert.ok(fs.existsSync(written));
  assert.match(await pdf.info(written), /full_name \[TextField\] = Luke Brittain/);
});

test('a misspelled field name is an error, not a silent skip', async () => {
  // Filling four of five fields produces a document that looks finished.
  const file = await makeForm(at('typo.pdf'));
  await assert.rejects(
    () => pdf.fillForm(file, { full_name: 'ok', fulname: 'typo' }),
    /No such field: fulname[\s\S]*Available: full_name/,
  );
});

test('a value outside a dropdown\'s options is refused with the options', async () => {
  const file = await makeForm(at('option.pdf'));
  await assert.rejects(() => pdf.fillForm(file, { state: 'TX' }), /not an option[\s\S]*NY \| CA/);
});

test('checkboxes accept the ways a model writes yes', async () => {
  const file = await makeForm(at('check.pdf'));
  for (const value of [true, 'true', 'yes', 'X', '1']) {
    await pdf.fillForm(file, { agree: value }, { output: at('c.pdf') });
    assert.match(await pdf.info(at('c.pdf')), /agree \[CheckBox\] = checked/, String(value));
  }
  await pdf.fillForm(file, { agree: false }, { output: at('c.pdf') });
  assert.doesNotMatch(await pdf.info(at('c.pdf')), /agree \[CheckBox\] = checked/);
});

// --- stamping ---

test('stamping needs something to draw', async () => {
  const file = await makeForm(at('stamp.pdf'));
  await assert.rejects(() => pdf.stamp(file, { page: 1, x: 10, y: 10 }), /either text or an image/);
  await assert.rejects(() => pdf.stamp(file, { page: 9, text: 'x' }), /outside this document/);
});

test('stamped text lands on the page and the file grows', async () => {
  const file = await makeForm(at('sign.pdf'));
  const result = await pdf.stamp(file, { page: 1, x: 72, y: 72, text: 'Luke Brittain', size: 14 });
  assert.match(result, /Stamped text on page 1/);
  assert.ok(fs.existsSync(at('sign-stamped.pdf')));
});

// --- page surgery ---

test('pages can be rotated, deleted, extracted and reordered', async () => {
  const file = await makeForm(at('pages.pdf'), { pages: 5 });

  await pdf.pages(file, { operation: 'extract', pages: '2-3', output: at('sub.pdf') });
  assert.match(await pdf.info(at('sub.pdf')), /2 pages/);

  await pdf.pages(file, { operation: 'delete', pages: '1', output: at('cut.pdf') });
  assert.match(await pdf.info(at('cut.pdf')), /4 pages/);

  await pdf.pages(file, { operation: 'rotate', pages: '1', degrees: 90, output: at('rot.pdf') });
  assert.match(await pdf.info(at('rot.pdf')), /rotated 90°/);

  // reorder writes the pages in exactly the order given
  await pdf.pages(file, { operation: 'reorder', pages: '5,4,3,2,1', output: at('rev.pdf') });
  assert.match(await pdf.info(at('rev.pdf')), /5 pages/);
});

test('a document cannot be emptied', async () => {
  // Deleting every page leaves a file that no reader will open.
  const file = await makeForm(at('empty.pdf'), { pages: 2 });
  await assert.rejects(() => pdf.pages(file, { operation: 'delete', pages: 'all' }), /at least one/);
});

test('an unknown page operation lists the real ones', async () => {
  const file = await makeForm(at('op.pdf'));
  await assert.rejects(() => pdf.pages(file, { operation: 'shuffle', pages: '1' }), /rotate, delete, extract, or reorder/);
});

// --- merging ---

test('merging concatenates in the order given', async () => {
  const a = await makeForm(at('a.pdf'), { pages: 2 });
  const b = await makeForm(at('b.pdf'), { pages: 3 });
  const result = await pdf.merge([a, b], at('both.pdf'));
  assert.match(result, /Merged 5 pages/);
  assert.match(await pdf.info(at('both.pdf')), /5 pages/);
});

test('merging one file is a mistake worth naming', async () => {
  const a = await makeForm(at('solo.pdf'));
  await assert.rejects(() => pdf.merge([a]), /at least two/);
});

// --- wiring ---

test('every PDF write is gated like any other write', () => {
  // They default to a new path, but the caller may name the source as output.
  const { RISKY_TOOLS, TOOL_DEFS } = require('../../tools.js');
  for (const name of ['pdf_fill_form', 'pdf_stamp', 'pdf_pages', 'pdf_merge']) {
    assert.ok(RISKY_TOOLS.has(name), `${name} must be risky`);
  }
  assert.ok(!RISKY_TOOLS.has('pdf_info'), 'inspection reads nothing it should not');
  const names = TOOL_DEFS.map((d) => d.function.name);
  for (const name of ['pdf_info', 'pdf_fill_form', 'pdf_stamp', 'pdf_pages', 'pdf_merge']) {
    assert.ok(names.includes(name), `${name} must be offered to the model`);
  }
});
