const https = require('https');

const QUOTE_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
const CLIST_URL = 'https://push2.eastmoney.com/api/qt/clist/get';
const KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const SINA_CLIST_URL = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
const TENCENT_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const TENCENT_INTRADAY_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';
const QUOTE_FIELDS = 'f12,f13,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18,f8,f9,f20,f21,f23';
const KLINE_FIELDS1 = 'f1,f2,f3,f4,f5,f6';
const KLINE_FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
const A_SHARE_FS_HS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
const A_SHARE_FS_ALL = `${A_SHARE_FS_HS},m:0+t:81+s:2048`;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';

function toNumber(value) {
  if (value === undefined || value === null || value === '' || value === '-') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function normalizeCode(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim().toUpperCase();
  const suffix = text.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (suffix) return suffix[1];
  const prefix = text.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (prefix) return prefix[2];
  const digits = text.match(/\d{6}/);
  return digits ? digits[0] : '';
}

function inferMarket(code, eastmoneyMarket) {
  if (eastmoneyMarket === 1 || /^(60|68|90)/.test(code)) return 'SH';
  if (eastmoneyMarket === 0 || /^(00|30|20)/.test(code)) return 'SZ';
  if (eastmoneyMarket === 2 || /^(43|83|87|92)/.test(code)) return 'BJ';
  return '';
}

function secidForCode(code, market) {
  const normalized = normalizeCode(code);
  const m = market || inferMarket(normalized);
  if (m === 'SH') return `1.${normalized}`;
  if (m === 'BJ') return `2.${normalized}`;
  return `0.${normalized}`;
}

function tencentSymbolForCode(code, market) {
  const normalized = normalizeCode(code);
  const m = market || inferMarket(normalized);
  if (m === 'SH') return `sh${normalized}`;
  if (m === 'BJ') return `bj${normalized}`;
  return `sz${normalized}`;
}

function providerLabel(provider) {
  const labels = {
    eastmoney: '东方财富报价',
    'eastmoney-core-fallback': '东方财富核心池报价',
    'eastmoney-a-share': '东方财富全A报价',
    'eastmoney-kline': '东方财富日K',
    'sina-a-share': '新浪全A报价',
    'tencent-quote': '腾讯报价',
    'tencent-quote-core-fallback': '腾讯核心池报价',
    'tencent-kline': '腾讯日K',
    'tencent-intraday': '腾讯分时',
  };
  return labels[provider] || provider || '外部数据';
}

function parseTradeDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return Date.now();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

function parseTencentTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return Date.now();
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ).getTime();
}

function parseTencentIntradayTimestamp(value, dateText) {
  const time = String(value || '').trim();
  const date = String(dateText || '').trim();
  const timeMatch = time.match(/^(\d{2})(\d{2})$/);
  const dateMatch = date.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!timeMatch || !dateMatch) return Date.now();
  return new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0,
  ).getTime();
}

