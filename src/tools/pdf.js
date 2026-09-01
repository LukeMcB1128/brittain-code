'use strict';

// Editing PDFs.
//
// The app could already read them — attachments.js pulls text with unpdf and
// rasterizes scanned pages so a vision model can see them. Nothing could write
// one. These are the write operations, plus the inspection needed to know what
// to write.
//
// What a PDF actually supports shapes this whole module. A PDF stores glyphs at
// coordinates, not paragraphs, so there is no honest "replace the third
// sentence" operation and none is offered. What works cleanly is form fields,
// stamping content at a position, and page surgery — so that is the surface.
//
// Every operation writes somewhere new by default. Overwriting the source is
// possible but has to be asked for by name, because a PDF is usually the only
// copy of something that matters and there is no diff to recover it from.

const fs = require('fs');
const path = require('path');

// pdf-lib is loaded on demand. It is the only consumer of this dependency, and
// a session that never touches a PDF should not pay to parse it.
async function pdfLib() {
  return require('pdf-lib');
}

function readDocumentBytes(file) {
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  const bytes = fs.readFileSync(file);
  // A wrong file type reaches pdf-lib as a parse error naming an offset, which
  // tells nobody anything. The magic number is cheaper and says what is wrong.
  if (bytes.slice(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`Not a PDF: ${file} (missing the %PDF- header)`);
  }
  return bytes;
}

async function load(file, options = {}) {
  const { PDFDocument } = await pdfLib();
  try {
    return await PDFDocument.load(readDocumentBytes(file), {
      // Encrypted files load read-only rather than throwing, so inspection
      // still works and only the save fails, with a clearer message.
      ignoreEncryption: true,
      ...options,
    });
  } catch (error) {
    throw new Error(`Could not read ${path.basename(file)}: ${error.message}`);
  }
}

// Where a result goes when the caller did not say. Writing next to the source
// under a suffixed name means the default can never destroy the input.
function defaultOutput(input, suffix) {
  const extension = path.extname(input);
  return path.join(path.dirname(input), path.basename(input, extension) + suffix + (extension || '.pdf'));
}

// `output` is resolved by the caller against the workspace root; this only
// decides *which* path is meant, never whether it may be written.
function resolveOutput(input, output, suffix) {
  const target = String(output || '').trim();
  if (!target) return { path: defaultOutput(input, suffix), overwrites: false };
  return { path: target, overwrites: path.resolve(target) === path.resolve(input) };
}

async function save(document, target) {
  const bytes = await document.save();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return bytes.length;
}

// --- page ranges ---

// "1-3,7,12-" over a 20-page document. One-based and inclusive, because that
// is how a person reads a page number off the screen; the zero-based indices
// pdf-lib wants are this function's business, not the caller's.
function parsePages(spec, pageCount) {
  const text = String(spec ?? '').trim();
  if (!text || text.toLowerCase() === 'all') return [...Array(pageCount).keys()];

  const chosen = [];
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)?\s*-\s*(\d+)?$/);
    if (range) {
      const from = range[1] ? Number(range[1]) : 1;
      const to = range[2] ? Number(range[2]) : pageCount;
      if (from > to) throw new Error(`Page range "${piece}" runs backwards.`);
      for (let n = from; n <= to; n += 1) chosen.push(n);
      continue;
    }
    if (!/^\d+$/.test(piece)) throw new Error(`Cannot read "${piece}" as a page or range.`);
    chosen.push(Number(piece));
  }

  const seen = new Set();
  return chosen.filter((n) => {
    if (n < 1 || n > pageCount) throw new Error(`Page ${n} is outside this document (1-${pageCount}).`);
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  }).map((n) => n - 1);
}

// --- inspection ---

