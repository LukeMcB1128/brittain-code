const test = require('node:test');
const assert = require('node:assert/strict');

const { assessText } = require('../../attachments');

// Built from escapes so the file itself stays readable.
const pua = (n) => '\uE000'.repeat(n);
const control = (n) => '\u0001'.repeat(n);
const replacement = (n) => '\uFFFD'.repeat(n);
const prose = 'The Articles of Confederation were the first constitution of the United States. ';

test('ordinary prose is left alone', () => {
  assert.deepEqual(assessText(prose.repeat(6)), { usable: true });
});

test('a document with no text layer is a scan', () => {
  assert.equal(assessText('').usable, false);
  assert.equal(assessText('[Page 1]\n\n[Page 2]').reason, 'no text layer', 'page markers are not content');
});

test('private-use glyphs mean a subset font with no ToUnicode map', () => {
  // The glyphs draw correctly on screen and carry no meaning outside the file.
  // This is the case that reached the model as confident nonsense.
  const garbled = assessText(pua(200) + prose.repeat(3));
  assert.equal(garbled.usable, false);
  assert.match(garbled.reason, /private-use glyphs/);
});

test('replacement characters mean the bytes could not be decoded', () => {
  const garbled = assessText(replacement(100) + prose.repeat(3));
  assert.equal(garbled.usable, false);
  assert.match(garbled.reason, /replacement characters/);
});

test('control characters are not text', () => {
  const garbled = assessText(control(100) + prose.repeat(3));
  assert.equal(garbled.usable, false);
  assert.match(garbled.reason, /control characters/);
});

test('a few stray bad characters do not condemn a real document', () => {
  // Scanning a long document to images because of one mojibake character would
  // cost far more context than the flaw does.
  const mostlyFine = prose.repeat(40) + replacement(2) + pua(2);
  assert.deepEqual(assessText(mostlyFine), { usable: true });
});

test('other scripts are text, not garble', () => {
  // Every test is character-class based precisely so this holds: rasterizing a
  // perfectly good Chinese or Arabic PDF would waste an entire context window.
  assert.deepEqual(assessText('这是一份中文文档，内容完全可读。'.repeat(20)), { usable: true });
  assert.deepEqual(assessText('هذا مستند عربي يمكن قراءته بالكامل. '.repeat(20)), { usable: true });
  assert.deepEqual(assessText('Ελληνικό κείμενο που διαβάζεται κανονικά. '.repeat(20)), { usable: true });
});

test('a maths-heavy paper is symbols, not soup', () => {
  assert.deepEqual(assessText('∫∑√±≤≥×÷ ƒ(x) = ∂y/∂x → ∞ ∀ε>0 ∃δ '.repeat(20)), { usable: true });
});

test('a short extraction is not second-guessed', () => {
  // A cover page of five words can look like anything.
  assert.deepEqual(assessText(pua(20)), { usable: true });
  assert.equal(assessText(pua(400)).usable, false, 'a real sample is judged');
});

test('the reason names what was wrong, with a number', () => {
  // "Unreadable" alone sends someone looking for the wrong problem; the
  // percentage is what tells them whether the file or the reader is at fault.
  const reason = assessText(pua(200) + prose.repeat(3)).reason;
  assert.match(reason, /^\d+% private-use glyphs$/);
});

test('the emptiness check no longer decides on its own', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'attachments.js'), 'utf8');
  assert.match(source, /const quality = assessText\(text\);/);
  assert.match(source, /if \(!quality\.usable\) \{/);
  // A render failure on garbled text falls back to the text rather than
  // failing the attachment outright.
  assert.match(source, /What follows may be garbled/);
  assert.match(source, /unreadable text layer, \$\{quality\.reason\}/);
});
