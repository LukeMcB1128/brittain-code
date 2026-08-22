const test = require('node:test');
const assert = require('node:assert/strict');

const sandbox = require('../../src/main/sandbox');

test('the profile allows writes only inside the project, temp, and /dev', () => {
  const profile = sandbox.profileFor('/Users/someone/project');
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /subpath "\/Users\/someone\/project"/);
  assert.match(profile, /subpath "\/dev"/);
});

test('quotes and backslashes in a path cannot break out of the profile string', () => {
  const profile = sandbox.profileFor('/tmp/we"ird\\dir');
  assert.match(profile, /we\\"ird\\\\dir/);
});

test('wrapCommand yields a sandbox-exec argv on macOS and null elsewhere', () => {
  const argv = sandbox.wrapCommand('npm test', '/tmp/project');
  if (process.platform === 'darwin') {
    assert.equal(argv[0], 'sandbox-exec');
    assert.deepEqual(argv.slice(-3), ['/bin/sh', '-c', 'npm test']);
  } else {
    assert.equal(argv, null);
  }
});