function requestJsonOnce(url, timeoutMs, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        Referer: 'https://quote.eastmoney.com/',
        'User-Agent': BROWSER_UA,
        ...(extraHeaders || {}),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Eastmoney HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Eastmoney JSON parse failed: ${err.message}`));
        }
      });
    });
    req.setTimeout(timeoutMs || 8000, () => {
      req.destroy(new Error('Eastmoney request timed out'));
    });
    req.on('error', reject);
  });
}

async function requestJson(url, timeoutMs, retries, extraHeaders) {
  const attempts = Number.isFinite(Number(retries)) ? Math.max(1, Number(retries)) : 3;
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await requestJsonOnce(url, timeoutMs, extraHeaders);
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200 + i * 300));
      }
    }
  }
  throw lastError;
}

function parseQuotePayload(payload, updatedAt) {
  const rows = payload && payload.data && Array.isArray(payload.data.diff) ? payload.data.diff : [];
  return rows.map((row) => {
    const code = normalizeCode(row.f12);
    if (!code) return null;
    const market = inferMarket(code, row.f13);
    const price = toNumber(row.f2);
    const preClose = toNumber(row.f18);
    const change = toNumber(row.f4);
    const changePercent = toNumber(row.f3);
    return {
      code,
      name: row.f14 || code,
      market,
      price,
      preClose,
      open: toNumber(row.f17),
      high: toNumber(row.f15),
      low: toNumber(row.f16),
      change,
      changePercent,
      volume: toNumber(row.f5),
      amount: toNumber(row.f6),
      turnoverRate: toNumber(row.f8),
      pe: toNumber(row.f9),
      marketCap: toNumber(row.f20),
      floatMarketCap: toNumber(row.f21),
      pb: toNumber(row.f23),
      updatedAt: updatedAt || Date.now(),
    };
  }).filter((quote) => quote && Number.isFinite(quote.price));
}

function parseKLinePayload(payload, code) {
  const data = payload && payload.data ? payload.data : {};
  const normalized = normalizeCode(code || data.code);
  const rows = Array.isArray(data.klines) ? data.klines : [];
  return rows.map((line) => {
    const cells = String(line).split(',');
    return {
      code: normalized,
      period: '1d',
      timestamp: parseTradeDate(cells[0]),
      open: toNumber(cells[1]) || 0,
      close: toNumber(cells[2]) || 0,
      high: toNumber(cells[3]) || 0,
      low: toNumber(cells[4]) || 0,
      volume: toNumber(cells[5]) || 0,
      amount: toNumber(cells[6]) || 0,
      adjust: 'qfq',
    };
  }).filter((kline) => kline.code && kline.open && kline.high && kline.low && kline.close);
}

function parseTencentQuotePayload(payload, code, market, updatedAt) {
  const data = payload && payload.data ? payload.data : {};
  const symbol = tencentSymbolForCode(code, market);
  const bucket = data[symbol] || data[Object.keys(data)[0]] || {};
  const qt = bucket.qt || {};
  const cells = qt[symbol] || qt[Object.keys(qt)[0]] || [];
  const normalized = normalizeCode(code || cells[2]);
  if (!normalized || !cells.length) return null;
  const packed = String(cells[35] || '').split('/');
  const packedAmount = toNumber(packed[2]);
  const amountWan = toNumber(cells[57] || cells[37]);
  const marketCapYi = toNumber(cells[44]);
  const floatMarketCapYi = toNumber(cells[45]);
  const hands = toNumber(cells[36] || cells[6]);
  return {
    code: normalized,
    name: cells[1] || normalized,
    market: inferMarket(normalized),
    price: toNumber(cells[3]),
    preClose: toNumber(cells[4]),
    open: toNumber(cells[5]),
    high: toNumber(cells[33] || cells[41]),
    low: toNumber(cells[34] || cells[42]),
    change: toNumber(cells[31]),
    changePercent: toNumber(cells[32]),
    volume: hands == null ? undefined : Math.round(hands * 100),
    amount: packedAmount != null ? packedAmount : (amountWan == null ? undefined : Math.round(amountWan * 10000)),
    turnoverRate: toNumber(cells[38]),
    pe: toNumber(cells[52] || cells[39]),
    marketCap: marketCapYi == null ? undefined : Math.round(marketCapYi * 1e8),
    floatMarketCap: floatMarketCapYi == null ? undefined : Math.round(floatMarketCapYi * 1e8),
    pb: toNumber(cells[46]),
    updatedAt: updatedAt || parseTencentTime(cells[30]),
  };
}

function parseTencentKLinePayload(payload, code, market) {
  const data = payload && payload.data ? payload.data : {};
  const symbol = tencentSymbolForCode(code, market);
  const bucket = data[symbol] || data[Object.keys(data)[0]] || {};
  const rows = bucket.qfqday || bucket.day || bucket.hfqday || [];
  const normalized = normalizeCode(code || (bucket.qt && bucket.qt[2]));
  return rows.map((row) => {
    const cells = Array.isArray(row) ? row : [];
    const open = toNumber(cells[1]) || 0;
    const close = toNumber(cells[2]) || 0;
    const high = toNumber(cells[3]) || 0;
    const low = toNumber(cells[4]) || 0;
    const hands = toNumber(cells[5]) || 0;
    const volume = Math.round(hands * 100);
    return {
      code: normalized,
      period: '1d',
      timestamp: parseTradeDate(cells[0]),
      open,
      close,
      high,
      low,
      volume,
      amount: Math.round(volume * (open + close) / 2),
      adjust: bucket.qfqday ? 'qfq' : 'none',
    };
  }).filter((kline) => kline.code && kline.open && kline.high && kline.low && kline.close);
}

function parseTencentIntradayPayload(payload, code, market, quote) {
  const data = payload && payload.data ? payload.data : {};
  const symbol = tencentSymbolForCode(code, market);
  const bucket = data[symbol] || data[Object.keys(data)[0]] || {};
  const rows = bucket.data && Array.isArray(bucket.data.data) ? bucket.data.data : [];
  const qt = bucket.qt || {};
  const cells = qt[symbol] || qt[Object.keys(qt)[0]] || [];
  const normalized = normalizeCode(code || cells[2]);
  const updateDateText = String(cells[30] || '');
  const preClose = toNumber(quote && quote.preClose) || toNumber(cells[4]) || toNumber(cells[5]) || toNumber(cells[3]);
  let prevHands = 0;
  let prevAmount = 0;
  const points = rows.map((line) => {
    const parts = String(line || '').trim().split(/\s+/);
    if (parts.length < 3) return null;
    const price = toNumber(parts[1]);
    const cumulativeHands = toNumber(parts[2]);
    const cumulativeAmount = toNumber(parts[3]);
    if (!normalized || price == null || cumulativeHands == null) return null;
    const volume = Math.max(0, Math.round((cumulativeHands - prevHands) * 100));
    const amount = cumulativeAmount == null ? undefined : Math.max(0, Math.round(cumulativeAmount - prevAmount));
    prevHands = cumulativeHands;
    if (cumulativeAmount != null) prevAmount = cumulativeAmount;
    const cumulativeShares = cumulativeHands * 100;
    const avg = cumulativeAmount != null && cumulativeShares > 0 ? cumulativeAmount / cumulativeShares : price;
    return {
      code: normalized,
      period: '1m',
      timestamp: parseTencentIntradayTimestamp(parts[0], updateDateText),
      timeLabel: `${parts[0].slice(0, 2)}:${parts[0].slice(2, 4)}`,
      price,
      avg,
      preClose: preClose || price,
      high: price,
      low: price,
      volume,
      amount,
      source: 'tencent-intraday',
    };
  }).filter(Boolean);
  points.provider = 'tencent-intraday';
  return points;
}

function uniqCodes(codes) {
  const seen = new Set();
  const out = [];
  (codes || []).forEach((code) => {
    const normalized = normalizeCode(code);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  });
  return out;
}

function queryString(params) {
  return Object.keys(params).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`).join('&');
}

