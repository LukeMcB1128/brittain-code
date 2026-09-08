'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Arch } = require('builder-util');

function binaryArch(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.readUInt32LE(0) === 0xfeedfacf) {
    return { 0x01000007: 'x64', 0x0100000c: 'arm64' }[buffer.readUInt32LE(4)];
  }
  if (buffer.toString('ascii', 0, 2) === 'MZ') {
    const offset = buffer.readUInt32LE(0x3c);
    if (buffer.toString('ascii', offset, offset + 4) !== 'PE\0\0') return undefined;
    return { 0x8664: 'x64', 0xaa64: 'arm64' }[buffer.readUInt16LE(offset + 4)];
  }
  return undefined;
}

function nativeFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? nativeFiles(file) : entry.name.endsWith('.node') ? [file] : [];
  });
}

module.exports = async function verifyNativePackage(context) {
  const platform = context.electronPlatformName;
  if (!['darwin', 'win32'].includes(platform)) return;
  const arch = Arch[context.arch];
  const product = context.packager.appInfo.productFilename;
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, product + '.app', 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const files = nativeFiles(path.join(resources, 'app.asar.unpacked'));
  if (!files.some((file) => file.includes('canvas-'))) throw new Error('The package has no native Canvas binary.');
  for (const file of files) {
    if (binaryArch(file) !== arch) throw new Error(`Wrong native architecture for ${arch}: ${file}`);
  }
  // Use Electron's Node runtime so require/import can read the actual ASAR.
  // The installed Electron version is also the packaged Electron version.
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('Build on a runner that matches the target platform and architecture.');
  }
  execFileSync(require('electron'), [path.join(__dirname, 'packaged-pdf-smoke.js'), path.join(resources, 'app.asar')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    timeout: 60000,
  });
};
module.exports.binaryArch = binaryArch;
