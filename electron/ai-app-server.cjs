const http = require('http');
const crypto = require('crypto');
const {
  indicatorSummary,
  runFormulaScreener,
  runBuiltinScreener,
  runStrategyScreener,
} = require('./analysis-service.cjs');

const APP_SERVER_CAPABILITIES = {
  readOnly: true,
  dataScopes: [
    'market_snapshot',
    'market_quotes',
    'market_klines',
    'market_intraday',
    'technical_indicators',
    'watchlist',
    'formulas',
    'screening_strategies',
    'screening_results',
    'research_plans',
    'ai_history',
    'ai_consensus',
    'latest_renderer_context',
  ],
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function tokenFrom(req, url) {
  return req.headers['x-costock-token'] || url.searchParams.get('token') || '';
}

function codeFromPath(pathname, prefix) {
  return decodeURIComponent(pathname.slice(prefix.length)).replace(/^\//, '').trim();
}

const BUILTIN_CONDITION_KEYS = {
  chg: 'number',
  drop: 'number',
  maUp: 'number',
  maDown: 'number',
  volR: 'number',
  turnover: 'number',
  marketCap: 'number',
  peMax: 'number',
  pbMax: 'number',
  newHigh: 'number',
  newLow: 'number',
  macdGold: 'flag',
  macdDead: 'flag',
  kdjGold: 'flag',
  kdjDead: 'flag',
};

function parseBuiltinConditions(url) {
  const raw = url.searchParams.get('conditions');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'conditions must be a JSON object' };
      }
      return { conditions: parsed };
    } catch (err) {
      return { error: 'conditions must be valid JSON' };
    }
  }

  const conditions = {};
  Object.keys(BUILTIN_CONDITION_KEYS).forEach((key) => {
    if (!url.searchParams.has(key)) return;
    if (BUILTIN_CONDITION_KEYS[key] === 'flag') {
      conditions[key] = true;
      return;
    }
    const value = Number(url.searchParams.get(key));
    if (Number.isFinite(value)) conditions[key] = value;
  });
  return { conditions };
}

