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

test('provider, key and rates are all configured in one place', () => {
  // Splitting one coherent setting between a modal and a slash command means
  // neither is the answer to "where do I change this".
  const html = read('renderer/index.html');
  for (const id of ['setting-provider', 'setting-api-key', 'setting-input-rate', 'setting-output-rate']) {
    assert.ok(html.includes(`id="${id}"`), `${id} belongs in Settings`);
  }
  const app = read('renderer/app.js');
  assert.match(app, /provider: \$\('setting-provider'\)\.value === 'openai' \? 'openai' : 'ollama'/);
  assert.match(app, /inputPerMillion: Number\(\$\('setting-input-rate'\)\.value\) \|\| 0/);
});

test('the key is saved through its own channel, not with the settings blob', () => {
  // A credential should not ride along in an object that gets logged, diffed
  // and written to a plain-text file.
  const app = read('renderer/app.js');
  assert.match(app, /window\.api\.providerSetKey\(field\.value\)/);
  const save = app.slice(app.indexOf("inferenceEndpoint: $('setting-endpoint')"), app.indexOf("inferenceEndpoint: $('setting-endpoint')") + 500);
  assert.ok(!save.includes('setting-api-key'), 'the key must not be part of settingsSave');
  // And the field is cleared after saving, so it is not left on screen.
  assert.match(app, /field\.value = '';/);
});

test('cloud-only fields are hidden rather than shown dead', () => {
  const app = read('renderer/app.js');
  assert.match(app, /\$\('settings-cloud-fields'\)\.classList\.toggle\('hidden', !cloud\)/);
  assert.match(app, /addEventListener\('change', syncProviderFields\)/);
});

test('/provider reports state and points at Settings to change it', () => {
  const app = read('renderer/app.js');
  assert.match(app, /Change any of this in Settings\./);
  assert.ok(!app.includes('/provider key <value> stores the key'), 'configuration lives in one place');
});

test('the provider fields look like settings rows, not section headings', () => {
  // Standalone labels rendered as full-width text in the pane's grid, so they
  // competed with the section header instead of reading as fields.
  const html = read('renderer/index.html');
  const section = html.slice(html.indexOf('INFERENCE ENDPOINT'), html.indexOf('</section>', html.indexOf('INFERENCE ENDPOINT')));
  for (const field of ['Provider', 'API key', 'Cost per 1M input', 'Cost per 1M output']) {
    assert.ok(section.includes(`<label>${field} `), `${field} should be a label wrapping its control`);
  }
  assert.ok(!/<label for="setting-/.test(section), 'no detached labels in this pane');
});

test('the consequence of going cloud is beside the choice, not inside the dropdown', () => {
  // An option label cannot be read once the menu closes.
  const html = read('renderer/index.html');
  assert.ok(html.includes('<option value="openai">Cloud (OpenAI-compatible)</option>'));
  assert.ok(!html.includes('every message is sent to the endpoint</option>'));
  const app = read('renderer/app.js');
  assert.match(app, /Every message is sent to this endpoint, including the contents of files the agent reads\./);
  assert.match(app, /Inference runs on this machine\. Nothing is sent anywhere\./);
});

test('the copy explains the setting, not the implementation', () => {
  const html = read('renderer/index.html');
  assert.ok(!html.includes('Chosen rather than detected from the URL'), 'that reasoning belongs in a commit message');
  assert.ok(!html.includes('Never shown in full again'));
});
