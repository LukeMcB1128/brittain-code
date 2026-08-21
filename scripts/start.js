#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const electronPackage = require.resolve('electron/package.json');
const electronDirectory = path.dirname(electronPackage);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  });

  if (result.error) throw result.error;
  return result.status === 0;
}

function prepareMacRuntime() {
  if (process.platform !== 'darwin') return;

  const appPath = path.join(electronDirectory, 'dist', 'Electron.app');
  const executablePath = path.join(appPath, 'Contents', 'MacOS', 'Electron');

  if (!fs.existsSync(executablePath)) {
    console.log('Restoring the Electron development runtime...');
    const installed = run(process.execPath, [path.join(electronDirectory, 'install.js')]);
    if (!installed || !fs.existsSync(executablePath)) {
      throw new Error('Electron could not restore its macOS development runtime.');
    }
  }

  const valid = run('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'ignore' });
  if (valid) return;

  console.log('Preparing the Electron development runtime for macOS...');
  if (!run('codesign', ['--force', '--deep', '--sign', '-', appPath])) {
    throw new Error('Electron could not sign its macOS development runtime.');
  }
  if (!run('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'ignore' })) {
    throw new Error('Electron could not verify its macOS development runtime.');
  }
}

function start() {
  prepareMacRuntime();

  const electronPath = require('electron');
  const child = spawn(electronPath, [projectRoot, ...process.argv.slice(2)], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: false,
  });

  let childClosed = false;
  child.on('error', (error) => {
    console.error(`Electron failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    childClosed = true;
    if (signal) {
      console.error(`Electron exited with signal ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
    process.on(signal, () => {
      if (!childClosed) child.kill(signal);
    });
  }
}

try {
  start();
} catch (error) {
  console.error(`Electron failed to start: ${error.message}`);
  process.exitCode = 1;
}
