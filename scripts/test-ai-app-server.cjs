const assert = require('assert');
const http = require('http');
const { createAiAppServer } = require('../electron/ai-app-server.cjs');

function requestJson(url, token) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, {
      headers: token ? { 'x-costock-token': token } : {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
  });
}

function createFakeMarketStore() {
  const stock = {
    code: '600519',
    name: '贵州茅台',
    market: 'SH',
    industry: '白酒',
    quote: { code: '600519', name: '贵州茅台', price: 1306.38, changePercent: -0.25, marketCap: 1630743949321, pe: 14.97, pb: 6.02 },
    klines: [{ code: '600519', period: '1d', timestamp: 1780329600000, open: 1306, high: 1326, low: 1301, close: 1306.38, volume: 23867, amount: 3135678144 }],
    intraday: [{ code: '600519', timestamp: 1780370000000, timeLabel: '09:30', price: 1306.38, avg: 1306.38, volume: 23867, amount: 3135678144, preClose: 1310, source: 'test-intraday' }],
  };
  return {
    getStatus: () => ({ connected: true, provider: 'test', count: 1, klineCount: 1, intradayCount: 1 }),
    getSnapshot: () => ({ source: 'test', provider: 'test', connected: true, updatedAt: 1780370000000, stocks: [stock] }),
    getStocks: () => [{ code: stock.code, name: stock.name, market: stock.market, industry: stock.industry }],
    listStocks: () => [stock.quote],
    getStock: (code) => (code === stock.code ? stock : null),
    getQuote: (code) => (code === stock.code ? stock.quote : null),
    getKLines: (code) => (code === stock.code ? stock.klines : []),
    getIntraday: (code, query) => (code === stock.code ? stock.intraday.slice(0, query && query.limit ? query.limit : stock.intraday.length) : []),
  };
}

function createFakeUserStore() {
  const formulas = [{ id: 'formula-lib-1', name: '突破', source: 'XG: C > REF(C,1);' }];
  const screeningResults = [{ code: '600519', name: '贵州茅台', reasons: ['PE 14.97'] }];
  const screeningHistory = [{ at: 1780370000000, matched: 1, results: screeningResults }];
  const aiHistory = [{ at: 1780370000000, prompt: '数据接入了吗', reply: '已接入' }];
  const aiConsensus = { at: 1780370000000, summary: '关注低估值策略' };
  const tradePlans = [{ id: 'plan-1', code: '600519', name: '贵州茅台', status: 'watching', thesis: '低估值观察计划' }];
  const screeningStrategies = [
    {
      id: 'formula-1',
      name: '公式策略',
      type: 'formula',
      criteria: { mode: 'formula', formula: 'XG: C > 0;' },
    },
    {
      id: 'builtin-1',
      name: '低PE',
      type: 'builtin',
      criteria: { mode: 'builtin', conditions: { peMax: 20 } },
    },
  ];
  return {
    getStatus: () => ({
      watchCount: 1,
      formulaCount: formulas.length,
      screeningStrategyCount: screeningStrategies.length,
      screeningResultCount: screeningResults.length,
      screeningHistoryCount: screeningHistory.length,
      historyCount: aiHistory.length,
      hasConsensus: true,
      tradePlanCount: tradePlans.length,
    }),
    getState: () => ({
      watch: ['600519'],
      watchGroups: { 观察: ['600519'] },
      formulas,
      screeningStrategies,
      screeningResults,
      screeningHistory,
      aiHistory,
      aiConsensus,
      tradePlans,
      sideWidths: {},
    }),
  };
}

