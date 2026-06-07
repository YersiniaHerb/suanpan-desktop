const assert = require('assert');
const {
  fetchAShareQuotes,
  normalizeCode,
  parseQuotePayload,
  parseKLinePayload,
  parseTencentQuotePayload,
  parseTencentKLinePayload,
  parseTencentIntradayPayload,
  parseSinaQuoteRows,
  parseTencentTime,
  parseTencentIntradayTimestamp,
  providerLabel,
  secidForCode,
  tencentSymbolForCode,
} = require('../electron/market-eastmoney.cjs');

function testNormalizeCode() {
  assert.strictEqual(normalizeCode('600519.SH'), '600519');
  assert.strictEqual(normalizeCode('SZ000001'), '000001');
  assert.strictEqual(secidForCode('600519'), '1.600519');
  assert.strictEqual(secidForCode('000001'), '0.000001');
  assert.strictEqual(tencentSymbolForCode('600519'), 'sh600519');
  assert.strictEqual(tencentSymbolForCode('000001'), 'sz000001');
  assert.strictEqual(parseTencentTime('20260602130157'), new Date(2026, 5, 2, 13, 1, 57).getTime());
  assert.strictEqual(parseTencentIntradayTimestamp('0931', '20260602161412'), new Date(2026, 5, 2, 9, 31, 0).getTime());
  assert.strictEqual(providerLabel('eastmoney'), '东方财富报价');
  assert.strictEqual(providerLabel('sina-a-share'), '新浪全A报价');
  assert.strictEqual(providerLabel('tencent-kline'), '腾讯日K');
  assert.strictEqual(providerLabel('tencent-intraday'), '腾讯分时');
}

function testParseQuotePayload() {
  const quotes = parseQuotePayload({
    data: {
      diff: [{
        f12: '600519',
        f13: 1,
        f14: '贵州茅台',
        f2: 1306.38,
        f3: -0.25,
        f4: -3.22,
        f5: 23867,
        f6: 3135678144,
        f8: 0.19,
        f9: 14.97,
        f15: 1326.36,
        f16: 1301,
        f17: 1306,
        f18: 1309.6,
        f20: 1630743949321,
        f21: 1630743949321,
        f23: 6.02,
      }],
    },
  }, 1780360000000);
  assert.strictEqual(quotes.length, 1);
  assert.strictEqual(quotes[0].code, '600519');
  assert.strictEqual(quotes[0].market, 'SH');
  assert.strictEqual(quotes[0].price, 1306.38);
  assert.strictEqual(quotes[0].turnoverRate, 0.19);
  assert.strictEqual(quotes[0].marketCap, 1630743949321);
  assert.strictEqual(quotes[0].pe, 14.97);
  assert.strictEqual(quotes[0].pb, 6.02);
}

function testParseAshareListPayload() {
  const quotes = parseQuotePayload({
    data: {
      total: 2,
      diff: [{
        f12: '000001',
        f13: 0,
        f14: '平安银行',
        f2: 11,
        f3: 0.09,
        f4: 0.01,
        f5: 617461,
        f6: 681788223.31,
        f8: 0.32,
        f9: 3.67,
        f15: 11.1,
        f16: 10.94,
        f17: 10.98,
        f18: 10.99,
        f20: 213465100178,
        f21: 213461607183,
        f23: 0.46,
      }, {
        f12: '000003',
        f13: 0,
        f14: 'PT金田A',
        f2: '-',
        f18: 2.71,
      }],
    },
  }, 1780370000000);
  assert.strictEqual(quotes.length, 1);
  assert.strictEqual(quotes[0].code, '000001');
  assert.strictEqual(quotes[0].market, 'SZ');
}

function testParseKLinePayload() {
  const klines = parseKLinePayload({
    data: {
      code: '600519',
      klines: [
        '2026-06-01,1327.00,1309.60,1327.00,1301.31,43845,5741133268.00,1.94,-1.24,-16.40,0.35',
        '2026-06-02,1306.00,1306.38,1326.36,1301.00,23867,3135678144.00,1.94,-0.25,-3.22,0.19',
      ],
    },
  });
  assert.strictEqual(klines.length, 2);
  assert.strictEqual(klines[1].code, '600519');
  assert.strictEqual(klines[1].period, '1d');
  assert.strictEqual(klines[1].open, 1306);
  assert.strictEqual(klines[1].close, 1306.38);
  assert.strictEqual(klines[1].adjust, 'qfq');
}

function testParseTencentKLinePayload() {
  const klines = parseTencentKLinePayload({
    code: 0,
    msg: '',
    data: {
      sh600519: {
        qfqday: [
          ['2026-06-01', '1327.000', '1309.600', '1327.000', '1301.310', '43845.000'],
          ['2026-06-02', '1306.00', '1304.51', '1326.36', '1301.00', '25032'],
        ],
      },
    },
  }, '600519');
  assert.strictEqual(klines.length, 2);
  assert.strictEqual(klines[1].code, '600519');
  assert.strictEqual(klines[1].period, '1d');
  assert.strictEqual(klines[1].open, 1306);
  assert.strictEqual(klines[1].close, 1304.51);
  assert.strictEqual(klines[1].high, 1326.36);
  assert.strictEqual(klines[1].low, 1301);
  assert.strictEqual(klines[1].volume, 2503200);
  assert.ok(klines[1].amount > 0);
  assert.strictEqual(klines[1].adjust, 'qfq');
}

