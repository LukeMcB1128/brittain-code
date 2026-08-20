const test = require('node:test');
const assert = require('node:assert/strict');

const { protectMath } = require('../../renderer/features/math-renderer');
const marked = require('../../renderer/vendor/marked');
const katex = require('katex');

test('protects inline and display LaTeX before Markdown parsing', () => {
  const result = protectMath([
    '1. $\\lim_{x \\to 4} \\frac{x - 4}{x + 1}$',
    '',
    '$$\\frac{1}{2\\sqrt{6}} = \\frac{\\sqrt{6}}{12}$$',
    '',
    '\\[x_i^2 + y_i^2\\]',
    'and \\(a+b\\) inline.',
  ].join('\n'));

  assert.equal(result.segments.length, 4);
  assert.deepEqual(result.segments.map((segment) => segment.display), [false, true, true, false]);
  assert.equal(result.segments[0].source, '\\lim_{x \\to 4} \\frac{x - 4}{x + 1}');
  assert.doesNotMatch(result.text, /\\frac|\\lim/);
  assert.match(result.text, /^1\. /);
});

test('does not treat code, escaped dollars, or currency pairs as math', () => {
  const source = [
    '`const price = "$5"`',
    '```js',
    'const formula = "$x_i$";',
    '```',
    'The range is $5 and $10.',
    'An escaped delimiter is \\$x\\$.',
    'The actual formula is $x_i + y_i$.',
  ].join('\n');
  const result = protectMath(source);

  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].source, 'x_i + y_i');
  assert.match(result.text, /const formula = "\$x_i\$"/);
  assert.match(result.text, /\$5 and \$10/);
});

test('leaves incomplete streaming math as plain text until it closes', () => {
  const partial = protectMath('Working: $\\frac{1}{');
  const complete = protectMath('Working: $\\frac{1}{5}$');

  assert.equal(partial.segments.length, 0);
  assert.equal(partial.text, 'Working: $\\frac{1}{');
  assert.equal(complete.segments.length, 1);
  assert.equal(complete.segments[0].source, '\\frac{1}{5}');
});

test('protected formulas survive the production Markdown parser and compile with KaTeX', () => {
  const formula = '\\lim_{x \\to 0} \\frac{\\sqrt{x + 6} - \\sqrt{6}}{x}';
  const protectedMath = protectMath(`3. $${formula}$`);
  const html = marked.parse(protectedMath.text, { async: false });
  const rendered = katex.renderToString(protectedMath.segments[0].source, {
    displayMode: false,
    throwOnError: true,
    trust: false,
    output: 'htmlAndMathml',
  });

  assert.match(html, /BRITTAIN_MATH_0/);
  assert.match(html, /<ol(?:\s|>)/);
  assert.match(rendered, /katex-mathml/);
  assert.match(rendered, /mfrac/);
});
