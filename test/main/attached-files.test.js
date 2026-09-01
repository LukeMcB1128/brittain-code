const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const attached = require('../../src/tools/attached-files');

const worksheet = { name: 'worksheet.pdf', path: '/Users/luke/Downloads/worksheet.pdf' };
const escaped = () => { throw new Error('fell through to the filesystem'); };

test.afterEach(() => attached.setAttachedFiles([]));

test('an attachment is reached by the name the person used', () => {
  // The model sees "worksheet.pdf" in the composer, not an absolute path.
  attached.setAttachedFiles([worksheet], { restrict: true });
  assert.equal(attached.resolveInput('worksheet.pdf', escaped), worksheet.path);
  assert.equal(attached.resolveInput('WORKSHEET.PDF', escaped), worksheet.path, 'case is not a puzzle worth failing on');
  assert.equal(attached.resolveInput(worksheet.path, escaped), worksheet.path, 'the real path works too');
});

test('chat cannot reach a file nobody attached', () => {
  // This is the whole point: chat has no filesystem, and the attachment list
  // is the only door into one.
  attached.setAttachedFiles([worksheet], { restrict: true });
  for (const wanted of ['/etc/passwd', '~/.ssh/id_rsa', '../../secrets.pdf', 'other.pdf']) {
    assert.throws(() => attached.resolveInput(wanted, escaped), /only be worked on if you attached them/, wanted);
  }
});

test('the refusal says what is actually available', () => {
  // Otherwise the model guesses at names and burns turns doing it.
  attached.setAttachedFiles([worksheet], { restrict: true });
  assert.throws(() => attached.resolveInput('nope.pdf', escaped), /Attached file: worksheet\.pdf/);
  attached.setAttachedFiles([], { restrict: true });
  assert.throws(() => attached.resolveInput('nope.pdf', escaped), /No files are attached/);
});

test('a restricted run cannot choose where output goes', () => {
  // An empty output means "beside the source, suffixed" — so there is no path
  // for a model to point at somewhere else.
  attached.setAttachedFiles([worksheet], { restrict: true });
  assert.equal(attached.resolveOutput('/tmp/anywhere.pdf', escaped), '');
  assert.equal(attached.resolveOutput('', escaped), '');
});

test('code mode is not restricted, and attachments are just extra names', () => {
  // It already has write_file and a project to use it on; narrowing here would
  // take away something that already works.
  attached.setAttachedFiles([worksheet], { restrict: false });
  assert.equal(attached.resolveInput('worksheet.pdf', escaped), worksheet.path);
  assert.equal(attached.resolveInput('src/report.pdf', (p) => `/project/${p}`), '/project/src/report.pdf');
  assert.equal(attached.resolveOutput('out.pdf', (p) => `/project/${p}`), '/project/out.pdf');
});

test('a pasted file has no path and is not offered for editing', () => {
  // There is nothing on disk to write back to; it stays context only.
  attached.setAttachedFiles([{ name: 'pasted.pdf', path: '' }, worksheet], { restrict: true });
  assert.deepEqual(attached.list().map((f) => f.name), ['worksheet.pdf']);
  assert.throws(() => attached.resolveInput('pasted.pdf', escaped), /only be worked on/);
});

test('each turn replaces the list rather than accumulating it', () => {
  // A file attached two turns ago is not still open for writing.
  attached.setAttachedFiles([worksheet], { restrict: true });
  attached.setAttachedFiles([{ name: 'lease.pdf', path: '/Users/luke/Downloads/lease.pdf' }], { restrict: true });
  assert.throws(() => attached.resolveInput('worksheet.pdf', escaped), /only be worked on/);
});

test('the restriction is bound to chat mode at the call site', () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  assert.match(main, /setAttachedFiles\(files, \{ restrict: mode === 'chat' \}\)/);
});