function testParseTencentQuotePayload() {
  const quote = parseTencentQuotePayload({
    code: 0,
    msg: '',
    data: {
      sh600519: {
        qt: {
          sh600519: [
            '1', '贵州茅台', '600519', '1305.37', '1309.60', '1306.00', '25462', '12438', '13023',
            '1305.38', '3', '1305.37', '1', '1305.35', '1', '1305.32', '5', '1305.09', '1',
            '1306.00', '1', '1306.19', '2', '1306.30', '1', '1306.48', '28', '1306.84', '1',
            '', '20260602130157', '-4.23', '-0.32', '1326.36', '1301.00', '1305.37/25462/3343794026',
            '25462', '334379', '0.20', '19.73', '', '1326.36', '1301.00', '1.94', '16318.19',
            '16318.19', '6.09', '1440.56', '1178.64', '0.85', '-22', '1313.26', '14.97',
          ],
        },
      },
    },
  }, '600519');
  assert.strictEqual(quote.code, '600519');
  assert.strictEqual(quote.name, '贵州茅台');
  assert.strictEqual(quote.market, 'SH');
  assert.strictEqual(quote.price, 1305.37);
  assert.strictEqual(quote.preClose, 1309.6);
  assert.strictEqual(quote.open, 1306);
  assert.strictEqual(quote.high, 1326.36);
  assert.strictEqual(quote.low, 1301);
  assert.strictEqual(quote.change, -4.23);
  assert.strictEqual(quote.changePercent, -0.32);
  assert.strictEqual(quote.volume, 2546200);
  assert.strictEqual(quote.amount, 3343794026);
  assert.strictEqual(quote.turnoverRate, 0.2);
  assert.strictEqual(quote.pe, 14.97);
  assert.strictEqual(quote.pb, 6.09);
  assert.strictEqual(quote.marketCap, 1631819000000);
  assert.strictEqual(quote.floatMarketCap, 1631819000000);
  assert.strictEqual(quote.updatedAt, new Date(2026, 5, 2, 13, 1, 57).getTime());
}

function testParseTencentIntradayPayload() {
  const points = parseTencentIntradayPayload({
    code: 0,
    msg: '',
    data: {
      sh600519: {
        data: {
          data: [
            '0930 1306.00 295 38527000.00',
            '0931 1304.66 786 102475967.04',
          ],
        },
        qt: {
          sh600519: [
            '1', '贵州茅台', '600519', '1307.22', '1309.60', '1306.00', '36362', '17325', '19037',
            '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '20260602161412',
          ],
        },
      },
    },
  }, '600519');
  assert.strictEqual(points.length, 2);
  assert.strictEqual(points.provider, 'tencent-intraday');
  assert.strictEqual(points[0].code, '600519');
  assert.strictEqual(points[0].period, '1m');
  assert.strictEqual(points[0].timeLabel, '09:30');
  assert.strictEqual(points[0].timestamp, new Date(2026, 5, 2, 9, 30).getTime());
  assert.strictEqual(points[0].price, 1306);
  assert.strictEqual(points[0].preClose, 1309.6);
  assert.strictEqual(points[0].volume, 29500);
  assert.strictEqual(points[1].volume, 49100);
  assert.ok(points[1].avg > 1300);
  assert.strictEqual(points[1].source, 'tencent-intraday');
}

function testParseSinaQuoteRows() {
  const quotes = parseSinaQuoteRows([{
    symbol: 'sh600519',
    code: '600519',
    name: '贵州茅台',
    trade: '1307.220',
    pricechange: -2.38,
    changepercent: -0.182,
    settlement: '1309.600',
    open: '1306.000',
    high: '1326.360',
    low: '1301.000',
    volume: 3636200,
    amount: 4751095282,
    per: 15,
    pb: 6.1,
    mktcap: 16416513.39,
    nmc: 16416513.39,
    turnoverratio: 0.29,
  }], 1780370000000);
  assert.strictEqual(quotes.length, 1);
  assert.strictEqual(quotes[0].code, '600519');
  assert.strictEqual(quotes[0].market, 'SH');
  assert.strictEqual(quotes[0].price, 1307.22);
  assert.strictEqual(quotes[0].change, -2.38);
  assert.strictEqual(quotes[0].changePercent, -0.182);
  assert.strictEqual(quotes[0].marketCap, 164165133900);
  assert.strictEqual(quotes[0].floatMarketCap, 164165133900);
  assert.strictEqual(quotes[0].updatedAt, 1780370000000);
}

testNormalizeCode();
testParseQuotePayload();
testParseAshareListPayload();
testParseKLinePayload();
testParseTencentKLinePayload();
testParseTencentQuotePayload();
testParseTencentIntradayPayload();
testParseSinaQuoteRows();

console.log('market-eastmoney smoke ok');
