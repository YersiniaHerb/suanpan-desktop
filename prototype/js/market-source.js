(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoStockMarketSource = factory();
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  var DAY_MS = 24 * 3600 * 1000;
  var TRADE_DAYS = 250;

  var STOCK_DEFS = [
    { code: '600519', name: '贵州茅台', market: 'SH', industry: '白酒', base: 1680, vol: 0.018 },
    { code: '601318', name: '中国平安', market: 'SH', industry: '保险', base: 48, vol: 0.022 },
    { code: '600036', name: '招商银行', market: 'SH', industry: '银行', base: 35, vol: 0.02 },
    { code: '600276', name: '恒瑞医药', market: 'SH', industry: '医药', base: 46, vol: 0.028 },
    { code: '601012', name: '隆基绿能', market: 'SH', industry: '光伏', base: 22, vol: 0.035 },
    { code: '600900', name: '长江电力', market: 'SH', industry: '电力', base: 27, vol: 0.012 },
    { code: '601888', name: '中国中免', market: 'SH', industry: '免税', base: 95, vol: 0.03 },
    { code: '600030', name: '中信证券', market: 'SH', industry: '证券', base: 21, vol: 0.026 },
    { code: '600887', name: '伊利股份', market: 'SH', industry: '食品', base: 27, vol: 0.02 },
    { code: '601899', name: '紫金矿业', market: 'SH', industry: '有色', base: 15, vol: 0.03 },
    { code: '000001', name: '平安银行', market: 'SZ', industry: '银行', base: 11, vol: 0.022 },
    { code: '000333', name: '美的集团', market: 'SZ', industry: '家电', base: 62, vol: 0.024 },
    { code: '000858', name: '五粮液', market: 'SZ', industry: '白酒', base: 145, vol: 0.022 },
    { code: '002594', name: '比亚迪', market: 'SZ', industry: '汽车', base: 240, vol: 0.034 },
    { code: '300750', name: '宁德时代', market: 'SZ', industry: '电池', base: 195, vol: 0.036 },
    { code: '002415', name: '海康威视', market: 'SZ', industry: '安防', base: 31, vol: 0.026 },
    { code: '000651', name: '格力电器', market: 'SZ', industry: '家电', base: 38, vol: 0.02 },
    { code: '300059', name: '东方财富', market: 'SZ', industry: '互联网金融', base: 14, vol: 0.034 },
    { code: '002475', name: '立讯精密', market: 'SZ', industry: '电子', base: 33, vol: 0.03 },
    { code: '300760', name: '迈瑞医疗', market: 'SZ', industry: '医疗器械', base: 285, vol: 0.026 }
  ];

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashCode(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h >>> 0;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  function copyQuote(q) {
    if (!q) return null;
    return {
      code: q.code,
      name: q.name,
      price: q.price,
      preClose: q.preClose,
      open: q.open,
      high: q.high,
      low: q.low,
      change: q.change,
      changePercent: q.changePercent,
      volume: q.volume,
      amount: q.amount,
      turnoverRate: q.turnoverRate,
      marketCap: q.marketCap,
      floatMarketCap: q.floatMarketCap,
      pe: q.pe,
      pb: q.pb,
      updatedAt: q.updatedAt
    };
  }

  function copyKline(k) {
    if (!k) return null;
    return {
      code: k.code,
      period: k.period || '1d',
      timestamp: k.timestamp,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
      amount: k.amount,
      adjust: k.adjust
    };
  }

  function copyIntradayPoint(p) {
    if (!p) return null;
    return {
      code: p.code,
      period: p.period || '1m',
      timestamp: p.timestamp,
      timeLabel: p.timeLabel,
      price: p.price,
      avg: p.avg,
      preClose: p.preClose,
      high: p.high,
      low: p.low,
      volume: p.volume,
      amount: p.amount,
      source: p.source
    };
  }

  function copyStock(stock) {
    if (!stock) return null;
    return {
      code: stock.code,
      name: stock.name,
      market: stock.market,
      industry: stock.industry,
      quote: copyQuote(stock.quote),
      klines: (stock.klines || []).map(copyKline),
      intraday: (stock.intraday || []).map(copyIntradayPoint)
    };
  }

  function genKLines(def, nowTs) {
    var rng = mulberry32(hashCode(def.code));
    var klines = [];
    var price = def.base * (0.7 + rng() * 0.3);
    var trend = (rng() - 0.45) * def.vol * 0.5;
    var startTs = nowTs - TRADE_DAYS * DAY_MS;
    for (var i = 0; i < TRADE_DAYS; i++) {
      var drift = trend + (rng() - 0.5) * def.vol * 2;
      var open = price;
      var close = open * (1 + drift);
      var maxUp = open * 1.1, maxDown = open * 0.9;
      if (close > maxUp) close = maxUp;
      if (close < maxDown) close = maxDown;
      var hi = Math.max(open, close) * (1 + rng() * def.vol);
      var lo = Math.min(open, close) * (1 - rng() * def.vol);
      var volume = Math.round((0.5 + rng() * 1.5) * 1e6 * (def.base / 30 + 1));
      var amount = Math.round(volume * (open + close) / 2);
      klines.push({
        code: def.code,
        period: '1d',
        timestamp: startTs + i * DAY_MS,
        open: round2(open),
        high: round2(hi),
        low: round2(lo),
        close: round2(close),
        volume: volume,
        amount: amount,
        adjust: 'none'
      });
      price = close;
    }
    return klines;
  }

  function deriveQuote(stock, nowTs) {
    var quote = {};
    var raw = stock.quote || {};
    var klines = stock.klines || [];
    var last = klines.length ? klines[klines.length - 1] : null;
    var prev = klines.length > 1 ? klines[klines.length - 2] : null;

    quote.code = stock.code;
    quote.name = stock.name || raw.name || stock.code;
    quote.price = num(raw.price, last ? last.close : null);
    quote.preClose = num(raw.preClose, prev ? prev.close : quote.price);
    quote.open = num(raw.open, last ? last.open : quote.preClose);
    quote.high = num(raw.high, last ? last.high : quote.price);
    quote.low = num(raw.low, last ? last.low : quote.price);
    quote.change = num(raw.change, quote.price != null && quote.preClose != null ? round2(quote.price - quote.preClose) : null);
    quote.changePercent = num(raw.changePercent, quote.preClose ? round2((quote.change / quote.preClose) * 100) : null);
    quote.volume = num(raw.volume, last ? last.volume : 0);
    quote.amount = num(raw.amount, last ? last.amount : 0);
    quote.turnoverRate = num(raw.turnoverRate, null);
    quote.marketCap = num(raw.marketCap, num(raw.totalMarketCap, null));
    quote.floatMarketCap = num(raw.floatMarketCap, num(raw.circulatingMarketCap, null));
    quote.pe = num(raw.pe, num(raw.peRatio, null));
    quote.pb = num(raw.pb, num(raw.pbRatio, null));
    quote.updatedAt = num(raw.updatedAt, last ? last.timestamp : nowTs);
    return quote;
  }

  function normalizeKline(item, code) {
    if (!item) return null;
    return {
      code: item.code || code || '',
      period: item.period || '1d',
      timestamp: num(item.timestamp, Date.now()),
      open: num(item.open, 0),
      high: num(item.high, 0),
      low: num(item.low, 0),
      close: num(item.close, 0),
      volume: num(item.volume, 0),
      amount: num(item.amount, 0),
      adjust: item.adjust || 'none'
    };
  }

  function normalizeIntradayPoint(item, code) {
    if (!item) return null;
    return {
      code: item.code || code || '',
      period: item.period || '1m',
      timestamp: num(item.timestamp, Date.now()),
      timeLabel: item.timeLabel || '',
      price: num(item.price, null),
      avg: num(item.avg, num(item.price, null)),
      preClose: num(item.preClose, null),
      high: num(item.high, num(item.price, null)),
      low: num(item.low, num(item.price, null)),
      volume: num(item.volume, 0),
      amount: num(item.amount, 0),
      source: item.source || ''
    };
  }

  function normalizeStockRecord(raw, updatedAt) {
    if (!raw) return null;
    var base = raw.quote || raw.stock || raw;
    var code = raw.code || base.code;
    if (!code) return null;
    var stock = {
      code: code,
      name: raw.name || base.name || code,
      market: raw.market || base.market || '',
      industry: raw.industry || base.industry || '',
      klines: [],
      intraday: []
    };
    var klines = [];
    if (Array.isArray(raw.klines)) klines = raw.klines;
    else if (Array.isArray(raw.klines_1d)) klines = raw.klines_1d;
    else if (Array.isArray(raw.bars)) klines = raw.bars;
    else if (Array.isArray(raw.candles)) klines = raw.candles;
    for (var i = 0; i < klines.length; i++) {
      var item = normalizeKline(klines[i], code);
      if (item) stock.klines.push(item);
    }
    var intraday = Array.isArray(raw.intraday) ? raw.intraday : (Array.isArray(raw.minutes) ? raw.minutes : []);
    for (var m = 0; m < intraday.length; m++) {
      var point = normalizeIntradayPoint(intraday[m], code);
      if (point && point.price != null) stock.intraday.push(point);
    }
    stock.quote = deriveQuote({
      code: stock.code,
      name: stock.name,
      quote: raw.quote || raw,
      klines: stock.klines
    }, updatedAt);
    if (!stock.klines.length && stock.quote.price != null) {
      var price = stock.quote.price;
      var open = num(stock.quote.open, stock.quote.preClose != null ? stock.quote.preClose : price);
      var high = num(stock.quote.high, Math.max(open, price));
      var low = num(stock.quote.low, Math.min(open, price));
      stock.klines.push({
        code: stock.code,
        period: '1d',
        timestamp: stock.quote.updatedAt || updatedAt,
        open: open,
        high: high,
        low: low,
        close: price,
        volume: num(stock.quote.volume, 0),
        amount: num(stock.quote.amount, 0),
        adjust: 'none'
      });
    }
    return stock;
  }

  function flattenStocks(snapshot) {
    var rawStocks = [];
    if (Array.isArray(snapshot.stocks)) rawStocks = snapshot.stocks.slice();
    else if (Array.isArray(snapshot.quotes)) {
      rawStocks = snapshot.quotes.map(function (q) { return { code: q.code, name: q.name, market: q.market, industry: q.industry, quote: q }; });
    } else if (Array.isArray(snapshot.list)) {
      rawStocks = snapshot.list.slice();
    }
    if (Array.isArray(snapshot.codes) && !rawStocks.length) {
      rawStocks = snapshot.codes.map(function (code) { return { code: code }; });
    }
    return rawStocks;
  }

  function mergeKlinesByCode(stocks, snapshot) {
    if (!Array.isArray(snapshot.klines)) return stocks;
    var byCode = {};
    for (var i = 0; i < stocks.length; i++) byCode[stocks[i].code] = stocks[i];
    for (var j = 0; j < snapshot.klines.length; j++) {
      var k = normalizeKline(snapshot.klines[j]);
      if (!k || !k.code || !byCode[k.code]) continue;
      byCode[k.code].klines.push(k);
    }
    return stocks;
  }

  function createMockSnapshot() {
    var nowTs = Date.now();
    var stocks = STOCK_DEFS.map(function (def) {
      var klines = genKLines(def, nowTs);
      var last = klines[klines.length - 1];
      var prev = klines[klines.length - 2];
      var change = last.close - prev.close;
      var changePercent = (change / prev.close) * 100;
      var turnoverRate = round2((last.volume / 1e8) * (30 / def.base) * 100 % 12 + 0.5);
      var valRng = mulberry32(hashCode(def.code + ':valuation'));
      var shares = (0.7 + valRng() * 1.3) * 1e9 * (def.base > 100 ? 0.45 : 1.25);
      var marketCap = Math.round(last.close * shares);
      var floatMarketCap = Math.round(marketCap * (0.55 + valRng() * 0.35));
      var pe = round2(6 + valRng() * 42);
      var pb = round2(0.6 + valRng() * 8);
      return {
        code: def.code,
        name: def.name,
        market: def.market,
        industry: def.industry,
        quote: {
          code: def.code,
          name: def.name,
          price: last.close,
          preClose: prev.close,
          open: last.open,
          high: last.high,
          low: last.low,
          change: round2(change),
          changePercent: round2(changePercent),
          volume: last.volume,
          amount: last.amount,
          turnoverRate: turnoverRate,
          marketCap: marketCap,
          floatMarketCap: floatMarketCap,
          pe: pe,
          pb: pb,
          updatedAt: last.timestamp
        },
        klines: klines
      };
    });
    return {
      source: 'mock',
      provider: 'mock',
      connected: false,
      updatedAt: nowTs,
      note: '本地确定性行情样本',
      stocks: stocks
    };
  }

  function normalizeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return createMockSnapshot();
    var updatedAt = num(snapshot.updatedAt, Date.now());
    var rawStocks = flattenStocks(snapshot);
    var stocks = [];
    for (var i = 0; i < rawStocks.length; i++) {
      var stock = normalizeStockRecord(rawStocks[i], updatedAt);
      if (stock) stocks.push(stock);
    }
    stocks = mergeKlinesByCode(stocks, snapshot);
    for (var j = 0; j < stocks.length; j++) {
      stocks[j].quote = deriveQuote(stocks[j], updatedAt);
    }
    if (!stocks.length) return createMockSnapshot();
    return {
      source: snapshot.source || snapshot.provider || 'external',
      provider: snapshot.provider || snapshot.source || 'external',
      connected: snapshot.connected !== false && (snapshot.source || snapshot.provider || 'external') !== 'mock',
      updatedAt: updatedAt,
      note: snapshot.note || snapshot.message || '',
      stocks: stocks
    };
  }

  function createStore(initialSnapshot) {
    var snapshot = normalizeSnapshot(initialSnapshot || createMockSnapshot());
    var index = {};

    function rebuild() {
      index = {};
      for (var i = 0; i < snapshot.stocks.length; i++) {
        index[snapshot.stocks[i].code] = snapshot.stocks[i];
      }
    }

    function getStatus() {
      var klineCount = 0;
      var intradayCount = 0;
      for (var i = 0; i < snapshot.stocks.length; i++) {
        klineCount += (snapshot.stocks[i].klines || []).length;
        intradayCount += (snapshot.stocks[i].intraday || []).length;
      }
      return {
        connected: !!snapshot.connected,
        source: snapshot.source,
        provider: snapshot.provider,
        updatedAt: snapshot.updatedAt,
        count: snapshot.stocks.length,
        klineCount: klineCount,
        intradayCount: intradayCount,
        note: snapshot.note || ''
      };
    }

    function setSnapshot(next) {
      snapshot = normalizeSnapshot(next);
      rebuild();
      return getStatus();
    }

    function getSnapshot() {
      return {
        source: snapshot.source,
        provider: snapshot.provider,
        connected: snapshot.connected,
        updatedAt: snapshot.updatedAt,
        note: snapshot.note || '',
        stocks: snapshot.stocks.map(copyStock)
      };
    }

    function listStocks() {
      return snapshot.stocks.map(function (stock) { return copyQuote(stock.quote); });
    }

    function getStocks() {
      return snapshot.stocks.map(function (stock) {
        return {
          code: stock.code,
          name: stock.name,
          market: stock.market,
          industry: stock.industry
        };
      });
    }

    function allCodes() {
      return snapshot.stocks.map(function (stock) { return stock.code; });
    }

    function getStock(code) {
      return copyStock(index[code] || null);
    }

    function getQuote(code) {
      return copyQuote(index[code] ? index[code].quote : null);
    }

    function getQuotes(codes) {
      if (!Array.isArray(codes)) return [];
      return codes.map(function (code) { return copyQuote(index[code] ? index[code].quote : null); }).filter(Boolean);
    }

    function getKLines(codeOrQuery, query) {
      var code = codeOrQuery;
      if (codeOrQuery && typeof codeOrQuery === 'object') {
        query = codeOrQuery;
        code = codeOrQuery.code;
      }
      var stock = index[code];
      if (!stock) return [];
      var period = query && query.period ? query.period : '1d';
      var limit = query && query.limit ? Math.max(1, query.limit) : 0;
      var klines = stock.klines.filter(function (k) { return !k.period || k.period === period; });
      if (!klines.length && period !== '1d') klines = stock.klines.slice();
      if (limit) klines = klines.slice(-limit);
      return klines.map(copyKline);
    }

    function getIntraday(code, query) {
      var stock = index[code];
      if (!stock) return [];
      var count = query && query.points ? Math.max(10, query.points) : 240;
      if (Array.isArray(stock.intraday) && stock.intraday.length) {
        return stock.intraday.slice(-count).map(copyIntradayPoint);
      }
      var last = stock.klines.length ? stock.klines[stock.klines.length - 1] : null;
      if (!last) return [];
      var prev = stock.klines.length > 1 ? stock.klines[stock.klines.length - 2] : last;
      var base = prev.close || last.close || last.open || 1;
      var drift = (last.close - base) / base;
      var rng = mulberry32(hashCode(stock.code + ':' + (last.timestamp || 0)));
      var seq = [];
      var price = base;
      var start = 9 * 60 + 30;
      var end = 15 * 60;
      for (var i = 0; i < count; i++) {
        var frac = i / Math.max(1, count - 1);
        var minutes = start + frac * (end - start);
        var hour = Math.floor(minutes / 60);
        var minute = Math.round(minutes % 60);
        var minuteDrift = drift * 0.65 * frac + (rng() - 0.5) * 0.004;
        price = Math.max(0.01, base * (1 + minuteDrift));
        var avg = base * (1 + drift * frac * 0.5);
        seq.push({
          code: stock.code,
          period: '1m',
          timestamp: (last.timestamp || Date.now()) - (count - 1 - i) * 60000,
          timeLabel: (hour < 10 ? '0' + hour : String(hour)) + ':' + (minute < 10 ? '0' + minute : String(minute)),
          price: round2(price),
          avg: round2(avg),
          preClose: round2(base),
          high: round2(Math.max(price, avg) * (1 + rng() * 0.003)),
          low: round2(Math.min(price, avg) * (1 - rng() * 0.003)),
          volume: Math.round((0.5 + rng()) * 8000 * (1 + frac)),
        });
      }
      return seq;
    }

    rebuild();
    return {
      setSnapshot: setSnapshot,
      hydrate: setSnapshot,
      getStatus: getStatus,
      getSnapshot: getSnapshot,
      getStocks: getStocks,
      listStocks: listStocks,
      getQuotes: getQuotes,
      allCodes: allCodes,
      getStock: getStock,
      getQuote: getQuote,
      getKLines: getKLines,
      getIntraday: getIntraday
    };
  }

  return {
    STOCK_DEFS: STOCK_DEFS,
    createMockSnapshot: createMockSnapshot,
    normalizeSnapshot: normalizeSnapshot,
    createStore: createStore
  };
});
