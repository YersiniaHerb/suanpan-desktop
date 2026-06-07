const indicators = require('../prototype/js/indicators.js');
const formula = require('../prototype/js/formula.js');

function latest(list) {
  return Array.isArray(list) && list.length ? list[list.length - 1] : null;
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function fmtCap(v) {
  if (v == null || Number.isNaN(Number(v))) return '-';
  return v >= 1e12 ? `${(v / 1e12).toFixed(2)}万亿` : `${(v / 1e8).toFixed(0)}亿`;
}

const BUILTIN_NUMERIC_KEYS = {
  chg: true,
  drop: true,
  maUp: true,
  maDown: true,
  volR: true,
  turnover: true,
  marketCap: true,
  peMax: true,
  pbMax: true,
  newHigh: true,
  newLow: true,
};

const BUILTIN_SIGNAL_KEYS = {
  macdGold: true,
  macdDead: true,
  kdjGold: true,
  kdjDead: true,
};

function normalizeBuiltinConditions(input) {
  const out = {};
  const raw = input && typeof input === 'object' ? input : {};
  Object.keys(BUILTIN_NUMERIC_KEYS).forEach((key) => {
    if (!has(raw, key)) return;
    const value = Number(raw[key]);
    if (Number.isFinite(value)) out[key] = value;
  });
  Object.keys(BUILTIN_SIGNAL_KEYS).forEach((key) => {
    if (has(raw, key)) out[key] = true;
  });
  return out;
}

function quoteResult(stock, reasons, extra) {
  const quote = stock.quote || {};
  return {
    code: stock.code,
    name: stock.name || quote.name || stock.code,
    price: quote.price,
    changePercent: quote.changePercent,
    marketCap: quote.marketCap,
    pe: quote.pe,
    pb: quote.pb,
    reasons: reasons.slice(),
    ...(extra || {}),
  };
}

function indicatorSummary(stock) {
  const klines = stock && Array.isArray(stock.klines) ? stock.klines : [];
  if (!klines.length) return { ok: false, error: 'No klines available' };
  const closes = indicators.closes(klines);
  const vols = indicators.vols(klines);
  const n = closes.length - 1;
  const ma5 = indicators.MA(closes, 5)[n];
  const ma10 = indicators.MA(closes, 10)[n];
  const ma20 = indicators.MA(closes, 20)[n];
  const ma60 = indicators.MA(closes, 60)[n];
  const macd = indicators.MACD(closes);
  const kdj = indicators.KDJ(klines);
  const rsi14 = indicators.RSI(closes, 14)[n];
  const boll = indicators.BOLL(closes, 20, 2);
  const volMa5 = indicators.MA(vols, 5)[n];
  return {
    ok: true,
    code: stock.code,
    name: stock.name,
    lastClose: latest(closes),
    ma: {
      ma5: finite(ma5),
      ma10: finite(ma10),
      ma20: finite(ma20),
      ma60: finite(ma60),
    },
    macd: {
      dif: finite(macd.dif[n]),
      dea: finite(macd.dea[n]),
      value: finite(macd.macd[n]),
      state: macd.dif[n] != null && macd.dea[n] != null ? (macd.dif[n] > macd.dea[n] ? 'DIF_ABOVE_DEA' : 'DIF_BELOW_DEA') : null,
    },
    kdj: {
      k: finite(kdj.k[n]),
      d: finite(kdj.d[n]),
      j: finite(kdj.j[n]),
    },
    rsi14: finite(rsi14),
    boll: {
      mid: finite(boll.mid[n]),
      upper: finite(boll.upper[n]),
      lower: finite(boll.lower[n]),
    },
    volumeRatio5: volMa5 ? finite(vols[n] / volMa5) : null,
  };
}

function runFormulaScreener(marketStore, source, options) {
  const src = String(source || '').trim();
  const opts = options || {};
  const limit = Number(opts.limit || 200);
  if (!src) return { ok: false, error: 'Formula source is required' };
  const validation = formula.validate(src);
  if (!validation.ok) return { ok: false, error: validation.error, validation };

  const snapshot = marketStore.getSnapshot();
  const results = [];
  const failures = [];
  const stocks = Array.isArray(snapshot.stocks) ? snapshot.stocks : [];
  stocks.forEach((stock) => {
    try {
      const klines = Array.isArray(stock.klines) ? stock.klines : [];
      if (!klines.length) return;
      const run = formula.run(src, klines);
      if (!run.xg) return;
      const quote = stock.quote || {};
      results.push(quoteResult(stock, [`命中公式 ${run.xgName || 'XG'}`], {
        price: quote.price,
        changePercent: quote.changePercent,
        xgName: run.xgName,
        last: run.last,
      }));
    } catch (err) {
      failures.push({ code: stock.code, error: err && err.message ? err.message : String(err) });
    }
  });

  return {
    ok: true,
    source: src,
    scanned: stocks.length,
    matched: results.length,
    returned: results.slice(0, limit),
    failures,
  };
}

function runBuiltinScreener(marketStore, conditions, options) {
  const opts = options || {};
  const limit = Number(opts.limit || 200);
  const conds = normalizeBuiltinConditions(conditions);
  if (!Object.keys(conds).length) return { ok: false, error: 'At least one builtin condition is required', conditions: conds };

  const snapshot = marketStore.getSnapshot();
  const results = [];
  const failures = [];
  const stocks = Array.isArray(snapshot.stocks) ? snapshot.stocks : [];

  stocks.forEach((stock) => {
    try {
      const q = stock.quote || {};
      const kl = Array.isArray(stock.klines) ? stock.klines : [];
      const closes = indicators.closes(kl);
      const vols = indicators.vols(kl);
      const n = closes.length - 1;
      const reasons = [];
      let pass = true;

      if (has(conds, 'chg')) {
        if (q.changePercent >= conds.chg) reasons.push(`涨幅${q.changePercent.toFixed(2)}%`);
        else pass = false;
      }
      if (pass && has(conds, 'drop')) {
        if (q.changePercent <= conds.drop) reasons.push(`跌幅${q.changePercent.toFixed(2)}%`);
        else pass = false;
      }
      if (pass && has(conds, 'maUp')) {
        const ma = indicators.MA(closes, conds.maUp);
        const last = ma[n];
        if (last != null && q.price > last) reasons.push(`站上MA${conds.maUp}`);
        else pass = false;
      }
      if (pass && has(conds, 'maDown')) {
        const maDown = indicators.MA(closes, conds.maDown);
        const maDownLast = maDown[n];
        if (maDownLast != null && q.price < maDownLast) reasons.push(`跌破MA${conds.maDown}`);
        else pass = false;
      }
      if (pass && has(conds, 'volR')) {
        const mav = indicators.MA(vols, 5);
        const lv = mav[n];
        if (lv != null && q.volume >= lv * conds.volR) reasons.push(`放量${(q.volume / lv).toFixed(1)}倍`);
        else pass = false;
      }
      if (pass && has(conds, 'turnover')) {
        if (q.turnoverRate != null && q.turnoverRate >= conds.turnover) reasons.push(`换手${q.turnoverRate.toFixed(2)}%`);
        else pass = false;
      }
      if (pass && has(conds, 'marketCap')) {
        if (q.marketCap != null && q.marketCap >= conds.marketCap * 1e8) reasons.push(`总市值${fmtCap(q.marketCap)}`);
        else pass = false;
      }
      if (pass && has(conds, 'peMax')) {
        if (q.pe != null && q.pe <= conds.peMax) reasons.push(`PE ${q.pe.toFixed(2)}`);
        else pass = false;
      }
      if (pass && has(conds, 'pbMax')) {
        if (q.pb != null && q.pb <= conds.pbMax) reasons.push(`PB ${q.pb.toFixed(2)}`);
        else pass = false;
      }
      if (pass && (has(conds, 'macdGold') || has(conds, 'macdDead'))) {
        const m = indicators.MACD(closes);
        if (pass && has(conds, 'macdGold')) {
          if (m.dif[n] != null && m.dea[n] != null && m.dif[n - 1] != null && m.dea[n - 1] != null && m.dif[n - 1] <= m.dea[n - 1] && m.dif[n] > m.dea[n]) reasons.push('MACD金叉');
          else pass = false;
        }
        if (pass && has(conds, 'macdDead')) {
          if (m.dif[n] != null && m.dea[n] != null && m.dif[n - 1] != null && m.dea[n - 1] != null && m.dif[n - 1] >= m.dea[n - 1] && m.dif[n] < m.dea[n]) reasons.push('MACD死叉');
          else pass = false;
        }
      }
      if (pass && (has(conds, 'kdjGold') || has(conds, 'kdjDead'))) {
        const kdj = indicators.KDJ(kl);
        if (pass && has(conds, 'kdjGold')) {
          if (kdj.k[n] != null && kdj.d[n] != null && kdj.k[n - 1] != null && kdj.d[n - 1] != null && kdj.k[n - 1] <= kdj.d[n - 1] && kdj.k[n] > kdj.d[n]) reasons.push('KDJ金叉');
          else pass = false;
        }
        if (pass && has(conds, 'kdjDead')) {
          if (kdj.k[n] != null && kdj.d[n] != null && kdj.k[n - 1] != null && kdj.d[n - 1] != null && kdj.k[n - 1] >= kdj.d[n - 1] && kdj.k[n] < kdj.d[n]) reasons.push('KDJ死叉');
          else pass = false;
        }
      }
      if (pass && has(conds, 'newHigh')) {
        const hh = indicators.HHV(closes, conds.newHigh);
        if (q.price >= hh[n]) reasons.push(`创${conds.newHigh}日新高`);
        else pass = false;
      }
      if (pass && has(conds, 'newLow')) {
        const ll = indicators.LLV(closes, conds.newLow);
        if (q.price <= ll[n]) reasons.push(`创${conds.newLow}日新低`);
        else pass = false;
      }

      if (pass) results.push(quoteResult(stock, reasons));
    } catch (err) {
      failures.push({ code: stock && stock.code, error: err && err.message ? err.message : String(err) });
    }
  });

  return {
    ok: true,
    mode: 'builtin',
    conditions: conds,
    scanned: stocks.length,
    matched: results.length,
    returned: results.slice(0, limit),
    failures,
  };
}

function runStrategyScreener(marketStore, strategy, options) {
  if (!strategy || typeof strategy !== 'object') return { ok: false, error: 'Strategy is required' };
  const criteria = strategy.criteria && typeof strategy.criteria === 'object' ? strategy.criteria : {};
  const mode = criteria.mode || strategy.type;
  let result;
  if (mode === 'formula') {
    result = runFormulaScreener(marketStore, criteria.formula || strategy.formula || strategy.source || '', options);
  } else if (mode === 'builtin') {
    result = runBuiltinScreener(marketStore, criteria.conditions || strategy.conditions || {}, options);
  } else {
    return { ok: false, error: 'Unsupported strategy mode', strategyId: strategy.id || null, strategyName: strategy.name || '' };
  }
  return {
    ...result,
    strategyId: strategy.id || null,
    strategyName: strategy.name || '',
  };
}

module.exports = {
  indicators,
  formula,
  indicatorSummary,
  runFormulaScreener,
  runBuiltinScreener,
  runStrategyScreener,
};
