const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAiSettingsStore, normalizeBaseUrl } = require('../electron/ai-settings.cjs');

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'costock-ai-settings-'));
  const file = path.join(dir, 'ai-settings.json');
  const crypto = {
    encrypt: (value) => Buffer.from(`enc:${value}`, 'utf8').toString('base64'),
    decrypt: (value) => Buffer.from(value, 'base64').toString('utf8').replace(/^enc:/, ''),
  };
  const store = createAiSettingsStore(file, crypto);

  assert.strictEqual(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.throws(() => normalizeBaseUrl('file:///tmp/key'), /http 或 https/);

  let publicState = store.save({ apiKey: 'sk-test-secret', baseUrl: 'https://api.example.com/v1/' });
  assert.strictEqual(publicState.hasApiKey, true);
  assert.strictEqual(publicState.apiKeyLabel, 'sk-t…cret');
  assert.strictEqual(publicState.baseUrl, 'https://api.example.com/v1');

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw.apiKeyPlain, undefined);
  assert.ok(raw.apiKeyEncrypted);
  assert.strictEqual(store.privateState().apiKey, 'sk-test-secret');

  publicState = store.save({ apiKey: '', baseUrl: 'https://next.example.com/v1' });
  assert.strictEqual(publicState.hasApiKey, true);
  assert.strictEqual(store.privateState().apiKey, 'sk-test-secret');
  assert.strictEqual(publicState.baseUrl, 'https://next.example.com/v1');

  publicState = store.save({ clearApiKey: true, baseUrl: '' });
  assert.strictEqual(publicState.hasApiKey, false);
  assert.strictEqual(publicState.hasBaseUrl, false);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ai-settings store ok');
}

main();
