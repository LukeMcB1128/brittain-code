// electron-builder afterSign hook (macOS only).
//
// Without a paid Developer ID, electron-builder's default signing step can
// leave the bundle's CodeDirectory out of sync with its actual contents —
// something (icon injection, resource copying, asarUnpack) touches files
// inside Contents/ after Electron's own internal signature was baked in,
// and nothing re-seals it. Gatekeeper then rejects the app with "code has
// no resources but signature indicates they must be present" / "modified
// since it was signed" — a hard failure, not the normal "unidentified
// developer" prompt that right-click → Open can bypass.
//
// Fix: force one clean, deep, ad-hoc re-sign as the LAST step of the build,
// after every other file has been written into the bundle.
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // CI release builds already have a Developer ID signature. Re-signing them
  // ad-hoc would break the trust chain used by notarization and auto-update.
  if (process.env.MAC_RELEASE_BUILD === '1') {
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
    return;
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
};
