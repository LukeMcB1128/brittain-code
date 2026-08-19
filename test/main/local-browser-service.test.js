'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAllowedResourceUrl,
  isLoopbackHostname,
  parseLoopbackUrl,
  safeScreenshotName,
} = require('../../src/main/local-browser-service');

test('local browser accepts loopback pages and resources only', () => {
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('127.8.4.2'), true);
  assert.equal(isLoopbackHostname('[::1]'), true);
  assert.equal(parseLoopbackUrl('http://localhost:5173/app').port, '5173');
  assert.equal(isAllowedResourceUrl('ws://127.0.0.1:5173/hmr'), true);
  assert.equal(isAllowedResourceUrl('data:text/plain,ok'), true);
  assert.equal(isAllowedResourceUrl('https://example.com/script.js'), false);
  assert.equal(isAllowedResourceUrl('file:///tmp/secret'), false);
  assert.throws(() => parseLoopbackUrl('http://localhost.example.com/'), /Only localhost/);
  assert.throws(() => parseLoopbackUrl('http://user:pass@localhost/'), /credentials/);
});

test('local browser screenshot names cannot escape application data', () => {
  assert.equal(safeScreenshotName('../../bad name.png', 'session'), 'bad-name.png');
  assert.equal(safeScreenshotName('', 'session'), 'browser-session.png');
});
