const test = require('node:test');
const assert = require('node:assert/strict');

const { launchAgentPlist, daemonPath } = require('../../src/main/daemon');

test('a clean exit restarts the daemon', () => {
  // The old policy was KeepAlive{SuccessfulExit:false}: exit once cleanly and
  // launchd never tried again. The job sat at "runs = 1, last exit code = 0"
  // for days while the app reported it as installed.
  const plist = launchAgentPlist('/bin/electron', '/app');
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.ok(!plist.includes('SuccessfulExit'), 'a daemon that stays dead after a clean exit is not a daemon');
  // And a genuinely broken build must not spin.
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
});

test('the daemon gets a PATH that can find node', () => {
  // launchd supplies /usr/bin:/bin:/usr/sbin:/sbin, which has no node, so every
  // `npx`-based MCP server fails to start under the daemon while working when
  // the app is opened normally.
  const plist = launchAgentPlist('/bin/electron', '/app', { env: { PATH: '/opt/homebrew/bin:/usr/bin' } });
  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, /opt\/homebrew\/bin/);
});

test('the PATH keeps order, drops duplicates, and always has a floor', () => {
  const built = daemonPath('/my/tools:/usr/bin');
  assert.equal(built.indexOf('/my/tools'), 0, 'the installer\'s own PATH comes first');
  assert.equal(built.split(':').filter((entry) => entry === '/usr/bin').length, 1);
  for (const floor of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    assert.ok(built.split(':').includes(floor), `${floor} should be present`);
  }
  // An empty or launchd-minimal PATH still yields something usable.
  assert.ok(daemonPath('').includes('/usr/local/bin'));
  assert.ok(!daemonPath('').split(':').includes(''));
});

test('the daemon writes a log, so a dead one can be explained', () => {
  const plist = launchAgentPlist('/bin/electron', '', { logDir: '/data' });
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/data\/daemon\.out\.log<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key><string>\/data\/daemon\.err\.log<\/string>/);
  // Optional: no log directory, no keys, rather than a broken path.
  assert.ok(!launchAgentPlist('/bin/electron', '').includes('StandardOutPath'));
});

test('a packaged app takes no app-path argument', () => {
  const packaged = launchAgentPlist('/Applications/Brittain Code.app/Contents/MacOS/Brittain Code', '');
  assert.match(packaged, /<string>--headless<\/string>/);
  assert.equal((packaged.match(/<string>\/Applications/g) || []).length, 1);
});