async function fetchEastmoneyQuotes(codes, options) {
  const timeoutMs = options && options.timeoutMs;
  const batchSize = options && options.batchSize ? options.batchSize : 80;
  const normalized = uniqCodes(codes);
  const quotes = [];
  for (let i = 0; i < normalized.length; i += batchSize) {
    const batch = normalized.slice(i, i + batchSize);
    const secids = batch.map((code) => secidForCode(code)).join(',');
    const url = `${QUOTE_URL}?${queryString({ fltt: 2, invt: 2, fields: QUOTE_FIELDS, secids })}`;
    const payload = await requestJson(url, timeoutMs);
    quotes.push(...parseQuotePayload(payload, Date.now()));
  }
  quotes.provider = 'eastmoney';
  return quotes;
}

async function fetchTencentQuotes(codes, options) {
  const opts = options || {};
  const normalized = uniqCodes(codes);
  const rows = await mapLimit(normalized, opts.concurrency || 5, async (code) => {
    try {
      const symbol = tencentSymbolForCode(code);
      const url = `${TENCENT_KLINE_URL}?${queryString({ param: `${symbol},day,,,1,qfq` })}`;
      const payload = await requestJson(url, opts.timeoutMs);
      return parseTencentQuotePayload(payload, code, undefined, Date.now());
    } catch (err) {
      return null;
    }
  });
  const quotes = rows.filter((quote) => quote && Number.isFinite(quote.price));
  quotes.provider = 'tencent-quote';
  return quotes;
}

async function fetchQuotes(codes, options) {
  const opts = options || {};
  try {
    const quotes = await fetchEastmoneyQuotes(codes, opts);
    if (quotes.length) return quotes;
  } catch (err) {
    if (opts.disableQuoteFallback) throw err;
  }
  const fallback = await fetchTencentQuotes(codes, opts);
  if (!fallback.length) throw new Error('未获取到实时行情');
  return fallback;
}

