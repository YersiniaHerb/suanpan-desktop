const fs = require('fs');
const path = require('path');

function compactQuote(q) {
  if (!q) return null;
  return {
    code: q.code,
    name: q.name,
    price: q.price,
    change: q.change,
    changePercent: q.changePercent,
    volume: q.volume,
    amount: q.amount,
    turnoverRate: q.turnoverRate,
    marketCap: q.marketCap,
    floatMarketCap: q.floatMarketCap,
    pe: q.pe,
    pb: q.pb,
    open: q.open,
    high: q.high,
    low: q.low,
    preClose: q.preClose,
    updatedAt: q.updatedAt,
  };
}

function addUnique(list, seen, code) {
  const text = String(code || '').trim();
  if (!text || seen.has(text)) return;
  seen.add(text);
  list.push(text);
}

function collectCodes(context, userState) {
  const out = [];
  const seen = new Set();
  const ctx = context || {};
  const state = userState || {};
  addUnique(out, seen, ctx.currentCode);
  if (ctx.stock) addUnique(out, seen, ctx.stock.code);
  if (ctx.quote) addUnique(out, seen, ctx.quote.code);
  (Array.isArray(state.watch) ? state.watch : []).slice(0, 120).forEach((code) => addUnique(out, seen, code));
  (Array.isArray(state.tradePlans) ? state.tradePlans : []).slice(0, 120).forEach((plan) => addUnique(out, seen, plan && plan.code));
  const screener = ctx.screener || {};
  (Array.isArray(screener.lastResults) ? screener.lastResults : []).slice(0, 120).forEach((item) => addUnique(out, seen, (item.q && item.q.code) || item.code));
  return out;
}

function safeKLines(market, code, limit) {
  try {
    const bars = market.getKLines(code, { limit });
    return Array.isArray(bars) ? bars.slice(-limit) : [];
  } catch (err) {
    try {
      const bars = market.getKLines(code);
      return Array.isArray(bars) ? bars.slice(-limit) : [];
    } catch (inner) {
      return [];
    }
  }
}

function safeIntraday(market, code, limit) {
  if (!market || typeof market.getIntraday !== 'function') return [];
  try {
    const points = market.getIntraday(code, { points: limit, limit });
    return Array.isArray(points) ? points.slice(-limit) : [];
  } catch (err) {
    try {
      const points = market.getIntraday(code);
      return Array.isArray(points) ? points.slice(-limit) : [];
    } catch (inner) {
      return [];
    }
  }
}

function buildCodexDataSnapshot(market, marketStatus, userState, context, rendererContext) {
  const ctx = context || {};
  const state = userState || {};
  const quotes = market.listStocks().map(compactQuote).filter(Boolean);
  const codes = collectCodes(ctx, state);
  const klinesByCode = {};
  const intradayByCode = {};
  codes.forEach((code) => {
    const bars = safeKLines(market, code, 120);
    if (bars.length) {
      klinesByCode[code] = bars.map((k) => ({
        timestamp: k.timestamp,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
        amount: k.amount,
      }));
    }
    const points = safeIntraday(market, code, 240);
    if (points.length) {
      intradayByCode[code] = points.map((p) => ({
        timestamp: p.timestamp,
        timeLabel: p.timeLabel,
        price: p.price,
        avg: p.avg,
        volume: p.volume,
        amount: p.amount,
        preClose: p.preClose,
        source: p.source,
      }));
    }
  });
  return {
    generatedAt: Date.now(),
    source: 'main-process-file-snapshot',
    marketStatus,
    stocks: market.getStocks(),
    quotes,
    klinesByCode,
    intradayByCode,
    userState: state,
    rendererContext: rendererContext || null,
    coverage: {
      quotes: 'all_loaded_quotes',
      userState: 'complete_local_user_state',
      klines: 'loaded_for_current_watch_plans_and_recent_screener_codes',
      klineBarsPerCode: 120,
      intraday: 'loaded_for_current_watch_plans_and_recent_screener_codes_when_available',
      intradayPointsPerCode: 240,
    },
  };
}

function topQuotes(quotes, key, limit) {
  return quotes.slice().sort((a, b) => {
    const av = Number(a && a[key]);
    const bv = Number(b && b[key]);
    if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
    if (!Number.isFinite(av)) return 1;
    if (!Number.isFinite(bv)) return -1;
    return Math.abs(bv) - Math.abs(av);
  }).slice(0, limit);
}

function compactCodexDataSnapshot(fullSnapshot, context, options) {
  const full = fullSnapshot || {};
  const opts = options || {};
  const limit = Number(opts.quoteLimit || 80);
  const quotes = Array.isArray(full.quotes) ? full.quotes : [];
  const byCode = new Map(quotes.map((q) => [q.code, q]));
  const ctx = context || {};
  const state = full.userState || {};
  const relevantCodes = collectCodes(ctx, state);
  const selected = [];
  const seen = new Set();
  relevantCodes.forEach((code) => {
    const quote = byCode.get(code);
    if (!quote || seen.has(code)) return;
    seen.add(code);
    selected.push(quote);
  });
  topQuotes(quotes, 'amount', Math.ceil(limit / 2)).forEach((quote) => {
    if (!quote || seen.has(quote.code)) return;
    seen.add(quote.code);
    selected.push(quote);
  });
  topQuotes(quotes, 'changePercent', limit).forEach((quote) => {
    if (!quote || seen.has(quote.code) || selected.length >= limit) return;
    seen.add(quote.code);
    selected.push(quote);
  });

  return {
    generatedAt: full.generatedAt,
    source: 'main-process-embedded-summary',
    marketStatus: full.marketStatus,
    quoteCount: quotes.length,
    stockCount: Array.isArray(full.stocks) ? full.stocks.length : 0,
    embeddedQuotes: selected.slice(0, limit),
    relevantCodes,
    klineCodes: Object.keys(full.klinesByCode || {}),
    intradayCodes: Object.keys(full.intradayByCode || {}),
    userStateSummary: {
      watch: Array.isArray(state.watch) ? state.watch : [],
      watchGroups: state.watchGroups || {},
      formulaCount: Array.isArray(state.formulas) ? state.formulas.length : 0,
      screeningStrategyCount: Array.isArray(state.screeningStrategies) ? state.screeningStrategies.length : 0,
      screeningResultCount: Array.isArray(state.screeningResults) ? state.screeningResults.length : 0,
      screeningHistoryCount: Array.isArray(state.screeningHistory) ? state.screeningHistory.length : 0,
      researchPlanCount: Array.isArray(state.tradePlans) ? state.tradePlans.length : 0,
      aiHistoryCount: Array.isArray(state.aiHistory) ? state.aiHistory.length : 0,
      hasConsensus: !!state.aiConsensus,
    },
    researchPlans: Array.isArray(state.tradePlans) ? state.tradePlans.slice(0, 30) : [],
    aiConsensus: state.aiConsensus || null,
    coverage: {
      embeddedQuotes: `bounded_${limit}_quote_summary`,
      fullSnapshot: 'available_in_codexDataSnapshotFile',
    },
  };
}

function persistCodexDataSnapshot(filePath, snapshot) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    dir: path.dirname(filePath),
    bytes: stat.size,
    updatedAt: stat.mtimeMs,
  };
}

module.exports = {
  compactQuote,
  collectCodes,
  buildCodexDataSnapshot,
  compactCodexDataSnapshot,
  persistCodexDataSnapshot,
};