async function info(file) {
  const document = await load(file);
  const pages = document.getPages().map((page, index) => {
    const { width, height } = page.getSize();
    return { page: index + 1, width: Math.round(width), height: Math.round(height), rotation: page.getRotation().angle };
  });

  const lines = [
    `${path.basename(file)} — ${pages.length} page${pages.length === 1 ? '' : 's'}`,
    `Title: ${document.getTitle() || '(none)'}`,
    `Author: ${document.getAuthor() || '(none)'}`,
    `Encrypted: ${document.isEncrypted ? 'yes — fields and text may not be editable' : 'no'}`,
    '',
    'Pages (points, 72 = 1 inch):',
    ...pages.map((p) => `  ${p.page}: ${p.width} x ${p.height}${p.rotation ? ` rotated ${p.rotation}°` : ''}`),
  ];

  const fields = describeFields(document);
  lines.push('', fields.length ? `Form fields (${fields.length}):` : 'Form fields: none');
  lines.push(...fields.map((f) => `  ${f.name} [${f.type}]${f.options ? ` options: ${f.options.join(' | ')}` : ''}${f.value ? ` = ${f.value}` : ''}`));
  if (!fields.length) {
    lines.push('  If this document looks like a form on screen but reports none, it is likely XFA');
    lines.push('  (LiveCycle), which is a different format that cannot be filled here.');
  }
  return lines.join('\n');
}

function describeFields(document) {
  let form;
  try { form = document.getForm(); } catch { return []; }
  return form.getFields().map((field) => {
    const type = field.constructor.name.replace(/^PDF/, '');
    const entry = { name: field.getName(), type };
    try {
      if (typeof field.getOptions === 'function') entry.options = field.getOptions();
      if (typeof field.getText === 'function') entry.value = field.getText() || '';
      else if (typeof field.isChecked === 'function') entry.value = field.isChecked() ? 'checked' : '';
      else if (typeof field.getSelected === 'function') entry.value = (field.getSelected() || []).join(', ');
    } catch { /* a malformed field still reports its name and type */ }
    return entry;
  });
}

// --- filling ---

async function fillForm(file, values, { output, flatten = false } = {}) {
  const document = await load(file);
  const form = document.getForm();
  const available = form.getFields().map((f) => f.getName());
  if (!available.length) {
    throw new Error('This PDF has no fillable form fields. If it looks like a form, it is probably XFA (LiveCycle), which this cannot fill — use pdf_stamp to place text at coordinates instead.');
  }

  const applied = [];
  const missing = [];
  for (const [name, raw] of Object.entries(values || {})) {
    if (!available.includes(name)) { missing.push(name); continue; }
    applied.push(`${name} = ${String(raw)}`);
    setField(form.getField(name), raw);
  }
  // Naming a field that does not exist is a typo, not a no-op: silently
  // filling four of five fields produces a document that looks finished.
  if (missing.length) {
    throw new Error(`No such field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.\nAvailable: ${available.join(', ')}`);
  }

  // Flattening bakes the values into the page. It cannot be undone, so it is
  // opt-in even though it is what most finished documents want.
  if (flatten) form.flatten();

  const target = resolveOutput(file, output, '-filled');
  const size = await save(document, target.path);
  return `Filled ${applied.length} field${applied.length === 1 ? '' : 's'}${flatten ? ' and flattened' : ''} → ${target.path} (${size} bytes)\n`
    + applied.map((line) => `  ${line}`).join('\n');
}

function setField(field, raw) {
  const type = field.constructor.name;
  if (type.includes('CheckBox')) {
    const on = raw === true || /^(true|yes|on|checked|x|1)$/i.test(String(raw));
    if (on) field.check(); else field.uncheck();
    return;
  }
  if (type.includes('RadioGroup') || type.includes('Dropdown') || type.includes('OptionList')) {
    const options = field.getOptions();
    const wanted = String(raw);
    const match = options.find((o) => o === wanted)
      || options.find((o) => o.toLowerCase() === wanted.toLowerCase());
    if (!match) throw new Error(`"${wanted}" is not an option for ${field.getName()}. Options: ${options.join(' | ')}`);
    if (typeof field.select === 'function') field.select(match); else field.setOptions([match]);
    return;
  }
  field.setText(String(raw ?? ''));
}

// --- stamping ---

