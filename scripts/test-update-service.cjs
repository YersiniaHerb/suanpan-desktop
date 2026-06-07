const assert = require('assert');
const {
  checkForUpdates,
  compareVersions,
  createUpdateService,
  releaseApiUrl,
} = require('../electron/update-service.cjs');

async function main() {
  assert.strictEqual(compareVersions('0.1.1', '0.1.0'), 1);
  assert.strictEqual(compareVersions('v0.1.0', '0.1.0'), 0);
  assert.strictEqual(compareVersions('0.2.0', '0.10.0'), -1);
  assert.strictEqual(releaseApiUrl('owner/repo'), 'https://api.github.com/repos/owner/repo/releases/latest');

  const release = {
    tag_name: 'v0.2.0',
    name: '算盘 v0.2.0',
    html_url: 'https://github.com/owner/repo/releases/tag/v0.2.0',
    published_at: '2026-06-03T12:00:00Z',
    assets: [
      { name: 'notes.txt', browser_download_url: 'https://example.invalid/notes.txt' },
      { name: 'suanpan-desktop-v0.2.0-macos-arm64.zip', browser_download_url: 'https://example.invalid/app.zip' },
    ],
  };
  const update = await checkForUpdates({
    currentVersion: '0.1.0',
    repository: 'owner/repo',
    now: () => 1780470000000,
    fetchJson: async (url) => {
      assert.strictEqual(url, 'https://api.github.com/repos/owner/repo/releases/latest');
      return release;
    },
  });
  assert.strictEqual(update.ok, true);
  assert.strictEqual(update.updateAvailable, true);
  assert.strictEqual(update.latestVersion, '0.2.0');
  assert.strictEqual(update.assetName, 'suanpan-desktop-v0.2.0-macos-arm64.zip');

  const current = await checkForUpdates({
    currentVersion: '0.2.0',
    repository: 'owner/repo',
    fetchJson: async () => release,
  });
  assert.strictEqual(current.ok, true);
  assert.strictEqual(current.updateAvailable, false);

  const failed = await checkForUpdates({
    currentVersion: '0.1.0',
    repository: 'owner/repo',
    fetchJson: async () => { throw new Error('not found'); },
  });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.updateAvailable, false);
  assert.ok(/not found/.test(failed.error));

  const service = createUpdateService({
    currentVersion: '0.1.0',
    repository: 'owner/repo',
    fetchJson: async () => release,
    startupDelayMs: 100000,
    intervalMs: 100000,
  });
  assert.strictEqual(service.getStatus().message, '等待自动检测');
  const serviceStatus = await service.check('test');
  assert.strictEqual(serviceStatus.updateAvailable, true);
  assert.strictEqual(service.getStatus().reason, 'test');
  service.stop();

  console.log('update-service ok');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