function parseSinaQuoteRows(rows, updatedAt) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const code = normalizeCode(row.code || row.symbol);
    if (!code) return null;
    const symbol = String(row.symbol || '').toLowerCase();
    const market = symbol.startsWith('sh') ? 'SH' : (symbol.startsWith('bj') ? 'BJ' : (symbol.startsWith('sz') ? 'SZ' : inferMarket(code)));
    return {
      code,
      name: row.name || code,
      market,
      price: toNumber(row.trade),
      preClose: toNumber(row.settlement),
      open: toNumber(row.open),
      high: toNumber(row.high),
      low: toNumber(row.low),
      change: toNumber(row.pricechange),
      changePercent: toNumber(row.changepercent),
      volume: toNumber(row.volume),
      amount: toNumber(row.amount),
      turnoverRate: toNumber(row.turnoverratio),
      pe: toNumber(row.per),
      marketCap: toNumber(row.mktcap) == null ? undefined : Math.round(toNumber(row.mktcap) * 10000),
      floatMarketCap: toNumber(row.nmc) == null ? undefined : Math.round(toNumber(row.nmc) * 10000),
      pb: toNumber(row.pb),
      updatedAt: updatedAt || Date.now(),
    };
  }).filter((quote) => quote && Number.isFinite(quote.price));
}

async function fetchEastmoneyAShareQuotes(options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs;
  const limit = opts.limit != null ? opts.limit : (opts.quoteLimit != null ? opts.quoteLimit : 6000);
  const includeBeijing = opts.includeBeijing === true;
  const pageSize = Math.min(Math.max(1, opts.pageSize || 500), 5000);
  const quotes = [];
  const seen = new Set();
  let total = Infinity;
  let page = 1;
  while (quotes.length < limit && quotes.length < total) {
    const url = `${CLIST_URL}?${queryString({
      pn: page,
      pz: pageSize,
      po: 1,
      np: 1,
      fltt: 2,
      invt: 2,
      fs: includeBeijing ? A_SHARE_FS_ALL : A_SHARE_FS_HS,
      fields: QUOTE_FIELDS,
    })}`;
    let payload;
    try {
      payload = await requestJson(url, timeoutMs);
    } catch (err) {
      if (quotes.length) break;
      throw err;
    }
    total = payload && payload.data && Number.isFinite(Number(payload.data.total)) ? Number(payload.data.total) : total;
    const parsed = parseQuotePayload(payload, Date.now());
    if (!parsed.length) break;
    parsed.forEach((quote) => {
      if (!quote || seen.has(quote.code)) return;
      seen.add(quote.code);
      quotes.push(quote);
    });
    page++;
  }
  const scoped = includeBeijing ? quotes : quotes.filter((quote) => quote.market !== 'BJ');
  const sliced = scoped.slice(0, limit);
  sliced.provider = 'eastmoney-a-share';
  return sliced;
}

async function fetchSinaAShareQuotes(options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs;
  const limit = opts.limit != null ? opts.limit : (opts.quoteLimit != null ? opts.quoteLimit : 6000);
  const includeBeijing = opts.includeBeijing === true;
  const pageSize = Math.min(Math.max(1, opts.pageSize || 100), 100);
  const concurrency = Math.min(Math.max(1, opts.pageConcurrency || opts.concurrency || 6), 12);
  const startPage = Math.max(1, Number(opts.aShareStartPage || opts.startPage || 1) || 1);
  const pageCount = opts.aSharePageCount != null || opts.pageCount != null
    ? Math.max(1, Number(opts.aSharePageCount || opts.pageCount) || 1)
    : Infinity;
  const quotes = [];
  const seen = new Set();
  let page = startPage;
  let loadedPages = 0;
  async function fetchPage(pageNo) {
    const url = `${SINA_CLIST_URL}?${queryString({
      page: pageNo,
      num: pageSize,
      sort: 'symbol',
      asc: 1,
      node: 'hs_a',
      symbol: '',
      _s_r_a: 'page',
      _: Date.now(),
    })}`;
    const rows = await requestJson(url, timeoutMs, 2, { Referer: 'https://finance.sina.com.cn/' });
    return parseSinaQuoteRows(rows, Date.now());
  }
  while (quotes.length < limit && loadedPages < pageCount) {
    const pages = [];
    for (let i = 0; i < concurrency && quotes.length + i * pageSize < limit && loadedPages + i < pageCount; i += 1) pages.push(page + i);
    const batches = await Promise.all(pages.map(async (pageNo) => {
      try {
        return { page: pageNo, rows: await fetchPage(pageNo) };
      } catch (err) {
        if (!quotes.length && pageNo === 1) throw err;
        return { page: pageNo, rows: [] };
      }
    }));
    let stop = false;
    batches.sort((a, b) => a.page - b.page).forEach((batch) => {
      if (stop || quotes.length >= limit) return;
      const parsed = batch.rows || [];
      if (!parsed.length) {
        stop = true;
        return;
      }
      parsed.forEach((quote) => {
        if (!quote || seen.has(quote.code) || quotes.length >= limit) return;
        seen.add(quote.code);
        quotes.push(quote);
      });
      if (parsed.length < pageSize) stop = true;
    });
    if (stop) break;
    loadedPages += pages.length;
    page += pages.length;
  }
  const scoped = includeBeijing ? quotes : quotes.filter((quote) => quote.market !== 'BJ');
  const sliced = scoped.slice(0, limit);
  sliced.provider = 'sina-a-share';
  return sliced;
}

