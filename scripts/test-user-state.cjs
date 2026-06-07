const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, normalizeState } = require('../electron/user-state.cjs');

function sampleResult() {
  return {
    code: '600519',
    name: '贵州茅台',
    price: 1306.38,
    changePercent: -0.25,
    marketCap: 1630743949321,
    pe: 14.97,
    pb: 6.02,
    reasons: ['PE 14.97'],
  };
}

function sampleStrategy() {
  return {
    id: 'screen-test',
    name: '低估值放量',
    type: 'builtin',
    criteria: { mode: 'builtin', conditions: { peMax: 20, volR: 1.5 } },
    createdAt: 1780370000000,
    updatedAt: 1780370000000,
  };
}

function sampleTradePlan() {
  return {
    id: 'plan-test',
    code: '600519',
    name: '贵州茅台',
    status: 'watching',
    source: 'screener',
    createdAt: 1780370000000,
    updatedAt: 1780370000000,
    thesis: '低估值观察计划',
  };
}

function testNormalizeScreeningState() {
  const state = normalizeState({
    screeningStrategies: [sampleStrategy()],
    screeningResults: [sampleResult()],
    screeningHistory: [{ at: 1780370000000, matched: 1, results: [sampleResult()] }],
    tradePlans: [sampleTradePlan()],
    marketSort: { key: 'amount', dir: 'asc' },
  });
  assert.strictEqual(state.screeningStrategies.length, 1);
  assert.strictEqual(state.screeningResults.length, 1);
  assert.strictEqual(state.screeningHistory.length, 1);
  assert.strictEqual(state.tradePlans.length, 1);
  assert.strictEqual(state.screeningResults[0].code, '600519');
  assert.deepStrictEqual(state.marketSort, { key: 'amount', dir: 'asc' });
  assert.deepStrictEqual(normalizeState({ marketSort: { key: 'bad', dir: 'bad' } }).marketSort, { key: 'changePercent', dir: 'desc' });
}

function testPersistentStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'costock-user-state-'));
  const statePath = path.join(dir, 'user-state.json');
  const store = createStore(statePath);
  const patched = store.patchState({
    watch: ['600519'],
    screeningStrategies: [sampleStrategy()],
    screeningResults: [sampleResult()],
    screeningHistory: [{ at: 1780370000000, matched: 1, results: [sampleResult()] }],
    tradePlans: [sampleTradePlan()],
    marketSort: { key: 'marketCap', dir: 'asc' },
  });
  assert.strictEqual(patched.screeningStrategies.length, 1);
  assert.strictEqual(patched.screeningResults.length, 1);
  assert.strictEqual(patched.tradePlans.length, 1);
  assert.deepStrictEqual(patched.marketSort, { key: 'marketCap', dir: 'asc' });
  assert.strictEqual(store.getStatus().screeningResultCount, 1);
  assert.strictEqual(store.getStatus().tradePlanCount, 1);

  const reloaded = createStore(statePath);
  assert.strictEqual(reloaded.getState().screeningStrategies[0].name, '低估值放量');
  assert.strictEqual(reloaded.getState().screeningHistory.length, 1);
  assert.strictEqual(reloaded.getState().tradePlans[0].id, 'plan-test');
  assert.deepStrictEqual(reloaded.getState().marketSort, { key: 'marketCap', dir: 'asc' });
  assert.strictEqual(reloaded.getStatus().screeningHistoryCount, 1);
  assert.strictEqual(reloaded.getStatus().screeningStrategyCount, 1);
  assert.strictEqual(reloaded.getStatus().tradePlanCount, 1);
  assert.deepStrictEqual(reloaded.getStatus().marketSort, { key: 'marketCap', dir: 'asc' });
}

testNormalizeScreeningState();
testPersistentStore();

console.log('user-state smoke ok');