async function main() {
  const server = createAiAppServer({
    token: 'test-token',
    getMarketStore: createFakeMarketStore,
    getUserStateStore: createFakeUserStore,
    getRendererContext: () => ({ at: 1780370000000, context: { panel: 'market', currentCode: '600519' } }),
  });
  const info = await server.start();
  try {
    const health = await requestJson(`${info.origin}/health`);
    assert.strictEqual(health.statusCode, 200);
    assert.strictEqual(health.body.ok, true);

    const denied = await requestJson(`${info.origin}/snapshot`);
    assert.strictEqual(denied.statusCode, 401);

    const tools = await requestJson(`${info.origin}/tools`, 'test-token');
    assert.strictEqual(tools.statusCode, 200);
    assert.ok(tools.body.endpoints.marketStocks);
    assert.ok(tools.body.endpoints.marketIntraday);
    assert.ok(tools.body.endpoints.watchlist);
    assert.ok(tools.body.endpoints.formulas);
    assert.ok(tools.body.endpoints.screenerResults);
    assert.ok(tools.body.endpoints.aiConsensus);
    assert.ok(tools.body.endpoints.researchPlans);
    assert.strictEqual(tools.body.capabilities.readOnly, true);
    assert.ok(tools.body.capabilities.dataScopes.includes('watchlist'));
    assert.ok(tools.body.capabilities.dataScopes.includes('market_intraday'));
    assert.ok(tools.body.capabilities.dataScopes.includes('ai_consensus'));
    assert.ok(tools.body.capabilities.dataScopes.includes('research_plans'));

    const snapshot = await requestJson(`${info.origin}/snapshot`, 'test-token');
    assert.strictEqual(snapshot.statusCode, 200);
    assert.strictEqual(snapshot.body.market.stocks[0].code, '600519');
    assert.strictEqual(snapshot.body.userState.watch[0], '600519');

    const klines = await requestJson(`${info.origin}/market/klines/600519?limit=1`, 'test-token');
    assert.strictEqual(klines.statusCode, 200);
    assert.strictEqual(klines.body.klines.length, 1);

    const intraday = await requestJson(`${info.origin}/market/intraday/600519?limit=1`, 'test-token');
    assert.strictEqual(intraday.statusCode, 200);
    assert.strictEqual(intraday.body.intraday.length, 1);
    assert.strictEqual(intraday.body.intraday[0].source, 'test-intraday');

    const indicators = await requestJson(`${info.origin}/market/indicators/600519`, 'test-token');
    assert.strictEqual(indicators.statusCode, 200);
    assert.strictEqual(indicators.body.ok, true);
    assert.strictEqual(indicators.body.code, '600519');

    const formula = encodeURIComponent('XG: C > 0;');
    const screener = await requestJson(`${info.origin}/screener/formula?source=${formula}`, 'test-token');
    assert.strictEqual(screener.statusCode, 200);
    assert.strictEqual(screener.body.ok, true);
    assert.strictEqual(screener.body.matched, 1);

    const strategies = await requestJson(`${info.origin}/screener/strategies`, 'test-token');
    assert.strictEqual(strategies.statusCode, 200);
    assert.strictEqual(strategies.body.ok, true);
    assert.strictEqual(strategies.body.strategies.length, 2);

    const screenerResults = await requestJson(`${info.origin}/screener/results`, 'test-token');
    assert.strictEqual(screenerResults.statusCode, 200);
    assert.strictEqual(screenerResults.body.results[0].code, '600519');

    const screenerHistory = await requestJson(`${info.origin}/screener/history`, 'test-token');
    assert.strictEqual(screenerHistory.statusCode, 200);
    assert.strictEqual(screenerHistory.body.history.length, 1);

    const plans = await requestJson(`${info.origin}/plans`, 'test-token');
    assert.strictEqual(plans.statusCode, 200);
    assert.strictEqual(plans.body.plans[0].id, 'plan-1');

    const legacyPlans = await requestJson(`${info.origin}/trade/plans`, 'test-token');
    assert.strictEqual(legacyPlans.statusCode, 404);
    assert.strictEqual(legacyPlans.body.ok, false);

    const builtinConditions = encodeURIComponent(JSON.stringify({ peMax: 20 }));
    const builtin = await requestJson(`${info.origin}/screener/builtin?conditions=${builtinConditions}`, 'test-token');
    assert.strictEqual(builtin.statusCode, 200);
    assert.strictEqual(builtin.body.ok, true);
    assert.strictEqual(builtin.body.mode, 'builtin');
    assert.strictEqual(builtin.body.matched, 1);

    const formulaStrategy = await requestJson(`${info.origin}/screener/strategy/formula-1`, 'test-token');
    assert.strictEqual(formulaStrategy.statusCode, 200);
    assert.strictEqual(formulaStrategy.body.ok, true);
    assert.strictEqual(formulaStrategy.body.strategyId, 'formula-1');
    assert.strictEqual(formulaStrategy.body.matched, 1);

    const builtinStrategy = await requestJson(`${info.origin}/screener/strategy/builtin-1`, 'test-token');
    assert.strictEqual(builtinStrategy.statusCode, 200);
    assert.strictEqual(builtinStrategy.body.ok, true);
    assert.strictEqual(builtinStrategy.body.strategyId, 'builtin-1');
    assert.strictEqual(builtinStrategy.body.matched, 1);

    const missingStrategy = await requestJson(`${info.origin}/screener/strategy/missing`, 'test-token');
    assert.strictEqual(missingStrategy.statusCode, 404);
    assert.strictEqual(missingStrategy.body.ok, false);

    const watchlist = await requestJson(`${info.origin}/user/watchlist`, 'test-token');
    assert.strictEqual(watchlist.statusCode, 200);
    assert.strictEqual(watchlist.body.watch[0], '600519');

    const formulas = await requestJson(`${info.origin}/formulas`, 'test-token');
    assert.strictEqual(formulas.statusCode, 200);
    assert.strictEqual(formulas.body.formulas[0].id, 'formula-lib-1');

    const aiHistory = await requestJson(`${info.origin}/ai/history`, 'test-token');
    assert.strictEqual(aiHistory.statusCode, 200);
    assert.strictEqual(aiHistory.body.history[0].prompt, '数据接入了吗');

    const aiConsensus = await requestJson(`${info.origin}/ai/consensus`, 'test-token');
    assert.strictEqual(aiConsensus.statusCode, 200);
    assert.strictEqual(aiConsensus.body.consensus.summary, '关注低估值策略');

    const latest = await requestJson(`${info.origin}/context/latest`, 'test-token');
    assert.strictEqual(latest.body.latestRendererContext.context.currentCode, '600519');
  } finally {
    await server.stop();
  }
  console.log('ai-app-server smoke ok');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