async function fetchAShareQuotes(options) {
  const opts = options || {};
  if (!opts.aShareStartPage && !opts.startPage) {
    try {
      const quotes = await fetchEastmoneyAShareQuotes(opts);
      if (quotes.length) return quotes;
    } catch (err) {
      if (opts.disableAShareFallback) throw err;
    }
  }
  const requestedLimit = opts.limit != null ? opts.limit : (opts.quoteLimit != null ? opts.quoteLimit : 6000);
  const fallbackLimit = opts.aShareFallbackQuoteLimit != null
    ? Math.max(1, Math.min(Number(opts.aShareFallbackQuoteLimit) || requestedLimit, requestedLimit))
    : requestedLimit;
  const fallback = await fetchSinaAShareQuotes({ ...opts, limit: fallbackLimit, quoteLimit: fallbackLimit });
  if (!fallback.length) throw new Error('未获取到全A行情');
  return fallback;
}

async function fetchEastmoneyKLines(code, options) {
  const timeoutMs = options && options.timeoutMs;
  const limit = options && options.limit ? options.limit : 250;
  const url = `${KLINE_URL}?${queryString({
    secid: secidForCode(code),
    ut: 'fa5fd1943c7b386f172d6893dbfba10b',
    fields1: KLINE_FIELDS1,
    fields2: KLINE_FIELDS2,
    klt: 101,
    fqt: 1,
    beg: 0,
    end: 20500101,
    lmt: limit,
  })}`;
  const payload = await requestJson(url, timeoutMs);
  const rows = parseKLinePayload(payload, code);
  rows.provider = 'eastmoney-kline';
  return rows;
}

async function fetchTencentKLines(code, options) {
  const opts = options || {};
  const symbol = tencentSymbolForCode(code, opts.market);
  const limit = opts.limit || 250;
  const url = `${TENCENT_KLINE_URL}?${queryString({ param: `${symbol},day,,,${limit},qfq` })}`;
  const payload = await requestJson(url, opts.timeoutMs);
  const rows = parseTencentKLinePayload(payload, code, opts.market);
  rows.provider = 'tencent-kline';
  return rows;
}

async function fetchKLines(code, options) {
  const opts = options || {};
  try {
    const rows = await fetchEastmoneyKLines(code, opts);
    if (rows.length) return rows;
  } catch (err) {
    if (opts.disableKlineFallback) throw err;
  }
  return fetchTencentKLines(code, opts);
}

