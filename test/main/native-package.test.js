const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const verify = require('../../scripts/verify-native-package');
const { Arch } = require('builder-util');

test('the package check rejects a native binary from another architecture', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-native-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const native = path.join(dir, 'Test.app/Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/canvas-darwin-arm64');
  fs.mkdirSync(native, { recursive: true });
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  const file = path.join(native, 'canvas.node');
  fs.writeFileSync(file, header);
  assert.equal(verify.binaryArch(file), 'arm64');
  await assert.rejects(verify({ electronPlatformName: 'darwin', arch: Arch.x64, appOutDir: dir,
    packager: { appInfo: { productFilename: 'Test' } } }), /Wrong native architecture for x64/);
});
