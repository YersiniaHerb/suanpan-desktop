const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCodexExecEnv, resolveCodexBin, resolveCommandBin } = require('../electron/codex-cli.cjs');

const ROOT = path.join(__dirname, '..');

function commandOutput(cmd, args, options) {
  const res = spawnSync(cmd, args || [], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options && options.timeout ? options.timeout : 5000,
    env: (options && options.env) || process.env,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
    error: res.error ? res.error.message : '',
  };
}

function checkFile(rel) {
  const file = path.join(ROOT, rel);
  assert.ok(fs.existsSync(file), `${rel} is missing`);
  return { ok: true, path: file };
}

function checkElectron() {
  const local = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const resolved = fs.existsSync(local)
    ? { ok: true, bin: local, source: 'project-local' }
    : resolveCommandBin({
        command: 'electron',
        env: process.env,
        explicitEnvName: 'ELECTRON_BIN',
        notFoundMessage: 'Electron executable not found. Install project dependencies or provide ELECTRON_BIN.',
      });
  if (!resolved.ok) {
    return {
      ok: false,
      severity: 'error',
      searched: resolved.searched,
      message: resolved.message,
    };
  }
  const bin = resolved.bin;
  const version = commandOutput(bin, ['--version'], { timeout: 5000 });
  const isLocal = resolved.source === 'project-local';
  return {
    ok: version.ok,
    severity: version.ok ? (isLocal ? 'ok' : 'warn') : 'error',
    bin,
    source: resolved.source,
    version: version.stdout || version.stderr || version.error,
    message: isLocal
      ? 'Project-local Electron is available.'
      : 'Using global Electron. This machine can run the app, but a fresh machine needs local dependencies or ELECTRON_BIN.',
  };
}

function checkCodex() {
  const resolved = resolveCodexBin(process.env);
  if (!resolved.ok) {
    return {
      ok: false,
      severity: 'warn',
      searched: resolved.searched,
      message: `${resolved.message} AI chat will be unavailable until codex is installed or COSTOCK_CODEX_BIN is set.`,
    };
  }
  const version = commandOutput(resolved.bin, ['--version'], {
    timeout: 5000,
    env: createCodexExecEnv(process.env, resolved.bin),
  });
  return {
    ok: version.ok,
    severity: version.ok ? 'ok' : 'warn',
    bin: resolved.bin,
    source: resolved.source,
    version: version.stdout || version.stderr || version.error,
  };
}

async function checkMarketLive() {
  const marketSource = require('../prototype/js/market-source.js');
  const { createEastmoneySnapshot, fetchTencentIntraday } = require('../electron/market-eastmoney.cjs');
  try {
    const snapshot = await createEastmoneySnapshot({
      baseSnapshot: marketSource.createMockSnapshot(),
      codes: ['600519', '000001', '300750'],
      universe: 'current',
      quoteLimit: 3,
      klineCodeLimit: 2,
      klineLimit: 8,
      timeoutMs: 8000,
    });
    const first = Array.isArray(snapshot.stocks) ? snapshot.stocks[0] : null;
    let intraday = [];
    if (first) {
      intraday = await fetchTencentIntraday(first.code, {
        market: first.market,
        quote: first.quote,
        points: 240,
        timeoutMs: 8000,
      });
    }
    return {
      ok: !!snapshot.connected && intraday.length > 0,
      severity: snapshot.connected && intraday.length > 0 ? 'ok' : 'warn',
      provider: intraday.length > 0
        ? `${snapshot.provider || snapshot.source}+tencent-intraday`
        : (snapshot.provider || snapshot.source),
      count: Array.isArray(snapshot.stocks) ? snapshot.stocks.length : 0,
      klineCount: (snapshot.stocks || []).reduce((sum, stock) => sum + ((stock.klines || []).length), 0),
      intradayCount: intraday.length,
      intradaySampleCode: first ? first.code : '',
      sample: (snapshot.stocks || []).slice(0, 3).map((stock) => ({
        code: stock.code,
        name: stock.name,
        price: stock.quote && stock.quote.price,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      severity: 'warn',
      message: `Live market check failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

function checkUserState() {
  const { createStore } = require('../electron/user-state.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'costock-doctor-'));
  const store = createStore(path.join(dir, 'user-state.json'));
  const next = store.patchState({
    watch: ['600519'],
    tradePlans: [{ id: 'doctor-plan', code: '600519', name: '贵州茅台' }],
    aiConsensus: { summary: 'doctor-consensus' },
  });
  assert.deepStrictEqual(next.watch, ['600519']);
  assert.strictEqual(next.tradePlans.length, 1);
  assert.strictEqual(store.getStatus().hasConsensus, true);
  return {
    ok: true,
    path: store.path,
    status: store.getStatus(),
  };
}

async function main() {
  const checks = {
    requiredFiles: [
      checkFile('electron/main.cjs'),
      checkFile('electron/preload.cjs'),
      checkFile('prototype/index.html'),
      checkFile('prototype/js/app.js'),
      checkFile('prototype/js/chart.js'),
      checkFile('scripts/smoke-electron-runtime.cjs'),
    ],
    electron: checkElectron(),
    codex: checkCodex(),
    userState: checkUserState(),
    liveMarket: await checkMarketLive(),
  };

  const failures = [];
  if (!checks.electron.ok && checks.electron.severity === 'error') failures.push(checks.electron.message || 'Electron check failed');
  const output = {
    ok: failures.length === 0,
    checks,
    failures,
  };
  console.log(JSON.stringify(output, null, 2));
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
