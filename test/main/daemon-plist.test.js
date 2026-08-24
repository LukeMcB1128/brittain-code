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

// --- start and stop ---

const { launchctlArgs, LAUNCH_LABEL } = require('../../src/main/daemon');
const fs = require('node:fs');
const path = require('node:path');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

test('stopping a KeepAlive job means unloading it', () => {
  // `launchctl stop` on a KeepAlive job gets it restarted a second later, which
  // is the entire point of KeepAlive. bootout is the one that actually stops.
  assert.deepEqual(launchctlArgs('stop', { uid: 501 }), ['bootout', `gui/501/${LAUNCH_LABEL}`]);
  assert.deepEqual(launchctlArgs('start', { uid: 501, plistPath: '/p.plist' }), ['bootstrap', 'gui/501', '/p.plist']);
  assert.throws(() => launchctlArgs('frobnicate', { uid: 501 }), /unknown launchctl action/);
});

test('start doubles as restart', () => {
  // bootstrap refuses if the label is already loaded, and after editing the
  // plist a stale one is exactly what is loaded.
  const main = read('main.js');
  const body = main.slice(main.indexOf('async function startDaemon'), main.indexOf('ipcMain.handle(\'daemon:install\''));
  assert.match(body, /await launchctl\('stop'\);\s*\n\s*const started = await launchctl\('start', plistPath\)/);
});

test('start reports whether it is answering, not whether a command was issued', () => {
  // A daemon that loads and then exits is the exact failure this feature is
  // for; "installed" was already reported for one that had been dead for days.
  const main = read('main.js');
  const body = main.slice(main.indexOf('async function startDaemon'), main.indexOf("ipcMain.handle('daemon:install'"));
  assert.match(body, /await daemon\.daemonAlive\(settingsUserDataDir\)/);
  assert.match(body, /nothing answered on the socket within 5s/);
  assert.match(body, /daemon\.err\.log/, 'and points at the log that explains it');
});

test('start refuses when there is nothing installed to start', () => {
  const main = read('main.js');
  assert.match(main, /The daemon is not installed\. \/agent daemon install first\./);
});

test('stop verifies the daemon actually stopped', () => {
  const main = read('main.js');
  const body = main.slice(main.indexOf("ipcMain.handle('daemon:stop'"), main.indexOf("ipcMain.handle('daemon:stop'") + 700);
  assert.match(body, /const alive = await daemon\.daemonAlive/);
  assert.match(body, /It is still answering/);
  // Stopping something that was not running is not an error.
  assert.match(read('renderer/app.js'), /Daemon was not running\. Nothing to stop\./);
});

test('/agent daemon start and stop are wired through', () => {
  assert.match(read('renderer/app.js'), /if \(sub === 'start' \|\| sub === 'restart'\)/);
  assert.match(read('renderer/app.js'), /if \(sub === 'stop'\)/);
  assert.match(read('preload.js'), /daemonStart: \(\) => ipcRenderer\.invoke\('daemon:start'\)/);
  assert.match(read('preload.js'), /daemonStop: \(\) => ipcRenderer\.invoke\('daemon:stop'\)/);
  assert.match(read('renderer/app.js'), /\/agent daemon \[status\|start\|stop\|install\|uninstall\]/);
});