function createAiAppServer(options) {
  const opts = options || {};
  const host = opts.host || '127.0.0.1';
  const requestedPort = Number(opts.port || process.env.COSTOCK_AI_APP_PORT || 0);
  const token = opts.token || crypto.randomBytes(18).toString('hex');
  const startedAt = Date.now();
  let server = null;
  let info = null;

  function getMarketStore() {
    if (!opts.getMarketStore) throw new Error('getMarketStore is required');
    return opts.getMarketStore();
  }

  function getUserStateStore() {
    if (!opts.getUserStateStore) throw new Error('getUserStateStore is required');
    return opts.getUserStateStore();
  }

  function getRendererContext() {
    return opts.getRendererContext ? opts.getRendererContext() : null;
  }

  function publicInfo() {
    return info ? {
      running: true,
      origin: info.origin,
      token: info.token,
      startedAt,
      endpoints: {
        health: `${info.origin}/health`,
        tools: `${info.origin}/tools`,
        snapshot: `${info.origin}/snapshot`,
        marketStatus: `${info.origin}/market/status`,
        marketStocks: `${info.origin}/market/stocks`,
        marketQuotes: `${info.origin}/market/quotes`,
        marketQuote: `${info.origin}/market/quote/{code}`,
        marketKlines: `${info.origin}/market/klines/{code}?limit=120`,
        marketIntraday: `${info.origin}/market/intraday/{code}?limit=240`,
        marketIndicators: `${info.origin}/market/indicators/{code}`,
        formulaScreener: `${info.origin}/screener/formula?source=URL_ENCODED_FORMULA`,
        builtinScreener: `${info.origin}/screener/builtin?conditions=URL_ENCODED_JSON`,
        strategies: `${info.origin}/screener/strategies`,
        strategyScreener: `${info.origin}/screener/strategy/{id}`,
        screenerResults: `${info.origin}/screener/results`,
        screenerHistory: `${info.origin}/screener/history`,
        researchPlans: `${info.origin}/plans`,
        userState: `${info.origin}/user/state`,
        watchlist: `${info.origin}/user/watchlist`,
        formulas: `${info.origin}/formulas`,
        aiHistory: `${info.origin}/ai/history`,
        aiConsensus: `${info.origin}/ai/consensus`,
        latestContext: `${info.origin}/context/latest`,
      },
      auth: {
        header: 'x-costock-token',
        token: info.token,
      },
      capabilities: APP_SERVER_CAPABILITIES,
    } : { running: false };
  }

  function requireAuth(req, url) {
    return tokenFrom(req, url) === token;
  }

  function handle(req, res) {
    const url = new URL(req.url || '/', `http://${host}`);
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Only GET is supported' });
      return;
    }

    try {
      if (url.pathname === '/health') {
        sendJson(res, 200, { ok: true, service: 'costock-ai-app-server', startedAt });
        return;
      }
      if (!requireAuth(req, url)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }

      const market = getMarketStore();
      const user = getUserStateStore();

      if (url.pathname === '/tools') {
        sendJson(res, 200, publicInfo());
      } else if (url.pathname === '/snapshot') {
        sendJson(res, 200, {
          ok: true,
          marketStatus: market.getStatus(),
          userStatus: user.getStatus(),
          market: market.getSnapshot(),
          userState: user.getState(),
          latestRendererContext: getRendererContext(),
        });
      } else if (url.pathname === '/market/status') {
        sendJson(res, 200, { ok: true, status: market.getStatus() });
      } else if (url.pathname === '/market/stocks') {
        sendJson(res, 200, { ok: true, stocks: market.getStocks() });
      } else if (url.pathname === '/market/quotes') {
        sendJson(res, 200, { ok: true, quotes: market.listStocks() });
      } else if (url.pathname.startsWith('/market/quote/')) {
        const code = codeFromPath(url.pathname, '/market/quote/');
        const quote = market.getQuote(code);
        sendJson(res, quote ? 200 : 404, quote ? { ok: true, quote } : { ok: false, error: 'Quote not found', code });
      } else if (url.pathname.startsWith('/market/klines/')) {
        const code = codeFromPath(url.pathname, '/market/klines/');
        const limit = Number(url.searchParams.get('limit') || 0);
        const period = url.searchParams.get('period') || '1d';
        sendJson(res, 200, { ok: true, code, period, klines: market.getKLines(code, { period, limit }) });
      } else if (url.pathname.startsWith('/market/intraday/')) {
        const code = codeFromPath(url.pathname, '/market/intraday/');
        const limit = Number(url.searchParams.get('limit') || url.searchParams.get('points') || 240);
        const intraday = typeof market.getIntraday === 'function'
          ? market.getIntraday(code, { points: limit, limit })
          : [];
        sendJson(res, 200, { ok: true, code, intraday });
      } else if (url.pathname.startsWith('/market/indicators/')) {
        const code = codeFromPath(url.pathname, '/market/indicators/');
        const stock = market.getStock(code);
        sendJson(res, stock ? 200 : 404, stock ? indicatorSummary(stock) : { ok: false, error: 'Stock not found', code });
      } else if (url.pathname === '/screener/formula') {
        const source = url.searchParams.get('source') || url.searchParams.get('formula') || '';
        const limit = Number(url.searchParams.get('limit') || 200);
        const result = runFormulaScreener(market, source, { limit });
        sendJson(res, result.ok ? 200 : 400, result);
      } else if (url.pathname === '/screener/builtin') {
        const parsed = parseBuiltinConditions(url);
        if (parsed.error) {
          sendJson(res, 400, { ok: false, error: parsed.error });
          return;
        }
        const limit = Number(url.searchParams.get('limit') || 200);
        const result = runBuiltinScreener(market, parsed.conditions, { limit });
        sendJson(res, result.ok ? 200 : 400, result);
      } else if (url.pathname === '/screener/strategies') {
        const state = user.getState();
        sendJson(res, 200, { ok: true, strategies: Array.isArray(state.screeningStrategies) ? state.screeningStrategies : [] });
      } else if (url.pathname === '/screener/results') {
        const state = user.getState();
        sendJson(res, 200, { ok: true, results: Array.isArray(state.screeningResults) ? state.screeningResults : [] });
      } else if (url.pathname === '/screener/history') {
        const state = user.getState();
        sendJson(res, 200, { ok: true, history: Array.isArray(state.screeningHistory) ? state.screeningHistory : [] });
      } else if (url.pathname.startsWith('/screener/strategy/')) {
        const id = codeFromPath(url.pathname, '/screener/strategy/');
        const state = user.getState();
        const strategies = Array.isArray(state.screeningStrategies) ? state.screeningStrategies : [];
        const strategy = strategies.find((item) => item && item.id === id);
        if (!strategy) {
          sendJson(res, 404, { ok: false, error: 'Strategy not found', id });
          return;
        }
        const limit = Number(url.searchParams.get('limit') || 200);
        const result = runStrategyScreener(market, strategy, { limit });
        sendJson(res, result.ok ? 200 : 400, result);
      } else if (url.pathname === '/plans') {
        const state = user.getState();
        sendJson(res, 200, { ok: true, plans: Array.isArray(state.tradePlans) ? state.tradePlans : [] });
      } else if (url.pathname === '/user/state') {
        sendJson(res, 200, { ok: true, userState: user.getState(), status: user.getStatus() });
      } else if (url.pathname === '/user/watchlist') {
        const state = user.getState();
        sendJson(res, 200, { ok: true, watch: Array.isArray(state.watch) ? state.watch : [], watchGroups: state.watchGroups || {} });
      } else if (url.pathname === '/formulas') {
        const state = user.getState();
        sendJson(res, 200, { ok: true, formulas: Array.isArray(state.formulas) ? state.formulas : [] });
      } else if (url.pathname === '/ai/history') {
        const state = user.getState();
        sendJson(res, 200, { ok: true, history: Array.isArray(state.aiHistory) ? state.aiHistory : [] });
      } else if (url.pathname === '/ai/consensus') {
        const state = user.getState();
        sendJson(res, 200, { ok: true, consensus: state.aiConsensus || null });
      } else if (url.pathname === '/context/latest') {
        sendJson(res, 200, { ok: true, latestRendererContext: getRendererContext() });
      } else {
        sendJson(res, 404, { ok: false, error: 'Not found' });
      }
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  }

  function start() {
    if (server && info) return Promise.resolve(publicInfo());
    server = http.createServer(handle);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, host, () => {
        const address = server.address();
        info = {
          origin: `http://${host}:${address.port}`,
          token,
        };
        resolve(publicInfo());
      });
    });
  }

  function stop() {
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => {
        server = null;
        info = null;
        resolve();
      });
    });
  }

  return {
    start,
    stop,
    getInfo: publicInfo,
  };
}

module.exports = {
  createAiAppServer,
};
