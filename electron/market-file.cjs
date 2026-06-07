const fs = require('fs');
const path = require('path');

const CODE_KEYS = ['code', '代码', '证券代码', 'ts_code', 'symbol'];
const NAME_KEYS = ['name', '名称', '证券简称', 'stock_name'];
const MARKET_KEYS = ['market', '市场', 'exchange'];
const INDUSTRY_KEYS = ['industry', '行业'];
const PERIOD_KEYS = ['period', '周期', 'freq', 'frequency'];
const TIME_KEYS = ['timestamp', 'time', 'datetime', 'date', '日期', '交易日期', 'trade_date'];

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      inQuote = !inQuote;
    } else if ((ch === ',' || ch === '\t') && !inQuote) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function pick(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  const lower = Object.create(null);
  Object.keys(row).forEach((key) => {
    lower[String(key).trim().toLowerCase()] = row[key];
  });
  for (const key of keys) {
    const value = lower[String(key).trim().toLowerCase()];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = String(value).trim().replace(/,/g, '').replace(/%$/, '');
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

function normalizeCode(value) {
  if (value === undefined || value === null) return '';
  let code = String(value).trim().toUpperCase();
  const suffix = code.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (suffix) return suffix[1];
  const prefix = code.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (prefix) return prefix[2];
  const blk = code.match(/^[012](\d{6})$/);
  if (blk) return blk[1];
  const digits = code.match(/\d{6}/);
  return digits ? digits[0] : '';
}

function inferMarket(value, code) {
  const explicit = value ? String(value).trim().toUpperCase() : '';
  if (explicit === 'SH' || explicit === 'SZ' || explicit === 'BJ') return explicit;
  if (!code) return explicit;
  if (/^(60|68|90)/.test(code)) return 'SH';
  if (/^(00|30|20)/.test(code)) return 'SZ';
  if (/^(43|83|87|92)/.test(code)) return 'BJ';
  return explicit;
}

function parseTimestamp(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback || Date.now();
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    if (value >= 10000101 && value <= 99991231) return parseYmd(String(value));
  }
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) return parseYmd(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : (fallback || Date.now());
}

function parseYmd(text) {
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6)) - 1;
  const day = Number(text.slice(6, 8));
  return new Date(year, month, day).getTime();
}

function normalizePeriod(value) {
  const raw = String(value || '1d').trim().toLowerCase();
  if (!raw || raw === 'd' || raw === 'day' || raw === 'daily' || raw === '日' || raw === '日线') return '1d';
  if (raw === 'w' || raw === 'week' || raw === 'weekly' || raw === '周' || raw === '周线') return '1w';
  if (raw === 'm' || raw === 'month' || raw === 'monthly' || raw === '月' || raw === '月线') return '1m';
  if (/^\d+(m|min|分钟)$/.test(raw)) return raw.replace('min', 'm').replace('分钟', 'm');
  return raw;
}

