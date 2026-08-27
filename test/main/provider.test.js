const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSecretStore } = require('../../src/main/secrets');
const { DEFAULT_SETTINGS, normalizeSettings } = require('../../settings');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

const store = (safeStorage = null) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-secret-'));
  return { dir, secrets: createSecretStore({ userDataDir: () => dir, safeStorage }) };
};

test('the provider is chosen, never guessed from a URL', () => {
  // This decides whether a conversation leaves the machine.
  assert.equal(DEFAULT_SETTINGS.provider, 'ollama', 'local by default');
  assert.equal(normalizeSettings({ provider: 'openai' }).provider, 'openai');
  assert.equal(normalizeSettings({ provider: 'anthropic' }).provider, 'ollama', 'an unknown value stays local');
  assert.equal(normalizeSettings({}).provider, 'ollama');
});

test('a key is stored outside settings.json', () => {
  // settings.json is plain text a user is invited to edit and paste into bug
  // reports. A credential that pays for things does not belong there.
  const { dir, secrets } = store();
  secrets.set('providerApiKey', 'sk-secret-value');
  assert.equal(secrets.get('providerApiKey'), 'sk-secret-value');
  assert.ok(fs.existsSync(path.join(dir, 'credentials.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json')));
});

test('a key file is not world-readable', () => {
  const { dir, secrets } = store();
  secrets.set('providerApiKey', 'sk-x');
  const mode = fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('it encrypts where the OS allows and says so where it does not', () => {
  const fakeKeychain = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${text}`),
    decryptString: (buffer) => String(buffer).replace(/^enc:/, ''),
  };
  const { dir, secrets } = store(fakeKeychain);
  assert.equal(secrets.set('providerApiKey', 'sk-x').encrypted, true);
  assert.equal(secrets.get('providerApiKey'), 'sk-x');
  // On disk it must not be readable as-is.
  assert.ok(!fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8').includes('sk-x'));

  // Without a keychain it still works, and reports honestly that it is plain.
  const plain = store();
  assert.equal(plain.secrets.set('providerApiKey', 'sk-y').encrypted, false);
  assert.equal(plain.secrets.get('providerApiKey'), 'sk-y');
});

test('the key never crosses to the renderer', () => {
  const { secrets } = store();
  secrets.set('providerApiKey', 'sk-abcdefghijklmnop');
  const described = secrets.describe('providerApiKey');
  assert.equal(described.set, true);
  assert.ok(!described.hint.includes('efghijklm'), 'only the ends are shown');
  assert.match(described.hint, /^sk-a…mnop$/);
  // And the IPC handler returns describe(), not the value.
  const main = read('main.js');
  assert.match(main, /key: secrets\.describe\('providerApiKey'\)/);
  assert.ok(!/providerApiKey'\)\s*,\s*value/.test(main));
});

test('clearing a key removes it rather than storing an empty one', () => {
  const { secrets } = store();
  secrets.set('providerApiKey', 'sk-x');
  secrets.set('providerApiKey', '');
  assert.equal(secrets.get('providerApiKey'), '');
  assert.equal(secrets.describe('providerApiKey').set, false);
});

test('only a cloud transport is given the key', () => {
  const main = read('main.js');
  assert.match(main, /apiKey: transport\.needsKey \? secrets\.get\('providerApiKey'\) : ''/,
    'a local endpoint has no business receiving a credential');
});

test('the posture change is stated plainly, not buried', () => {
  const app = read('renderer/app.js');
  assert.match(app, /EVERY message in this mode leaves your machine/);
  assert.match(app, /Nothing leaves your machine: inference runs locally\./);
  // And it names the consequence that is easy to miss.
  assert.match(app, /reach well beyond the project folder/);
});

test('a missing key is called out before it becomes a confusing rejection', () => {
  assert.match(read('renderer/app.js'), /NOT SET — runs will be rejected/);
});
