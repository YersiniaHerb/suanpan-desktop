const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AI_READABLE_TOOLS, buildCodexExecArgs, enrichAiPayload } = require('../electron/ai-payload.cjs');

function quote(code, name, price) {
  return {
    code,
    name,
    price,
    change: 1,
    changePercent: 1.2,
    volume: 1000,
    amount: 2000000,
    turnoverRate: 1.5,
    marketCap: 1000000000,
    pe: 12,
    pb: 1.1,
    updatedAt: 1780370000000,
  };
}

function createMarketStore() {
  const quotes = [
    quote('600519', '贵州茅台', 1300),
    quote('000001', '平安银行', 11),
  ];
  return {
    getStatus: () => ({
      connected: true,
      source: 'network',
      provider: 'test-live-provider',
      updatedAt: 1780370000000,
      count: quotes.length,
      klineCount: 12,
      intradayCount: 2,
      note: 'test status',
    }),
    listStocks: () => quotes.map((item) => ({ ...item })),
    getStocks: () => quotes.map((item) => ({ code: item.code, name: item.name, market: item.code[0] === '6' ? 'SH' : 'SZ', industry: '测试' })),
    getKLines: (code) => Array.from({ length: 8 }, (_, i) => ({
      code,
      timestamp: 1780300000000 + i * 86400000,
      open: 10 + i,
      high: 11 + i,
      low: 9 + i,
      close: 10.5 + i,
      volume: 1000 + i,
      amount: 10000 + i,
    })),
    getIntraday: (code) => Array.from({ length: 2 }, (_, i) => ({
      code,
      timestamp: 1780370000000 + i * 60000,
      timeLabel: `09:${String(30 + i).padStart(2, '0')}`,
      price: 10 + i / 100,
      avg: 10 + i / 200,
      volume: 1000 + i,
      amount: 10000 + i,
      preClose: 10,
      source: 'test-intraday',
    })),
  };
}

function createUserStateStore() {
  return {
    getState: () => ({
      watch: ['600519'],
      watchGroups: { 观察: ['600519'] },
      formulas: [{ name: '突破', code: 'XG: C > REF(C,1);' }],
      screeningStrategies: [{ id: 's1', name: '低估值' }],
      screeningResults: [{ code: '600519', name: '贵州茅台' }],
      screeningHistory: [{ at: 1780370000000, matched: 1 }],
      tradePlans: [{ id: 'p1', code: '600519', thesis: '研究计划哨兵' }],
      aiHistory: [{ at: 1780370000000, prompt: '数据接入了吗', reply: '已接入' }],
      aiConsensus: { summary: '共识哨兵' },
    }),
  };
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'costock-ai-payload-'));
  let rendererContext = null;
  const payload = enrichAiPayload({
    prompt: 'Codex 能访问什么数据？',
    context: {
      panel: 'market',
      currentCode: '600519',
      dataStatus: { stale: true },
    },
  }, {
    now: () => 1780371234567,
    getMarketStore: createMarketStore,
    getUserStateStore: createUserStateStore,
    getAiAppServerInfo: () => ({
      running: true,
      origin: 'http://127.0.0.1:12345',
      endpoints: { quotes: '/quotes' },
      capabilities: { readOnly: true },
    }),
    getSnapshotPath: () => path.join(dir, 'codex-data', 'latest-context.json'),
    codexCanReachLocalhost: () => true,
    setRendererContext: (context) => { rendererContext = context; },
  });

  assert.strictEqual(rendererContext.prompt, 'Codex 能访问什么数据？');
  assert.strictEqual(payload.context.marketStatus.provider, 'test-live-provider');
  assert.strictEqual(payload.context.dataStatus.marketDataConnected, true);
  assert.strictEqual(payload.context.dataStatus.intradayCount, 2);
  assert.strictEqual(payload.context.watchlist.codes[0], '600519');
  assert.strictEqual(payload.context.userState.watch[0], '600519');
  assert.strictEqual(payload.context.userState.formulas[0].name, '突破');
  assert.strictEqual(payload.context.userState.aiConsensus.summary, '共识哨兵');
  assert.strictEqual(payload.context.codexDataSnapshot.source, 'main-process-embedded-summary');
  assert.deepStrictEqual(payload.context.codexDataSnapshot.userStateSummary.watch, ['600519']);
  assert.strictEqual(payload.context.codexDataSnapshot.userStateSummary.formulaCount, 1);
  assert.strictEqual(payload.context.codexDataSnapshot.userStateSummary.hasConsensus, true);
  assert.strictEqual(payload.context.codexDataSnapshot.researchPlans[0].thesis, '研究计划哨兵');
  assert.ok(payload.context.codexDataSnapshot.embeddedQuotes.some((item) => item.code === '600519'));
  assert.ok(payload.context.codexDataSnapshot.intradayCodes.includes('600519'));
  assert.ok(payload.context.dataAccess.embeddedSnapshot);
  assert.ok(AI_READABLE_TOOLS.includes('watchlist'));
  assert.ok(AI_READABLE_TOOLS.includes('formulas'));
  assert.ok(AI_READABLE_TOOLS.includes('market_intraday'));
  assert.ok(payload.context.dataAccess.availableTools.includes('ai_consensus'));
  assert.deepStrictEqual(payload.context.dataAccess.availableTools, AI_READABLE_TOOLS);
  assert.strictEqual(payload.context.dataAccess.aiAppServer.codexReachable, true);
  assert.strictEqual(payload.context.dataAccess.aiAppServer.codexRequiredSandbox, 'danger-full-access');
  assert.ok(payload.context.dataAccess.codexDataSnapshotFile.readableViaAddDir);
  assert.strictEqual(payload.context.dataAccess.codexDataSnapshotFile.content, 'complete_loaded_market_user_renderer_context');

  const snapshotFile = payload.context.dataAccess.codexDataSnapshotFile;
  assert.ok(fs.existsSync(snapshotFile.path), snapshotFile.path);
  const full = JSON.parse(fs.readFileSync(snapshotFile.path, 'utf8'));
  assert.strictEqual(full.userState.aiConsensus.summary, '共识哨兵');
  assert.strictEqual(full.userState.tradePlans[0].thesis, '研究计划哨兵');
  assert.ok(full.klinesByCode['600519'].length > 0);
  assert.ok(full.intradayByCode['600519'].length > 0);

  const args = buildCodexExecArgs(payload, 'read-only');
  assert.deepStrictEqual(args.slice(0, 5), ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only']);
  assert.strictEqual(args[args.length - 1], '-');
  assert.ok(args.includes('--add-dir'), args.join(' '));
  assert.strictEqual(args[args.indexOf('--add-dir') + 1], snapshotFile.dir);
  const configuredArgs = buildCodexExecArgs(payload, 'read-only', {
    aiSettings: { baseUrl: 'https://api.example.com/v1' },
  });
  assert.ok(configuredArgs.includes('-c'), configuredArgs.join(' '));
  assert.ok(configuredArgs.includes('model_provider="costock_ui"'), configuredArgs.join(' '));
  assert.ok(configuredArgs.includes('model_providers.costock_ui.base_url="https://api.example.com/v1"'), configuredArgs.join(' '));
  assert.strictEqual(configuredArgs.includes('sk-test'), false, configuredArgs.join(' '));

  const withoutFile = buildCodexExecArgs({
    context: { dataAccess: { codexDataSnapshotFile: { dir: path.join(dir, 'missing') } } },
  }, 'workspace-write');
  assert.strictEqual(withoutFile.includes('--add-dir'), false);
  assert.deepStrictEqual(withoutFile.slice(0, 5), ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write']);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ai-payload injection ok');
}

main();