async function fetchTencentIntraday(code, options) {
  const opts = options || {};
  const symbol = tencentSymbolForCode(code, opts.market);
  const url = `${TENCENT_INTRADAY_URL}?${queryString({ code: symbol })}`;
  const payload = await requestJson(url, opts.timeoutMs, 2, { Referer: 'https://gu.qq.com/' });
  const rows = parseTencentIntradayPayload(payload, code, opts.market, opts.quote);
  const limit = opts.points || opts.limit;
  const sliced = limit ? rows.slice(-Math.max(1, Number(limit) || rows.length)) : rows;
  sliced.provider = rows.provider || 'tencent-intraday';
  return sliced;
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function baseByCode(snapshot) {
  const map = new Map();
  const stocks = snapshot && Array.isArray(snapshot.stocks) ? snapshot.stocks : [];
  stocks.forEach((stock) => {
    const code = normalizeCode(stock.code || (stock.quote && stock.quote.code));
    if (code) map.set(code, stock);
  });
  return map;
}

async function createEastmoneySnapshot(options) {
  const opts = options || {};
  const now = Date.now();
  const baseMap = baseByCode(opts.baseSnapshot);
  const sourceCodes = opts.codes && opts.codes.length ? opts.codes : Array.from(baseMap.keys());
  const priorityQuoteCodes = uniqCodes(opts.priorityQuoteCodes || opts.priorityCodes || []);
  const prioritizedSourceCodes = uniqCodes(priorityQuoteCodes.concat(sourceCodes));
  const quoteLimit = opts.quoteLimit != null ? opts.quoteLimit : (opts.universe === 'a-share' ? 6000 : 80);
  const klineCodeLimit = opts.klineCodeLimit != null ? opts.klineCodeLimit : 30;
  const klineLimit = opts.klineLimit != null ? opts.klineLimit : 250;
  let codes = prioritizedSourceCodes.slice(0, quoteLimit);
  if (!codes.length && opts.universe !== 'a-share') throw new Error('没有可刷新的股票代码');

  let quotes;
  if (opts.universe === 'a-share') {
    try {
      quotes = await fetchAShareQuotes({ ...opts, limit: quoteLimit });
    } catch (err) {
      if (!sourceCodes.length) throw err;
      quotes = await fetchQuotes(sourceCodes.slice(0, Math.min(sourceCodes.length, opts.fallbackQuoteLimit || 80)), opts);
      quotes.provider = `${quotes.provider || 'network'}-core-fallback`;
    }
  } else {
    quotes = await fetchQuotes(codes, opts);
  }
  if (!quotes.length) throw new Error('未获取到实时行情');
  if (opts.universe === 'a-share') codes = quotes.map((quote) => quote.code);

  const quoteByCode = new Map(quotes.map((quote) => [quote.code, quote]));
  const priorityKlineCodes = uniqCodes((opts.priorityKlineCodes || opts.klineCodes || []).concat(sourceCodes));
  const klineCodes = uniqCodes(priorityKlineCodes.concat(codes)).slice(0, klineCodeLimit);
  const klinePairs = await mapLimit(klineCodes, opts.concurrency || 5, async (code) => {
    try {
      return [code, await fetchKLines(code, { timeoutMs: opts.timeoutMs, limit: klineLimit })];
    } catch (err) {
      return [code, null];
    }
  });
  const klineByCode = new Map(klinePairs.filter((pair) => Array.isArray(pair[1]) && pair[1].length));
  const klineProviders = new Set(klinePairs.map((pair) => pair && pair[1] && pair[1].provider).filter(Boolean));
  const quoteProvider = quotes.provider || (opts.universe === 'a-share' ? 'eastmoney-a-share' : 'eastmoney');
  const provider = klineProviders.has('tencent-kline') ? `${quoteProvider}+tencent-kline` : quoteProvider;
  const outputCodes = uniqCodes(codes.concat(Array.from(baseMap.keys())));

  const stocks = outputCodes.map((code) => {
    const base = baseMap.get(code) || {};
    const quote = quoteByCode.get(code) || base.quote || {};
    const klines = klineByCode.get(code) || base.klines || [];
    return {
      code,
      name: quote.name || base.name || code,
      market: quote.market || base.market || inferMarket(code),
      industry: base.industry || '',
      quote,
      klines,
    };
  });
  const retainedNote = stocks.length > quotes.length ? `，保留${stocks.length}只` : '';

  return {
    source: 'network',
    provider,
    connected: true,
    updatedAt: now,
    note: `外部延迟行情：更新${quotes.length}只${providerLabel(quoteProvider)}${retainedNote}，${klineByCode.size}只日K${klineProviders.size ? `（${Array.from(klineProviders).map(providerLabel).join(', ')}）` : ''}`,
    stocks,
  };
}

module.exports = {
  createEastmoneySnapshot,
  fetchQuotes,
  fetchEastmoneyQuotes,
  fetchTencentQuotes,
  fetchAShareQuotes,
  fetchEastmoneyAShareQuotes,
  fetchSinaAShareQuotes,
  fetchKLines,
  fetchEastmoneyKLines,
  fetchTencentKLines,
  fetchTencentIntraday,
  normalizeCode,
  parseQuotePayload,
  parseKLinePayload,
  parseTencentQuotePayload,
  parseSinaQuoteRows,
  parseTencentKLinePayload,
  parseTencentIntradayPayload,
  parseTencentIntradayTimestamp,
  secidForCode,
  tencentSymbolForCode,
  parseTencentTime,
  providerLabel,
};