// Drawing text or an image at a position. This is what signing a PDF is, and
// it is also the only way to add content to a document that has no form.
async function stamp(file, { page = 1, x, y, text, image, size = 12, opacity = 1, output } = {}) {
  if (!text && !image) throw new Error('pdf_stamp needs either text or an image path.');
  const document = await load(file);
  const pages = document.getPages();
  const index = Number(page) - 1;
  if (!(index >= 0 && index < pages.length)) {
    throw new Error(`Page ${page} is outside this document (1-${pages.length}).`);
  }
  const target = pages[index];
  const { height } = target.getSize();

  // Coordinates arrive measured from the top-left, because that is where a
  // person reading the page thinks the origin is. PDF puts it bottom-left.
  const left = Number(x) || 0;
  const top = Number(y) || 0;

  if (image) {
    const bytes = fs.readFileSync(image);
    const extension = path.extname(image).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(extension)) {
      throw new Error(`Can only stamp PNG or JPEG images, not ${extension || 'that'}.`);
    }
    const embedded = extension === '.png'
      ? await document.embedPng(bytes)
      : await document.embedJpg(bytes);
    // `size` is the width to draw at; height follows the aspect ratio so a
    // signature is never stretched.
    const width = Number(size) || embedded.width;
    const scaled = embedded.scale(width / embedded.width);
    target.drawImage(embedded, { x: left, y: height - top - scaled.height, width: scaled.width, height: scaled.height, opacity: Number(opacity) });
    return finish(document, file, output, `Stamped ${path.basename(image)} on page ${page}`);
  }

  const { StandardFonts, rgb } = await pdfLib();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const points = Number(size) || 12;
  target.drawText(String(text), {
    x: left,
    // Text draws from its baseline; shifting by the font size puts the top of
    // the text where the caller pointed, which is what they meant.
    y: height - top - points,
    size: points,
    font,
    color: rgb(0, 0, 0),
    opacity: Number(opacity),
  });
  return finish(document, file, output, `Stamped text on page ${page}`);
}

async function finish(document, file, output, what) {
  const target = resolveOutput(file, output, '-stamped');
  const size = await save(document, target.path);
  return `${what} → ${target.path} (${size} bytes)`;
}

// --- page surgery ---

async function pages(file, { operation, pages: spec, degrees = 90, output } = {}) {
  const { PDFDocument, degrees: rotation } = await pdfLib();
  const source = await load(file);
  const count = source.getPageCount();
  const selected = parsePages(spec, count);

  if (operation === 'rotate') {
    for (const index of selected) {
      const page = source.getPage(index);
      page.setRotation(rotation((page.getRotation().angle + Number(degrees)) % 360));
    }
    return finishPages(source, file, output, '-rotated', `Rotated ${selected.length} page(s) by ${degrees}°`);
  }

  if (operation === 'delete') {
    if (selected.length >= count) throw new Error('That would delete every page; a PDF needs at least one.');
    // Removing from the end keeps the earlier indices valid.
    for (const index of [...selected].sort((a, b) => b - a)) source.removePage(index);
    return finishPages(source, file, output, '-trimmed', `Deleted ${selected.length} page(s), ${count - selected.length} remaining`);
  }

  if (operation === 'extract' || operation === 'reorder') {
    const built = await PDFDocument.create();
    const copied = await built.copyPages(source, selected);
    for (const page of copied) built.addPage(page);
    const suffix = operation === 'extract' ? '-extract' : '-reordered';
    const verb = operation === 'extract' ? 'Extracted' : 'Reordered to';
    return finishPages(built, file, output, suffix, `${verb} ${selected.length} page(s)`);
  }

  throw new Error(`Unknown page operation "${operation}". Use rotate, delete, extract, or reorder.`);
}

async function finishPages(document, file, output, suffix, what) {
  const target = resolveOutput(file, output, suffix);
  const size = await save(document, target.path);
  return `${what} → ${target.path} (${size} bytes)`;
}

// --- merging ---

async function merge(files, output) {
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  if (list.length < 2) throw new Error('pdf_merge needs at least two files.');
  const { PDFDocument } = await pdfLib();
  const built = await PDFDocument.create();

  const counts = [];
  for (const file of list) {
    const source = await load(file);
    const copied = await built.copyPages(source, source.getPageIndices());
    for (const page of copied) built.addPage(page);
    counts.push(`${path.basename(file)} (${copied.length})`);
  }

  const target = String(output || '').trim() || defaultOutput(list[0], '-merged');
  const size = await save(built, target);
  return `Merged ${built.getPageCount()} pages → ${target} (${size} bytes)\n  ${counts.join(' + ')}`;
}

module.exports = { info, fillForm, stamp, pages, merge, parsePages, describeFields, defaultOutput, resolveOutput };
