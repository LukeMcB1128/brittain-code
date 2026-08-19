const UPDATE_EVENTS = [
  'checking-for-update',
  'update-available',
  'update-not-available',
  'download-progress',
  'update-downloaded',
  'error',
];

function cleanError(error) {
  const message = String(error?.message || error || 'Unknown update error').split('\n')[0].trim();
  return message || 'Unknown update error';
}

function createUpdateService({
  updater,
  enabled,
  currentVersion,
  isBusy = () => false,
  publish = () => {},
  logger = console,
}) {
  let started = false;
  let manualCheck = false;
  let state = {
    enabled: !!enabled,
    status: enabled ? 'idle' : 'disabled',
    currentVersion,
    version: null,
    percent: 0,
    message: enabled
      ? 'Updates are checked automatically.'
      : 'Automatic updates are available in official release builds.',
  };

  function setState(patch) {
    state = { ...state, ...patch };
    publish({ ...state });
    return { ...state };
  }

  function bindUpdaterEvents() {
    updater.on('checking-for-update', () => setState({
      status: 'checking',
      percent: 0,
      message: 'Checking for updates…',
    }));
    updater.on('update-available', (info) => setState({
      status: 'downloading',
      version: info?.version || null,
      percent: 0,
      message: `Downloading Brittain Code ${info?.version || 'update'}…`,
    }));
    updater.on('update-not-available', () => setState({
      status: 'up-to-date',
      version: null,
      percent: 0,
      message: 'Brittain Code is up to date.',
    }));
    updater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0)));
      setState({
        status: 'downloading',
        percent,
        message: `Downloading update… ${percent}%`,
      });
    });
    updater.on('update-downloaded', (info) => setState({
      status: 'downloaded',
      version: info?.version || state.version,
      percent: 100,
      message: `Brittain Code ${info?.version || state.version || 'update'} is ready.`,
    }));
    updater.on('error', (error) => {
      logger.error?.('Update error:', error);
      setState({
        status: manualCheck ? 'error' : 'idle',
        message: manualCheck ? `Update check failed: ${cleanError(error)}` : 'The automatic update check was not available.',
      });
    });
  }

  async function check({ manual = true } = {}) {
    if (!enabled) return { ok: false, state: { ...state }, error: state.message };
    if (['checking', 'downloading'].includes(state.status)) return { ok: true, state: { ...state } };
    manualCheck = !!manual;
    setState({ status: 'checking', percent: 0, message: 'Checking for updates…' });
    try {
      await updater.checkForUpdates();
      return { ok: true, state: { ...state } };
    } catch (error) {
      logger.error?.('Update check failed:', error);
      const message = cleanError(error);
      setState({
        status: manual ? 'error' : 'idle',
        message: manual ? `Update check failed: ${message}` : 'The automatic update check was not available.',
      });
      return { ok: false, state: { ...state }, error: message };
    } finally {
      manualCheck = false;
    }
  }

  function start() {
    if (started || !enabled) return;
    started = true;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    bindUpdaterEvents();
    void check({ manual: false });
  }

  function install() {
    if (!enabled) return { ok: false, error: state.message };
    if (state.status !== 'downloaded') return { ok: false, error: 'No downloaded update is ready.' };
    if (isBusy()) return { ok: false, error: 'Stop the active run or mission before you restart to update.' };
    setState({ status: 'installing', message: 'Restarting to install the update…' });
    updater.quitAndInstall(false, true);
    return { ok: true };
  }

  function dispose() {
    if (!started || !enabled) return;
    for (const event of UPDATE_EVENTS) updater.removeAllListeners(event);
    started = false;
  }

  return {
    start,
    check,
    install,
    dispose,
    state: () => ({ ...state }),
  };
}

module.exports = { cleanError, createUpdateService };
