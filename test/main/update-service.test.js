const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createUpdateService } = require('../../src/main/update-service');

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {};
  updater.quitAndInstall = () => {};
  return updater;
}

test('release updater downloads stable updates and publishes progress', async () => {
  const updater = fakeUpdater();
  const states = [];
  updater.checkForUpdates = async () => {
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.4.7' });
    updater.emit('download-progress', { percent: 42.4 });
    updater.emit('update-downloaded', { version: '1.4.7' });
  };
  const service = createUpdateService({
    updater,
    enabled: true,
    currentVersion: '1.4.6',
    publish: (state) => states.push(state),
    logger: { error() {} },
  });

  service.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(service.state().status, 'downloaded');
  assert.equal(service.state().version, '1.4.7');
  assert.equal(states.some((state) => state.status === 'downloading' && state.percent === 42), true);
});

test('updater does not restart while work is active', () => {
  const updater = fakeUpdater();
  let installCalls = 0;
  updater.quitAndInstall = () => { installCalls += 1; };
  const service = createUpdateService({
    updater,
    enabled: true,
    currentVersion: '1.4.6',
    isBusy: () => true,
    logger: { error() {} },
  });
  service.start();
  updater.emit('update-downloaded', { version: '1.4.7' });

  assert.deepEqual(service.install(), {
    ok: false,
    error: 'Stop the active run or mission before you restart to update.',
  });
  assert.equal(installCalls, 0);
});

test('local builds keep update checks disabled', async () => {
  const updater = fakeUpdater();
  let checks = 0;
  updater.checkForUpdates = async () => { checks += 1; };
  const service = createUpdateService({
    updater,
    enabled: false,
    currentVersion: '1.4.6',
    logger: { error() {} },
  });

  service.start();
  const result = await service.check();

  assert.equal(checks, 0);
  assert.equal(result.ok, false);
  assert.equal(service.state().status, 'disabled');
});
