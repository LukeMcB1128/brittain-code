const base = require('../package.json').build;

const mac = { ...base.mac };
if (process.env.MAC_RELEASE_BUILD === '1') {
  delete mac.identity;
  mac.notarize = process.env.APPLE_TEAM_ID
    ? { teamId: process.env.APPLE_TEAM_ID }
    : true;
}

// Auto-update only works where the installed app can actually be replaced.
// Unsigned NSIS builds update fine; Squirrel.Mac needs a Developer ID
// signature, so an ad-hoc signed macOS build downloads an update it can
// never install. The build job opts in with UPDATE_ENABLED=1.
const updateEnabled = process.env.UPDATE_ENABLED === '1'
  || process.env.MAC_RELEASE_BUILD === '1';

module.exports = {
  ...base,
  extraMetadata: {
    updateEnabled,
  },
  mac,
  publish: [{
    provider: 'github',
    owner: 'LukeMcB1128',
    repo: 'brittain-code',
    // Platform jobs upload into one draft. CI publishes it only after every
    // required artifact exists, so clients cannot see a partial release.
    releaseType: 'draft',
  }],
};
