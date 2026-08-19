const base = require('../package.json').build;

const mac = { ...base.mac };
if (process.env.MAC_RELEASE_BUILD === '1') {
  delete mac.identity;
  mac.notarize = process.env.APPLE_TEAM_ID
    ? { teamId: process.env.APPLE_TEAM_ID }
    : true;
}

module.exports = {
  ...base,
  extraMetadata: {
    updateEnabled: true,
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
