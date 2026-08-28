const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.name.endsWith('.js') ? [target] : [];
  });
}

test('Ollama endpoint paths have one production owner', () => {
  const files = [
    path.join(root, 'main.js'),
    ...javascriptFiles(path.join(root, 'src', 'main')),
    ...javascriptFiles(path.join(root, 'benchmark', 'providers')),
  ].filter((file) => file !== path.join(root, 'src', 'main', 'inference.js'));
  const offenders = files.filter((file) => /['"]\/api\/(?:chat|tags|show|generate|embed|ps|version)['"]/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('all main-process text inference uses the selected transport', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.doesNotMatch(source, /ollamaJson\([^\n]*providerPath\('ollama', 'chat'\)/);
  assert.match(source, /const transport = transportFor\(runtimeSettings\.provider\)/);
});