function parseCsvRows(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error('行情文件为空');
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

function parseKLine(row, code, fallbackTimestamp) {
  const open = toNumber(pick(row, ['open', '开盘', '今开', 'O', 'OPEN']));
  const high = toNumber(pick(row, ['high', '最高', 'H', 'HIGH']));
  const low = toNumber(pick(row, ['low', '最低', 'L', 'LOW']));
  const close = toNumber(pick(row, ['close', '收盘', '收盘价', 'C', 'CLOSE']));
  if (![open, high, low, close].every(Number.isFinite)) return null;
  const timestamp = parseTimestamp(pick(row, TIME_KEYS), fallbackTimestamp);
  return {
    code,
    period: normalizePeriod(pick(row, PERIOD_KEYS)),
    timestamp,
    open,
    high,
    low,
    close,
    volume: toNumber(pick(row, ['volume', 'vol', '成交量', 'V', 'VOL'])) || 0,
    amount: toNumber(pick(row, ['amount', '成交额', 'AMOUNT', 'turnover'])) || 0,
    adjust: pick(row, ['adjust', '复权']) || 'none',
  };
}

function parseQuote(row, code, name, fallbackTimestamp) {
  const price = toNumber(pick(row, ['price', 'last', 'latest', '最新', '最新价', 'close', '收盘', '收盘价']));
  if (!Number.isFinite(price)) return null;
  return {
    code,
    name,
    price,
    preClose: toNumber(pick(row, ['preClose', 'pre_close', '昨收', '昨收价'])),
    open: toNumber(pick(row, ['open', '开盘', '今开'])),
    high: toNumber(pick(row, ['high', '最高'])),
    low: toNumber(pick(row, ['low', '最低'])),
    change: toNumber(pick(row, ['change', '涨跌', '涨跌额'])),
    changePercent: toNumber(pick(row, ['changePercent', 'pct_chg', '涨跌幅', '涨幅'])),
    volume: toNumber(pick(row, ['volume', 'vol', '成交量'])),
    amount: toNumber(pick(row, ['amount', '成交额'])),
    turnoverRate: toNumber(pick(row, ['turnoverRate', '换手率'])),
    marketCap: toNumber(pick(row, ['marketCap', 'totalMarketCap', '总市值', '市值'])),
    floatMarketCap: toNumber(pick(row, ['floatMarketCap', 'circulatingMarketCap', '流通市值'])),
    pe: toNumber(pick(row, ['pe', 'peRatio', '市盈率', 'PE'])),
    pb: toNumber(pick(row, ['pb', 'pbRatio', '市净率', 'PB'])),
    updatedAt: parseTimestamp(pick(row, TIME_KEYS), fallbackTimestamp),
  };
}

function quoteFromKLines(stock, existingQuote) {
  if (!stock.klines.length) return existingQuote || null;
  const last = stock.klines[stock.klines.length - 1];
  const prev = stock.klines.length > 1 ? stock.klines[stock.klines.length - 2] : null;
  const preClose = existingQuote && Number.isFinite(existingQuote.preClose)
    ? existingQuote.preClose
    : (prev ? prev.close : last.open);
  const change = Number.isFinite(last.close) && Number.isFinite(preClose) ? last.close - preClose : undefined;
  return {
    ...(existingQuote || {}),
    code: stock.code,
    name: stock.name,
    price: last.close,
    preClose,
    open: last.open,
    high: last.high,
    low: last.low,
    change,
    changePercent: Number.isFinite(change) && preClose ? (change / preClose) * 100 : undefined,
    volume: last.volume,
    amount: last.amount,
    updatedAt: last.timestamp,
  };
}

function parseRows(rows, provider) {
  const now = Date.now();
  const byCode = new Map();

  rows.forEach((row) => {
    const code = normalizeCode(pick(row, CODE_KEYS));
    if (!code) return;
    const name = pick(row, NAME_KEYS) || code;
    const market = inferMarket(pick(row, MARKET_KEYS), code);
    const industry = pick(row, INDUSTRY_KEYS) || '';
    if (!byCode.has(code)) {
      byCode.set(code, { code, name, market, industry, klines: [] });
    }
    const stock = byCode.get(code);
    if (name && stock.name === stock.code) stock.name = name;
    if (market && !stock.market) stock.market = market;
    if (industry && !stock.industry) stock.industry = industry;

    const kline = parseKLine(row, code, now);
    if (kline) stock.klines.push(kline);

    const quote = parseQuote(row, code, stock.name, kline ? kline.timestamp : now);
    if (quote) stock.quote = quote;
  });

  const stocks = Array.from(byCode.values()).map((stock) => {
    stock.klines.sort((a, b) => a.timestamp - b.timestamp);
    stock.quote = quoteFromKLines(stock, stock.quote);
    return stock;
  });

  if (!stocks.length) throw new Error('未识别到行情记录');
  return {
    source: 'file',
    provider,
    connected: true,
    updatedAt: now,
    note: `从 ${provider} 导入`,
    stocks,
  };
}

function parseMarketText(text, provider) {
  const cleaned = String(text || '').replace(/^\uFEFF/, '');
  const trimmed = cleaned.trim();
  if (!trimmed) throw new Error('行情文件为空');
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parseRows(parsed, provider || 'json-array');
    return parsed;
  }
  return parseRows(parseCsvRows(cleaned), provider || 'csv');
}

function parseMarketFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseMarketText(text, path.basename(filePath));
}

module.exports = {
  parseCsvLine,
  parseMarketText,
  parseMarketFile,
  parseRows,
};
