const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildCodexDataSnapshot,
  compactCodexDataSnapshot,
  persistCodexDataSnapshot,
} = require('../electron/ai-context.cjs');

function makeQuote(i) {
  const code = String(600000 + i);
  return {
    code,
    name: `测试股${i}`,
    price: 10 + i,
    change: i % 2 ? 0.8 : -0.6,
    changePercent: i % 2 ? i / 10 : -i / 10,
    volume: 1000 + i,
    amount: 1000000 + i * 1000,
    turnoverRate: 1 + i / 100,
    marketCap: 1000000000 + i,
    floatMarketCap: 800000000 + i,
    pe: 10 + i / 10,
    pb: 1 + i / 100,
    updatedAt: 1780370000000 + i,
  };
}

function createFakeMarketStore() {
  const quotes = Array.from({ length: 125 }, (_, i) => makeQuote(i));
  return {
    listStocks: () => quotes.map((q) => ({ ...q })),
    getStocks: () => quotes.map((q) => ({ code: q.code, name: q.name, market: 'SH', industry: '测试' })),
    getKLines: (code, query) => {
      const limit = query && query.limit ? query.limit : 120;
      return Array.from({ length: Math.min(limit, 6) }, (_, i) => ({
        code,
        timestamp: 1780300000000 + i * 86400000,
        open: 10 + i,
        high: 11 + i,
        low: 9 + i,
        close: 10.5 + i,
        volume: 1000 + i,
        amount: 10000 + i,
      }));
    },
    getIntraday: (code, query) => {
      const limit = query && (query.points || query.limit) ? (query.points || query.limit) : 240;
      return Array.from({ length: Math.min(limit, 4) }, (_, i) => ({
        code,
        timestamp: 1780370000000 + i * 60000,
        timeLabel: `09:${String(30 + i).padStart(2, '0')}`,
        price: 10 + i / 100,
        avg: 10 + i / 200,
        volume: 1000 + i,
        amount: 10000 + i,
        preClose: 10,
        source: 'test-intraday',
      }));
    },
  };
}

function main() {
  const market = createFakeMarketStore();
  const marketStatus = { connected: true, provider: 'test-provider', count: 125, klineCount: 750 };
  const userState = {
    watch: ['600001', '600099'],
    watchGroups: { 观察: ['600001'] },
    formulas: [{ id: 'f1', name: '突破', source: 'XG: C > REF(C,1);' }],
    screeningStrategies: [{ id: 's1', name: '低估值', criteria: { peMax: 20 } }],
    screeningResults: [{ code: '600099', name: '测试股99' }],
    screeningHistory: [{ at: 1780370000000, matched: 1 }],
    tradePlans: [{ id: 'plan-1', code: '600099', thesis: '研究计划哨兵' }],
    aiHistory: [{ at: 1780370000000, prompt: '数据接入了吗' }],
    aiConsensus: { summary: '共识哨兵' },
  };
  const context = {
    currentCode: '600001',
    screener: { lastResults: [{ code: '600099' }] },
  };
  const rendererContext = { at: 1780370000000, context };

  const full = buildCodexDataSnapshot(market, marketStatus, userState, context, rendererContext);
  assert.strictEqual(full.quotes.length, 125);
  assert.deepStrictEqual(full.userState.watch, ['600001', '600099']);
  assert.strictEqual(full.userState.formulas[0].name, '突破');
  assert.strictEqual(full.userState.aiConsensus.summary, '共识哨兵');
  assert.strictEqual(full.userState.tradePlans[0].thesis, '研究计划哨兵');
  assert.ok(full.klinesByCode['600001'].length > 0);
  assert.ok(full.klinesByCode['600099'].length > 0);
  assert.ok(full.intradayByCode['600001'].length > 0);
  assert.ok(full.intradayByCode['600099'].length > 0);
  assert.strictEqual(full.coverage.intradayPointsPerCode, 240);

  const compact = compactCodexDataSnapshot(full, context, { quoteLimit: 5 });
  assert.ok(compact.embeddedQuotes.length <= 5);
  assert.strictEqual(compact.quoteCount, 125);
  assert.ok(compact.relevantCodes.includes('600001'));
  assert.ok(compact.relevantCodes.includes('600099'));
  assert.deepStrictEqual(compact.userStateSummary.watch, ['600001', '600099']);
  assert.strictEqual(compact.userStateSummary.formulaCount, 1);
  assert.strictEqual(compact.userStateSummary.researchPlanCount, 1);
  assert.strictEqual(compact.researchPlans[0].thesis, '研究计划哨兵');
  assert.ok(compact.intradayCodes.includes('600001'));
  assert.ok(compact.intradayCodes.includes('600099'));
  assert.strictEqual(compact.coverage.fullSnapshot, 'available_in_codexDataSnapshotFile');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'costock-ai-context-'));
  const persisted = persistCodexDataSnapshot(path.join(dir, 'latest-context.json'), full);
  const fromDisk = JSON.parse(fs.readFileSync(persisted.path, 'utf8'));
  assert.strictEqual(fromDisk.quotes.length, 125);
  assert.strictEqual(fromDisk.userState.formulas[0].source, 'XG: C > REF(C,1);');
  assert.deepStrictEqual(fromDisk.userState.watchGroups.观察, ['600001']);
  assert.strictEqual(fromDisk.userState.aiConsensus.summary, '共识哨兵');
  assert.ok(fromDisk.intradayByCode['600001'].length > 0);
  assert.ok(persisted.bytes > 1000);

  console.log('ai-context snapshot ok');
}

main();
