const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCodexExecEnv, resolveCodexBin, resolveCommandBin } = require('../electron/codex-cli.cjs');

function makeExecutable(file) {
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(file, 0o755);
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'costock-codex-cli-'));
  const bin = path.join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  makeExecutable(bin);

  const fromPath = resolveCodexBin({ PATH: dir });
  assert.strictEqual(fromPath.ok, true);
  assert.strictEqual(fromPath.bin, bin);

  const fromExplicit = resolveCodexBin({ PATH: '', COSTOCK_CODEX_BIN: bin });
  assert.strictEqual(fromExplicit.ok, true);
  assert.strictEqual(fromExplicit.bin, bin);
  assert.strictEqual(fromExplicit.source, 'COSTOCK_CODEX_BIN');

  const missingExplicit = resolveCodexBin({ PATH: dir, COSTOCK_CODEX_BIN: path.join(dir, 'missing-codex') });
  assert.strictEqual(missingExplicit.ok, false);
  assert.strictEqual(missingExplicit.source, 'COSTOCK_CODEX_BIN');

  const env = createCodexExecEnv({ PATH: '/usr/bin' }, bin);
  assert.strictEqual(env.PATH.split(path.delimiter)[0], dir);
  assert.ok(env.PATH.includes('/opt/homebrew/bin'));
  const envWithSettings = createCodexExecEnv({
    PATH: '/usr/bin',
    CODEX_API_KEY: 'old-key',
    CODEX_ACCESS_TOKEN: 'old-token',
  }, bin, {
    apiKey: 'sk-costock',
    baseUrl: 'https://api.example.com/v1',
  });
  assert.strictEqual(envWithSettings.OPENAI_API_KEY, 'sk-costock');
  assert.strictEqual(envWithSettings.CODEX_API_KEY, undefined);
  assert.strictEqual(envWithSettings.CODEX_ACCESS_TOKEN, undefined);
  assert.strictEqual(envWithSettings.OPENAI_BASE_URL, 'https://api.example.com/v1');
  assert.strictEqual(envWithSettings.OPENAI_API_BASE, 'https://api.example.com/v1');

  const electronDir = fs.mkdtempSync(path.join(os.tmpdir(), 'costock-electron-bin-'));
  const electronBin = path.join(electronDir, process.platform === 'win32' ? 'electron.cmd' : 'electron');
  makeExecutable(electronBin);
  const fromDefaultDir = resolveCommandBin({
    command: 'electron',
    env: { PATH: '/usr/bin' },
    explicitEnvName: 'ELECTRON_BIN',
    defaultPathDirs: [electronDir],
  });
  assert.strictEqual(fromDefaultDir.ok, true);
  assert.strictEqual(fromDefaultDir.bin, electronBin);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(electronDir, { recursive: true, force: true });
  console.log('codex-cli resolver smoke ok');
}

main();