test('the dropped path comes from webUtils, since Electron 43 dropped File.path', () => {
  const fs = require('node:fs');
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'preload.js'), 'utf8');
  assert.match(preload, /webUtils\.getPathForFile\(file\)/);
  assert.match(preload, /webUtils/);
  // A paste throws inside getPathForFile; returning '' keeps it context-only
  // rather than failing the whole attachment.
  assert.match(preload, /catch \{ return ''; \}/);
});

// --- edits accumulate ---

const fs = require('node:fs');
const os = require('node:os');

test('the second edit builds on the first instead of erasing it', async (t) => {
  // The original failure: every call re-read the pristine attachment and wrote
  // the same output, so stamping a seven-page form left only the last page.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attached-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); attached.setAttachedFiles([]); });

  const source = path.join(dir, 'form.pdf');
  fs.writeFileSync(source, '%PDF-1.4 original');
  attached.setAttachedFiles([{ name: 'form.pdf', path: source }], { restrict: true });

  // First write: reads the original, writes the working copy.
  assert.equal(attached.resolveInput('form.pdf', escaped), source);
  const out = attached.resolveOutput('', escaped, source);
  assert.equal(out, path.join(dir, 'form-edited.pdf'));
  fs.writeFileSync(out, '%PDF-1.4 page 3 stamped');

  // Second write: reads what the first one produced.
  assert.equal(attached.resolveInput('form.pdf', escaped), out, 'continues from the edited version');
  assert.equal(attached.resolveOutput('', escaped, source), out, 'and keeps writing to the same file');
  assert.equal(fs.readFileSync(source, 'utf8'), '%PDF-1.4 original', 'the attachment itself is never modified');
});

test('accumulation survives the next turn, when the attachment list is rebuilt', async (t) => {
  // "now do page 4" arrives as a fresh turn. State held in memory would be gone
  // exactly then, so the working copy is derived from what is on disk.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attached-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); attached.setAttachedFiles([]); });

  const source = path.join(dir, 'form.pdf');
  fs.writeFileSync(source, '%PDF-1.4 original');
  fs.writeFileSync(path.join(dir, 'form-edited.pdf'), '%PDF-1.4 three pages done');

  attached.setAttachedFiles([{ name: 'form.pdf', path: source }], { restrict: true });
  assert.equal(attached.resolveInput('form.pdf', escaped), path.join(dir, 'form-edited.pdf'));
});

test('one file per document, whatever the operation', () => {
  // Not a chain of -stamped, -filled, -trimmed files to reassemble by hand.
  assert.equal(attached.workingCopyFor('/docs/lease.pdf'), path.join('/docs', 'lease-edited.pdf'));
  assert.equal(attached.workingCopyFor('/docs/lease.PDF'), path.join('/docs', 'lease-edited.PDF'));
});

test('a working copy can be named directly as the next input', () => {
  // Chaining one edit into the next is how you work through a document.
  attached.setAttachedFiles([worksheet], { restrict: true });
  const copy = attached.workingCopyFor(worksheet.path);
  assert.ok(attached.isWorkingCopy(copy));
  assert.equal(attached.resolveInput(copy, escaped), path.resolve(copy));
  assert.equal(attached.isWorkingCopy('/tmp/somewhere-edited.pdf'), false, 'only for files that were attached');
});

test('the result explains a coerced output rather than ignoring it silently', () => {
  // Six probing calls were spent discovering this by experiment.
  const tools = fs.readFileSync(path.join(__dirname, '..', '..', 'tools.js'), 'utf8');
  assert.match(tools, /function pdfNote\(requested, actual\)/);
  assert.match(tools, /was not used: chat cannot write elsewhere/);
  assert.match(tools, /edits accumulate in this one file/i);
  for (const tool of ['fillForm', 'stamp', 'pages', 'merge']) {
    assert.match(tools, new RegExp(`pdf\\.${tool}\\([\\s\\S]{0,200}?pdfNote\\(args\\.output, out\\)`), tool);
  }
});
