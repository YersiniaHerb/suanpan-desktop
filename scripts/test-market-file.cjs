const assert = require('assert');
const { parseMarketText } = require('../electron/market-file.cjs');
const marketSource = require('../prototype/js/market-source.js');

function testQuoteSnapshot() {
  const snapshot = parseMarketText([
    'code,name,price,preClose,volume,amount',
    '600519,贵州茅台,1688.88,1660,1234567,2345678901'
  ].join('\n'), 'quotes.csv');
  assert.strictEqual(snapshot.stocks.length, 1);
  assert.strictEqual(snapshot.stocks[0].quote.code, '600519');
  assert.strictEqual(snapshot.stocks[0].quote.price, 1688.88);
  assert.strictEqual(snapshot.stocks[0].klines.length, 0);
}

function testLongFormKLines() {
  const snapshot = parseMarketText([
    'code,name,period,date,open,high,low,close,volume,amount',
    '600519,贵州茅台,1d,2025-05-28,1660,1680,1650,1675,1000000,1680000000',
    '600519,贵州茅台,1d,2025-05-29,1675,1695,1665,1688,1100000,1850000000',
    '000858,五粮液,1d,2025-05-29,142,146,141,145,900000,130000000'
  ].join('\n'), 'klines.csv');
  assert.strictEqual(snapshot.stocks.length, 2);
  const m = snapshot.stocks.find((s) => s.code === '600519');
  assert.strictEqual(m.klines.length, 2);
  assert.strictEqual(m.quote.price, 1688);
  assert.strictEqual(m.quote.preClose, 1675);
  assert.strictEqual(m.quote.change, 13);
  assert.strictEqual(m.quote.changePercent.toFixed(2), '0.78');
}

function testMixedRows() {
  const snapshot = parseMarketText([
    'code,name,price,preClose,period,date,open,high,low,close,volume,amount',
    '600276,恒瑞医药,41.2,40.8,1d,2025-05-29,40.8,41.6,40.5,41.2,888000,365000000',
    '300750,宁德时代,195.1,192.0,1d,2025-05-29,193.8,197.0,192.7,195.1,1234000,2410000000'
  ].join('\n'), 'mixed.csv');
  assert.strictEqual(snapshot.stocks.length, 2);
  const n = snapshot.stocks.find((s) => s.code === '300750');
  assert.strictEqual(n.quote.price, 195.1);
  assert.strictEqual(n.klines.length, 1);
  assert.strictEqual(n.klines[0].close, 195.1);
}

function testValuationFields() {
  const snapshot = parseMarketText([
    'code,name,price,preClose,marketCap,floatMarketCap,pe,pb',
    '600519,贵州茅台,1306.38,1309.60,1630743949321,1630743949321,14.97,6.02'
  ].join('\n'), 'valuation.csv');
  const q = snapshot.stocks[0].quote;
  assert.strictEqual(q.marketCap, 1630743949321);
  assert.strictEqual(q.floatMarketCap, 1630743949321);
  assert.strictEqual(q.pe, 14.97);
  assert.strictEqual(q.pb, 6.02);
}

function testQuoteOnlySnapshotNormalizesForDetail() {
  const snapshot = parseMarketText([
    'code,name,price,preClose,volume,amount',
    '600519,贵州茅台,1688.88,1660,1234567,2345678901'
  ].join('\n'), 'quote-only.csv');
  const store = marketSource.createStore(snapshot);
  const stock = store.getStock('600519');
  const q = stock.quote;
  assert.strictEqual(q.price, 1688.88);
  assert.strictEqual(q.preClose, 1660);
  assert.strictEqual(Number.isFinite(q.open), true);
  assert.strictEqual(Number.isFinite(q.high), true);
  assert.strictEqual(Number.isFinite(q.low), true);
  assert.strictEqual(Number.isFinite(q.change), true);
  assert.strictEqual(Number.isFinite(q.changePercent), true);
  assert.strictEqual(store.getKLines('600519').length, 1);
}

testQuoteSnapshot();
testLongFormKLines();
testMixedRows();
testValuationFields();
testQuoteOnlySnapshotNormalizesForDetail();

console.log('market-file smoke ok');
