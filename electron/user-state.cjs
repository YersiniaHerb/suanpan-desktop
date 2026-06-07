const fs = require('fs');
const path = require('path');

const DEFAULT_GROUPS = {
  '长线': [],
  '短线': [],
  '观察': [],
};

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(list) {
  const out = [];
  const seen = Object.create(null);
  (Array.isArray(list) ? list : []).forEach((item) => {
    const code = String(item || '').trim();
    if (!code || seen[code]) return;
    seen[code] = true;
    out.push(code);
  });
  return out;
}

function normalizeGroups(input) {
  const groups = clone(DEFAULT_GROUPS);
  if (!input || typeof input !== 'object') return groups;
  Object.keys(input).forEach((name) => {
    if (Array.isArray(input[name])) groups[name] = uniqueStrings(input[name]);
  });
  return groups;
}

function createDefaultState() {
  return {
    version: 1,
    watch: [],
    watchGroups: clone(DEFAULT_GROUPS),
    formulas: [],
    screeningStrategies: [],
    screeningResults: [],
    screeningHistory: [],
    tradePlans: [],
    aiHistory: [],
    aiConsensus: null,
    marketSort: { key: 'changePercent', dir: 'desc' },
    marketScope: 'hs',
    sideWidths: {},
  };
}

function normalizeMarketSort(input) {
  const allowed = {
    changePercent: true,
    amount: true,
    marketCap: true,
    turnoverRate: true,
    price: true,
    code: true,
  };
  const key = input && allowed[input.key] ? input.key : 'changePercent';
  const dir = input && input.dir === 'asc' ? 'asc' : 'desc';
  return { key, dir };
}

function normalizeMarketScope(input) {
  return input === 'all' ? 'all' : 'hs';
}

function normalizeState(raw) {
  const next = createDefaultState();
  if (!raw || typeof raw !== 'object') return next;
  if (Array.isArray(raw.watch)) next.watch = uniqueStrings(raw.watch);
  if (raw.watchGroups && typeof raw.watchGroups === 'object') next.watchGroups = normalizeGroups(raw.watchGroups);
  if (Array.isArray(raw.formulas)) next.formulas = clone(raw.formulas);
  if (Array.isArray(raw.screeningStrategies)) next.screeningStrategies = clone(raw.screeningStrategies);
  if (Array.isArray(raw.screeningResults)) next.screeningResults = clone(raw.screeningResults);
  if (Array.isArray(raw.screeningHistory)) next.screeningHistory = clone(raw.screeningHistory);
  if (Array.isArray(raw.tradePlans)) next.tradePlans = clone(raw.tradePlans);
  if (Array.isArray(raw.aiHistory)) next.aiHistory = clone(raw.aiHistory);
  if ('aiConsensus' in raw) next.aiConsensus = clone(raw.aiConsensus);
  if (raw.marketSort && typeof raw.marketSort === 'object') next.marketSort = normalizeMarketSort(raw.marketSort);
  if (raw.marketScope) next.marketScope = normalizeMarketScope(raw.marketScope);
  if (raw.sideWidths && typeof raw.sideWidths === 'object') next.sideWidths = clone(raw.sideWidths);
  next.version = Number(raw.version) || 1;
  return next;
}

function createStore(statePath) {
  if (!statePath) throw new Error('statePath is required');

  let state = null;

  function load() {
    try {
      if (fs.existsSync(statePath)) {
        state = normalizeState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
        return;
      }
    } catch (err) {}
    state = createDefaultState();
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {}
  }

  function ensure() {
    if (!state) load();
    return state;
  }

  function getState() {
    return clone(ensure());
  }

  function setState(nextState) {
    state = normalizeState(nextState);
    persist();
    return getState();
  }

  function patchState(patch) {
    const current = ensure();
    const next = Object.assign({}, current, patch || {});
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'watch')) next.watch = patch.watch;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'watchGroups')) next.watchGroups = patch.watchGroups;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'formulas')) next.formulas = patch.formulas;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'screeningStrategies')) next.screeningStrategies = patch.screeningStrategies;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'screeningResults')) next.screeningResults = patch.screeningResults;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'screeningHistory')) next.screeningHistory = patch.screeningHistory;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'tradePlans')) next.tradePlans = patch.tradePlans;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'aiHistory')) next.aiHistory = patch.aiHistory;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'aiConsensus')) next.aiConsensus = patch.aiConsensus;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'marketSort')) next.marketSort = patch.marketSort;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'marketScope')) next.marketScope = patch.marketScope;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'sideWidths')) next.sideWidths = patch.sideWidths;
    state = normalizeState(next);
    persist();
    return getState();
  }

  function resetState() {
    state = createDefaultState();
    persist();
    return getState();
  }

  function getStatus() {
    const current = ensure();
    return {
      version: current.version,
      watchCount: current.watch.length,
      formulaCount: current.formulas.length,
      screeningStrategyCount: current.screeningStrategies.length,
      screeningResultCount: current.screeningResults.length,
      screeningHistoryCount: current.screeningHistory.length,
      tradePlanCount: current.tradePlans.length,
      historyCount: current.aiHistory.length,
      hasConsensus: !!current.aiConsensus,
      marketSort: clone(current.marketSort),
      marketScope: current.marketScope,
      sideWidthCount: Object.keys(current.sideWidths || {}).length,
      path: statePath,
    };
  }

  load();

  return {
    getState,
    setState,
    patchState,
    resetState,
    getStatus,
    path: statePath,
  };
}

module.exports = {
  createStore,
  createDefaultState,
  normalizeState,
};
