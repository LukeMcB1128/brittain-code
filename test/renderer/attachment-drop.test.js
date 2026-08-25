'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filesFromTransfer, hasFilePayload } = require('../../renderer/features/attachment-drop');

test('file drags are detected before the browser exposes the file list', () => {
  assert.equal(hasFilePayload({ types: ['text/plain', 'Files'], files: [] }), true);
  assert.equal(hasFilePayload({ types: ['text/plain'], files: [] }), false);
  assert.equal(hasFilePayload({ items: [{ kind: 'file' }] }), true);
  assert.equal(hasFilePayload(null), false);
});

test('dropped files come from the direct file list when available', () => {
  const screenshot = { name: 'Screenshot.png', type: 'image/png' };
  const fallback = { name: 'fallback.txt', type: 'text/plain' };
  const result = filesFromTransfer({
    files: [screenshot],
    items: [{ kind: 'file', getAsFile: () => fallback }],
  });
  assert.deepEqual(result, [screenshot]);
});

test('drop items provide a fallback when the direct list is empty', () => {
  const documentFile = { name: 'notes.md', type: 'text/markdown' };
  const result = filesFromTransfer({
    files: [],
    items: [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => documentFile },
      { kind: 'file', getAsFile: () => null },
    ],
  });
  assert.deepEqual(result, [documentFile]);
});
