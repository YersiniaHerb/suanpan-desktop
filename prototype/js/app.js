// CoStock 桌面端 - 交互主逻辑
(function () {
  'use strict';
  var D = window.CoStockData, F = window.CoStockFormula, CH = window.CoStockChart;
  var marketLoaded = false;
  var userStateLoaded = false;
  var userStateSyncTimer = null;
  var liveKLineRequests = {};
  var liveKLineReady = {};
  var liveIntradayRequests = {};
  var liveIntradayReady = {};
  var marketRefreshScheduler = null;
  var fullMarketRefreshPromise = null;
  var fullMarketChunksQueued = false;
  var autoMarketRefreshTimer = null;
  var lastMarketSyncAt = 0;
  var autoMarketShardCursor = 0;
  var autoMarketRefreshTick = 0;
  var defaultWatchGroups = { '长线': [], '短线': [], '观察': [] };
  var AUTO_MARKET_ACTIVE_MS = 3 * 1000;
  var AUTO_MARKET_NEAR_SESSION_MS = 60 * 1000;
  var AUTO_MARKET_CLOSED_MS = 10 * 60 * 1000;
  var AUTO_MARKET_SHARD_EVERY = 5;
  var AUTO_MARKET_SHARD_SIZE = 360;

  // ---------- 状态 ----------
  var state = {
    panel: 'market',
    currentCode: null,        // 行情详情当前股票
    watchCurrentCode: null,
    bars: 120,
    chartMode: 'kline',
    subIndicators: ['MACD'],  // 副图列表（可增减多个窗口），每项独立选指标
    mas: [5, 10, 20],         // 主图均线（可切换显隐）
    boll: false,
    cardOpen: true,
    aiOpen: true,
    listCollapsed: false,
    watch: load('costock.watch', []),                       // 扁平：所有自选代码（用于全局 ☆ 状态）
    watchGroups: load('costock.watchGroups', defaultWatchGroups), // 分组 -> 代码
	    watchGroup: '全部',                                       // 当前分组（'全部' 为虚拟分组=全部自选）
	    watchFilter: '',                                          // 自选搜索关键词
	    formulaGroup: '全部',                                     // 公式当前分组
	    formulaFilter: '',                                        // 公式搜索关键词
	    activeFormulaKey: 'builtin:0',
	    marketFilter: '',                                         // 行情列表搜索
    marketSort: normalizeMarketSort(load('costock.marketSort', null)),
    screenFilter: '',                                         // 选股结果搜索
    screenStrategyId: '',
    screeningStrategies: load('costock.screeningStrategies', []),
    tradePlans: load('costock.tradePlans', []),
    planFilter: '',
    currentPlanId: null,
    lastScreenResults: []                                     // 缓存上次选股结果用于过滤
  };

  function clone(val) { return val == null ? val : JSON.parse(JSON.stringify(val)); }
  function load(key, def) { try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? clone(def) : v; } catch (e) { return clone(def); } }
  function normalizeMarketSort(raw) {
    var allowed = { changePercent: 1, amount: 1, marketCap: 1, turnoverRate: 1, price: 1, code: 1 };
    var key = raw && allowed[raw.key] ? raw.key : 'changePercent';
    var dir = raw && raw.dir === 'asc' ? 'asc' : 'desc';
    return { key: key, dir: dir };
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
    scheduleUserStateSync(key);
  }
  function userBridge() {
    return window.costockBridge && window.costockBridge.user ? window.costockBridge.user : null;
  }
  function localUserStateSnapshot() {
    return {
      watch: state.watch.slice(),
      watchGroups: clone(state.watchGroups || defaultWatchGroups),
      formulas: load('costock.formulas', []),
      screeningStrategies: state.screeningStrategies.slice(),
      screeningResults: load('costock.screeningResults', []),
      screeningHistory: load('costock.screeningHistory', []),
      tradePlans: state.tradePlans.slice(),
      aiHistory: load('costock.aiHistory', []),
      aiConsensus: load('costock.aiConsensus', null),
      marketSort: normalizeMarketSort(state.marketSort),
      sideWidths: load('costock.sideWidths', {})
    };
  }
  function hasUserStateData(s) {
    if (!s || typeof s !== 'object') return false;
    if (Array.isArray(s.watch) && s.watch.length) return true;
    if (Array.isArray(s.formulas) && s.formulas.length) return true;
    if (Array.isArray(s.screeningStrategies) && s.screeningStrategies.length) return true;
    if (Array.isArray(s.screeningResults) && s.screeningResults.length) return true;
    if (Array.isArray(s.screeningHistory) && s.screeningHistory.length) return true;
    if (Array.isArray(s.tradePlans) && s.tradePlans.length) return true;
    if (Array.isArray(s.aiHistory) && s.aiHistory.length) return true;
    if (s.aiConsensus) return true;
    if (s.marketSort && (s.marketSort.key !== 'changePercent' || s.marketSort.dir !== 'desc')) return true;
    if (s.watchGroups && Object.keys(s.watchGroups).some(function (g) { return Array.isArray(s.watchGroups[g]) && s.watchGroups[g].length; })) return true;
    if (s.sideWidths && Object.keys(s.sideWidths).length) return true;
    return false;
  }
  function scheduleUserStateSync(key) {
    var bridge = userBridge();
    var setter = bridge && (bridge.setState || bridge.patchState);
    if (!setter) return;
    clearTimeout(userStateSyncTimer);
    userStateSyncTimer = setTimeout(function () {
      setter(localUserStateSnapshot()).catch(function () {});
    }, userStateLoaded ? 80 : 250);
  }
  function writeLocalUserState(userState) {
    if (!userState || typeof userState !== 'object') return;
    if (Array.isArray(userState.watch)) {
      state.watch = userState.watch.slice();
      try { localStorage.setItem('costock.watch', JSON.stringify(state.watch)); } catch (e) {}
    }
    if (userState.watchGroups && typeof userState.watchGroups === 'object') {
      state.watchGroups = Object.assign(clone(defaultWatchGroups), clone(userState.watchGroups));
      try { localStorage.setItem('costock.watchGroups', JSON.stringify(state.watchGroups)); } catch (e) {}
    }
    if (Array.isArray(userState.formulas)) {
      try { localStorage.setItem('costock.formulas', JSON.stringify(userState.formulas)); } catch (e) {}
    }
    if (Array.isArray(userState.screeningStrategies)) {
      state.screeningStrategies = userState.screeningStrategies.slice();
      try { localStorage.setItem('costock.screeningStrategies', JSON.stringify(state.screeningStrategies)); } catch (e) {}
    }
    if (Array.isArray(userState.screeningResults)) {
      try { localStorage.setItem('costock.screeningResults', JSON.stringify(userState.screeningResults)); } catch (e) {}
    }
    if (Array.isArray(userState.screeningHistory)) {
      try { localStorage.setItem('costock.screeningHistory', JSON.stringify(userState.screeningHistory)); } catch (e) {}
    }
    if (Array.isArray(userState.tradePlans)) {
      state.tradePlans = userState.tradePlans.slice();
      try { localStorage.setItem('costock.tradePlans', JSON.stringify(state.tradePlans)); } catch (e) {}
    }
    if (Array.isArray(userState.aiHistory)) {
      try { localStorage.setItem('costock.aiHistory', JSON.stringify(userState.aiHistory)); } catch (e) {}
    }
    if ('aiConsensus' in userState) {
      try { localStorage.setItem('costock.aiConsensus', JSON.stringify(userState.aiConsensus)); } catch (e) {}
    }
    if (userState.marketSort && typeof userState.marketSort === 'object') {
      state.marketSort = normalizeMarketSort(userState.marketSort);
      try { localStorage.setItem('costock.marketSort', JSON.stringify(state.marketSort)); } catch (e) {}
    }
    if (userState.sideWidths && typeof userState.sideWidths === 'object') {
      try { localStorage.setItem('costock.sideWidths', JSON.stringify(userState.sideWidths)); } catch (e) {}
    }
  }
  function syncUserState() {
    var bridge = userBridge();
    if (!bridge || !bridge.getState) {
      userStateLoaded = true;
      return Promise.resolve(null);
    }
    return bridge.getState().then(function (remoteState) {
      var localState = localUserStateSnapshot();
      if (!hasUserStateData(remoteState) && hasUserStateData(localState) && bridge.setState) {
        return bridge.setState(localState).then(function () {
          userStateLoaded = true;
          rerenderUserStateViews();
          return localState;
        });
      }
      writeLocalUserState(remoteState);
      userStateLoaded = true;
      rerenderUserStateViews();
      return remoteState;
    }).catch(function () {
      userStateLoaded = true;
      scheduleUserStateSync();
      return null;
    });
  }
  function rerenderUserStateViews() {
    applySavedSideWidths();
    syncMarketSortControls();
    renderMarketList();
    if (state.currentCode) renderDetail('#detailView', state.currentCode);
	    if (state.panel === 'watch') renderWatchList();
	    if (state.panel === 'formula') {
	      renderFormulaList();
	      updateFormulaEditorState();
	    }
	    if (state.panel === 'screener') renderScreenResults(state.lastScreenResults || []);
	    if (state.panel === 'plans') renderPlanList();
	    updateAiContext();
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    function p(n){ return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function formatDataMeta(status) {
    if (!status) return '';
    var parts = [];
    var provider = status.provider || status.source;
    if (provider) parts.push(provider);
    if (status.count != null) parts.push(status.count + ' 只');
    if (status.klineCount) parts.push(status.klineCount + ' 根K线');
    if (status.intradayCount) parts.push(status.intradayCount + ' 分时点');
    var t = fmtTime(status.updatedAt);
    if (t) parts.push(t);
    return parts.join(' · ');
  }
  function currentDataLabel() {
    var status = D.getStatus ? D.getStatus() : null;
    if (status && status.connected) return '真实/延迟数据';
    return '本地/缓存数据';
  }
  function setDataBadge(text, connected, status, options) {
    var el = $('#dataBadge');
    if (!el) return;
    var meta = $('#dataMeta');
    var opts = options || {};
    var loading = !!opts.loading;
    el.textContent = text;
    el.classList.toggle('loading', loading);
    el.classList.toggle('up', !loading && !!connected);
    el.classList.toggle('down', !loading && !connected);
    el.title = status ? (status.note || formatDataMeta(status) || text) : text;
    if (meta) {
      var info = formatDataMeta(status);
      meta.textContent = info;
      meta.title = info || '';
    }
  }

  // ---------- 工具 ----------
  function $(s, root) { return (root || document).querySelector(s); }
  function $all(s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); }
  function esc(v) {
    return String(v == null ? '-' : v).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }
  function cls(pct) { return pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat'); }
  function sign(pct) { return pct > 0 ? '+' : ''; }
  function fmtNum(v, digits) { return v == null || isNaN(Number(v)) ? '-' : Number(v).toFixed(digits == null ? 2 : digits); }
  function fmtSignedNum(v, digits) {
    if (v == null || isNaN(Number(v))) return '-';
    var n = Number(v);
    return sign(n) + n.toFixed(digits == null ? 2 : digits);
  }
  function fmtPct(v) {
    if (v == null || isNaN(Number(v))) return '-';
    var n = Number(v);
    return sign(n) + n.toFixed(2) + '%';
  }
  function fmtVol(v) {
    var n = Number(v);
    if (!isFinite(n)) return '-';
    return n >= 1e8 ? (n/1e8).toFixed(2)+'亿' : (n/1e4).toFixed(0)+'万';
  }
  function fmtAmt(v) {
    var n = Number(v);
    if (!isFinite(n)) return '-';
    return n >= 1e8 ? (n/1e8).toFixed(2)+'亿' : (n/1e4).toFixed(0)+'万';
  }
  function fmtCap(v) {
    if (v == null || isNaN(Number(v))) return '-';
    return v >= 1e12 ? (v / 1e12).toFixed(2) + '万亿' : (v / 1e8).toFixed(0) + '亿';
  }
  function fmtAmplitude(q) {
    var high = Number(q && q.high);
    var low = Number(q && q.low);
    var preClose = Number(q && q.preClose);
    if (!isFinite(high) || !isFinite(low) || !isFinite(preClose) || preClose === 0) return '-';
    return ((high - low) / preClose * 100).toFixed(2) + '%';
  }
  function numOr(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }
  function inWatch(code) { return state.watch.indexOf(code) >= 0; }
  function toggleWatch(code) {
    var i = state.watch.indexOf(code);
    if (i >= 0) {
      state.watch.splice(i, 1);
      // 同时从所有分组移除
      Object.keys(state.watchGroups).forEach(function (g) {
        var arr = state.watchGroups[g]; var k = arr.indexOf(code); if (k >= 0) arr.splice(k, 1);
      });
      toast('已移出自选');
    } else {
      state.watch.push(code);
      // 若当前在某个具体分组下添加，则归入该组
      if (state.watchGroup !== '全部' && state.watchGroups[state.watchGroup]) {
        state.watchGroups[state.watchGroup].push(code);
      }
      toast('已加入自选 ★');
    }
    save('costock.watch', state.watch);
    save('costock.watchGroups', state.watchGroups);
    renderWatchList();
  }
  // 把股票加入/移出某个分组
  function setStockGroup(code, group) {
    var arr = state.watchGroups[group]; if (!arr) return;
    var i = arr.indexOf(code);
    if (i >= 0) { arr.splice(i, 1); }
    else { arr.push(code); if (!inWatch(code)) { state.watch.push(code); save('costock.watch', state.watch); } }
    save('costock.watchGroups', state.watchGroups);
    renderWatchList();
  }
  var toastTimer;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1600);
  }

  var textPromptResolve = null;
  function closeTextPrompt(value) {
    var mask = $('#promptMask');
    if (mask) mask.classList.remove('show');
    var modal = mask && $('.prompt-modal', mask);
    if (modal) modal.classList.remove('confirm');
    if (!textPromptResolve) return;
    var resolve = textPromptResolve;
    textPromptResolve = null;
    resolve(value);
  }
  function askText(options) {
    var opts = options || {};
    return new Promise(function (resolve) {
      var mask = $('#promptMask');
      var modal = $('.prompt-modal', mask);
      var title = $('#promptTitle');
      var message = $('#promptMessage');
      var label = $('#promptLabel');
      var input = $('#promptInput');
      if (!mask || !title || !message || !label || !input) {
        resolve(null);
        return;
      }
      if (textPromptResolve) closeTextPrompt(null);
      textPromptResolve = resolve;
      if (modal) modal.classList.remove('confirm');
      title.textContent = opts.title || '输入名称';
      label.textContent = opts.label || '名称';
      message.textContent = opts.message || '';
      message.classList.toggle('hidden', !opts.message);
      $('#promptOk').textContent = opts.okLabel || '确认';
      $('#promptCancel').textContent = opts.cancelLabel || '取消';
      input.value = opts.value || '';
      input.placeholder = opts.placeholder || '';
      mask.classList.add('show');
      setTimeout(function () {
        input.focus();
        input.select();
      }, 40);
    });
  }
  function askConfirm(options) {
    var opts = options || {};
    return new Promise(function (resolve) {
      var mask = $('#promptMask');
      var modal = mask && $('.prompt-modal', mask);
      var title = $('#promptTitle');
      var message = $('#promptMessage');
      var label = $('#promptLabel');
      var input = $('#promptInput');
      var ok = $('#promptOk');
      var cancel = $('#promptCancel');
      if (!mask || !title || !message || !label || !input || !ok || !cancel) {
        resolve(false);
        return;
      }
      if (textPromptResolve) closeTextPrompt(null);
      textPromptResolve = function (value) { resolve(value === true); };
      if (modal) modal.classList.add('confirm');
      title.textContent = opts.title || '确认操作';
      message.textContent = opts.message || '';
      message.classList.toggle('hidden', !opts.message);
      ok.textContent = opts.okLabel || '确认';
      cancel.textContent = opts.cancelLabel || '取消';
      input.value = '';
      input.placeholder = '';
      mask.classList.add('show');
      setTimeout(function () { ok.focus(); }, 40);
    });
  }
  function setupTextPromptModal() {
    var mask = $('#promptMask');
    var input = $('#promptInput');
    var ok = $('#promptOk');
    var cancel = $('#promptCancel');
    var close = $('#promptClose');
    if (!mask || !input || !ok || !cancel || !close) return;
    ok.onclick = function () { closeTextPrompt(mask.querySelector('.prompt-modal.confirm') ? true : input.value); };
    cancel.onclick = function () { closeTextPrompt(null); };
    close.onclick = function () { closeTextPrompt(null); };
    mask.onclick = function (e) {
      if (e.target === mask) closeTextPrompt(null);
    };
    mask.onkeydown = function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        closeTextPrompt(mask.querySelector('.prompt-modal.confirm') ? true : input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeTextPrompt(null);
      }
    };
    input.onkeydown = function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        closeTextPrompt(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeTextPrompt(null);
      }
    };
  }

  // ---------- 板块切换 ----------
  function switchPanel(name) {
    state.panel = name;
    $all('.panel').forEach(function (p) { p.classList.toggle('hidden', p.dataset.panel !== name); });
    $all('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    if (name === 'watch') renderWatchList();
    if (name === 'market' && state.currentCode) renderDetail('#detailView', state.currentCode);
    if (name === 'plans') renderPlanList();
    updateAiContext();
  }

  // ---------- 行情列表 ----------
  function renderMarketList() {
    var ul = $('#marketList');
    var quotes = D.listStocks();
    var kw = (state.marketFilter || '').trim().toLowerCase();
    if (kw) quotes = quotes.filter(function (q) { return q.code.indexOf(kw) >= 0 || q.name.toLowerCase().indexOf(kw) >= 0; });
    quotes = sortMarketQuotes(quotes);
    ul.innerHTML = quotes.map(function (q) { return quoteRow(q, state.currentCode); }).join('');
    var total = D.listStocks().length;
    $('#marketCount').textContent = quotes.length + ' / ' + total + ' 只';
    $all('li', ul).forEach(function (li) {
      li.onclick = function () { showDetail(li.dataset.code); };
    });
  }
  function sortMarketQuotes(quotes) {
    var sort = normalizeMarketSort(state.marketSort);
    state.marketSort = sort;
    var key = sort.key || 'changePercent';
    var dir = sort.dir === 'asc' ? 1 : -1;
    return quotes.slice().sort(function (a, b) {
      var av = key === 'code' ? String(a.code || '') : numOr(a[key], null);
      var bv = key === 'code' ? String(b.code || '') : numOr(b[key], null);
      if (av == null && bv == null) return String(a.code).localeCompare(String(b.code));
      if (av == null) return 1;
      if (bv == null) return -1;
      if (key === 'code') return String(av).localeCompare(String(bv)) * dir;
      if (av === bv) return String(a.code).localeCompare(String(b.code));
      return av > bv ? dir : -dir;
    });
  }
  function syncMarketSortControls() {
    var sortSelect = $('#marketSort');
    var sortDir = $('#marketSortDir');
    var sort = normalizeMarketSort(state.marketSort);
    state.marketSort = sort;
    if (sortSelect) sortSelect.value = sort.key || 'changePercent';
    if (sortDir) {
      sortDir.textContent = sort.dir === 'asc' ? '↑' : '↓';
      sortDir.title = sort.dir === 'asc' ? '升序' : '降序';
    }
  }
  function marketSubLine(q) {
    var parts = [q.code];
    if (q.amount != null) parts.push('额 ' + fmtAmt(q.amount));
    if (q.marketCap != null) parts.push('值 ' + fmtCap(q.marketCap));
    return parts.join(' · ');
  }
  function quoteRow(q, activeCode) {
    var c = cls(q.changePercent);
    return '<li data-code="' + q.code + '" class="' + (q.code === activeCode ? 'active' : '') + '">' +
      '<span class="s-name-wrap"><span class="s-name">' + q.name + '</span><span class="s-code-sm">' + marketSubLine(q) + '</span></span>' +
      '<span class="s-price ' + c + '">' + fmtNum(q.price) + '</span>' +
      '<span class="s-chg ' + c + '">' + fmtPct(q.changePercent) + '</span>' +
      '</li>';
  }

  // ---------- 个股详情 ----------
  function showDetail(code) {
    state.currentCode = code;
    $all('#marketList li').forEach(function (li) { li.classList.toggle('active', li.dataset.code === code); });
    renderDetail('#detailView', code);
  }
  function renderDetail(container, code) {
    var stock = D.getStock(code);
    if (!stock) { $(container).innerHTML = '<div class="empty-tip">未找到该股票</div>'; return; }
    var q = stock.quote;
    var c = cls(q.changePercent);
    var starOn = inWatch(code) ? 'on' : '';
    var html =
      '<div class="detail-header">' +
        '<div class="dh-top">' +
          '<span class="dh-name">' + q.name + '</span>' +
          '<span class="dh-code">' + code + ' · ' + stock.market + ' · ' + stock.industry + '</span>' +
          '<span class="dh-star ' + starOn + '" data-star="' + code + '" title="加入自选">' + (inWatch(code) ? '★' : '☆') + '</span>' +
        '</div>' +
        '<div class="dh-price-row">' +
          '<span class="dh-price ' + c + '">' + fmtNum(q.price) + '</span>' +
          '<span class="dh-chg ' + c + '">' + fmtSignedNum(q.change) + '  ' + fmtPct(q.changePercent) + '</span>' +
        '</div>' +
        '<div class="dh-stats">' +
          stat('今开', fmtNum(q.open), cls((Number(q.open) || 0) - (Number(q.preClose) || 0))) +
          stat('最高', fmtNum(q.high), 'up') +
          stat('最低', fmtNum(q.low), 'down') +
          stat('昨收', fmtNum(q.preClose), '') +
          stat('成交量', fmtVol(q.volume), '') +
          stat('成交额', fmtAmt(q.amount), '') +
          stat('换手率', fmtNum(q.turnoverRate) + '%', '') +
          stat('总市值', fmtCap(q.marketCap), '') +
          stat('PE', fmtNum(q.pe), '') +
          stat('PB', fmtNum(q.pb), '') +
        '</div>' +
      '</div>' +
      '<div class="detail-body">' +
      '<div class="detail-main">' +
      '<div class="chart-toolbar">' +
        '<div class="group">' +
          tbtnMode('kline', '日K', state.chartMode === 'kline') + tbtnMode('intraday', '分时', state.chartMode === 'intraday') +
        '</div><span class="sep"></span>' +
        '<div class="group">' +
          tbtn('bars', '60', state.bars === 60) + tbtn('bars', '120', state.bars === 120) + tbtn('bars', '250', state.bars === 250) +
        '</div><span class="sep"></span>' +
        '<div class="group">' +
          matog(5) + matog(10) + matog(20) + matog(60) +
        '</div>' +
        '<button class="mini-btn ' + (state.boll ? 'on' : '') + '" data-boll>BOLL</button>' +
        '<button class="mini-btn ' + (state.cardOpen===false?'':'on') + '" data-cardtoggle style="margin-left:auto">资料卡</button>' +
      '</div>' +
      '<div class="charts">' +
        '<canvas class="main-chart"></canvas>' +
        '<div class="chart-empty" id="chartEmpty"></div>' +
        subWindowsHtml() +
        '<button class="add-sub-btn" data-addsub title="增加副图指标窗口">＋ 添加副图指标</button>' +
      '</div>' +
      '</div>' +
      stockCard(stock) +
      '</div>';
    $(container).innerHTML = html;
    bindDetailEvents(container, code);
    drawCharts(code, container);
    ensureLiveKLines(code, container);
  }
  var SUB_TYPES = ['MACD', 'KDJ', 'RSI'];
  // 多个副图窗口，每个窗口顶部可直接切指标、可关闭
  function subWindowsHtml() {
    return state.subIndicators.map(function (type, i) {
      var tabs = SUB_TYPES.map(function (t) {
        return '<span class="sub-tab ' + (t === type ? 'on' : '') + '" data-subpick="' + i + ':' + t + '">' + t + '</span>';
      }).join('');
      var closeBtn = state.subIndicators.length > 1 ? '<span class="sub-close" data-subdel="' + i + '" title="移除此副图">✕</span>' : '';
      return '<div class="sub-window">' +
        '<div class="sub-tabs">' + tabs + closeBtn + '</div>' +
        '<canvas class="subCanvas" data-subidx="' + i + '"></canvas>' +
      '</div>';
    }).join('');
  }
  function matog(p) { return '<button class="mini-btn ' + (state.mas.indexOf(p)>=0?'on':'') + '" data-ma="' + p + '">MA' + p + '</button>'; }
  function tbtnMode(kind, label, on) { return '<button class="mini-btn ' + (on ? 'on' : '') + '" data-chartmode="' + kind + '">' + label + '</button>'; }

  // 个股资料卡只展示当前行情快照里可以证明的字段。
  function stockCard(stock) {
    if (state.cardOpen === false) return '';
    var q = stock.quote;
    return '<div class="stock-card" id="stockCard">' +
      '<div class="card-sec"><h4>报价统计</h4>' +
        kv('现价', fmtNum(q.price), cls(q.changePercent)) +
        kv('涨跌幅', fmtPct(q.changePercent), cls(q.changePercent)) +
        kv('振幅', fmtAmplitude(q), '') +
        kv('今开', fmtNum(q.open), cls((Number(q.open) || 0) - (Number(q.preClose) || 0))) +
        kv('最高', fmtNum(q.high), 'up') +
        kv('最低', fmtNum(q.low), 'down') +
        kv('昨收', fmtNum(q.preClose), '') +
        kv('成交量', fmtVol(q.volume), '') +
        kv('成交额', fmtAmt(q.amount), '') +
        kv('换手率', fmtNum(q.turnoverRate) + '%', '') +
        kv('总市值', fmtCap(q.marketCap), '') +
        kv('流通市值', fmtCap(q.floatMarketCap), '') +
        kv('PE', fmtNum(q.pe), '') +
        kv('PB', fmtNum(q.pb), '') +
      '</div>' +
      '<div class="card-sec"><h4>基本信息</h4>' +
        kv('代码', stock.code, '') + kv('市场', stock.market, '') + kv('行业', stock.industry, '') +
      '</div>' +
      '<div class="card-sec">' +
        '<button class="btn btn-block" style="margin:0 0 8px;width:100%" data-card-plan>生成研究计划</button>' +
        '<button class="btn btn-block" style="margin:0;width:100%" data-card-ai>🤖 让 AI 分析该股</button>' +
      '</div>' +
      '</div>';
  }
  function kv(k, v, c) { return '<div class="card-kv"><span>' + k + '</span><b class="' + c + '">' + v + '</b></div>'; }
  function stat(label, val, c) { return '<span>' + label + ' <b class="' + c + '">' + val + '</b></span>'; }
  function tbtn(kind, val, on) { return '<button class="mini-btn ' + (on?'on':'') + '" data-bars="' + val + '">' + val + '日</button>'; }

  function bindDetailEvents(container, code) {
    var root = $(container);
    var star = $('[data-star]', root); if (star) star.onclick = function () { toggleWatch(code); renderDetail(container, code); };
    $all('[data-bars]', root).forEach(function (b) { b.onclick = function () { state.bars = parseInt(b.dataset.bars, 10); renderDetail(container, code); }; });
    $all('[data-chartmode]', root).forEach(function (b) { b.onclick = function () { state.chartMode = b.dataset.chartmode; renderDetail(container, code); }; });
    $all('[data-ma]', root).forEach(function (b) { b.onclick = function () {
      var p = parseInt(b.dataset.ma, 10); var i = state.mas.indexOf(p);
      if (i >= 0) state.mas.splice(i, 1); else { state.mas.push(p); state.mas.sort(function (a, c) { return a - c; }); }
      renderDetail(container, code);
    }; });
    // 副图：直接切指标
    $all('[data-subpick]', root).forEach(function (el) { el.onclick = function () {
      var parts = el.dataset.subpick.split(':'); state.subIndicators[+parts[0]] = parts[1]; renderDetail(container, code);
    }; });
    // 副图：增加 / 移除窗口
    var addSub = $('[data-addsub]', root); if (addSub) addSub.onclick = function () {
      var next = SUB_TYPES.filter(function (t) { return state.subIndicators.indexOf(t) < 0; })[0] || 'MACD';
      state.subIndicators.push(next); renderDetail(container, code);
    };
    $all('[data-subdel]', root).forEach(function (el) { el.onclick = function () {
      state.subIndicators.splice(+el.dataset.subdel, 1); renderDetail(container, code);
    }; });
    var bollBtn = $('[data-boll]', root); if (bollBtn) bollBtn.onclick = function () { state.boll = !state.boll; renderDetail(container, code); };
    var cardBtn = $('[data-cardtoggle]', root); if (cardBtn) cardBtn.onclick = function () { state.cardOpen = !state.cardOpen; renderDetail(container, code); };
    var cardPlan = $('[data-card-plan]', root); if (cardPlan) cardPlan.onclick = function () { createTradePlan(code, { source: 'detail', reasons: ['手动从个股详情生成'] }); };
    var cardAi = $('[data-card-ai]', root); if (cardAi) cardAi.onclick = function () {
      if (!state.aiOpen) expandAiDock();
      if (submitAiPrompt) submitAiPrompt(stockAiPrompt(code));
    };
  }
  function detailRoot(container) {
    return container ? $(container) : (state.panel === 'watch' ? $('#watchDetailView') : $('#detailView'));
  }
  function drawCharts(code, container) {
    var root = detailRoot(container);
    var main = root ? $('.main-chart', root) : null;
    var chartEmpty = root ? $('#chartEmpty', root) : null;
    function setChartEmpty(show, text) {
      if (!chartEmpty) return;
      chartEmpty.textContent = text || '';
      chartEmpty.classList.toggle('show', !!show);
    }
    if (state.chartMode === 'intraday') {
      var intraday = D.getIntraday ? D.getIntraday(code, { points: 240 }) : [];
      setChartEmpty(false);
      if (main) CH.drawIntraday(main, intraday, { height: 220 });
      $all('.sub-window', root).forEach(function (el) { el.style.display = 'none'; });
      var addSubBtn = $('.add-sub-btn', root);
      if (addSubBtn) addSubBtn.style.display = 'none';
      ensureLiveIntraday(code, container);
      return;
    }
    var klines = D.getKLines(code);
    var minBars = Math.min(state.bars || 120, 20);
    var sparse = klines.length < minBars;
    // 多副图越多，主图越矮，保证整体不溢出
    var mainH = state.subIndicators.length >= 2 ? 280 : 320;
    if (main) CH.drawKLine(main, sparse ? [] : klines, { bars: state.bars, boll: state.boll, mas: state.mas, height: mainH });
    setChartEmpty(sparse, liveKLineRequests[code] ? '日K数据加载中…' : '当前快照未包含足够日K，待刷新后显示完整K线');
    $all('.sub-window', root).forEach(function (el) { el.style.display = ''; });
    var addBtn = $('.add-sub-btn', root);
    if (addBtn) addBtn.style.display = '';
    $all('.subCanvas', root).forEach(function (cv) {
      var i = +cv.dataset.subidx;
      CH.drawSub(cv, sparse ? [] : klines, state.subIndicators[i] || 'MACD', { bars: state.bars, height: 110 });
    });
  }

  function shouldRefreshLiveKLines(code) {
    var bridge = window.costockBridge && window.costockBridge.market;
    if (!bridge || !bridge.refreshKLine || !code || liveKLineRequests[code] || liveKLineReady[code]) return false;
    var status = D.getStatus ? D.getStatus() : null;
    if (!status || !status.connected) return false;
    var stock = D.getStock(code);
    if (!stock) return false;
    var klines = stock.klines || [];
    if (klines.length < Math.min(state.bars || 120, 60)) return true;
    return klines.some(function (k) { return !k.adjust || k.adjust === 'none'; });
  }
  function ensureLiveKLines(code, container) {
    if (!shouldRefreshLiveKLines(code)) return;
    var bridge = window.costockBridge && window.costockBridge.market;
    liveKLineRequests[code] = true;
    drawCharts(code, container);
    bridge.refreshKLine({ code: code, limit: Math.max(250, state.bars || 120) }).then(function (res) {
      liveKLineReady[code] = true;
      if (res && res.snapshot) syncMarketSnapshot(res.snapshot);
    }).catch(function () {
      liveKLineReady[code] = true;
    }).finally(function () {
      delete liveKLineRequests[code];
      if (state.panel === 'market' && state.currentCode === code) drawCharts(code, '#detailView');
      if (state.panel === 'watch' && state.watchCurrentCode === code) drawCharts(code, '#watchDetailView');
    });
  }

  function shouldRefreshLiveIntraday(code) {
    var bridge = window.costockBridge && window.costockBridge.market;
    if (!bridge || !bridge.refreshIntraday || !code || liveIntradayRequests[code] || liveIntradayReady[code]) return false;
    var status = D.getStatus ? D.getStatus() : null;
    if (!status || !status.connected) return false;
    var points = D.getIntraday ? D.getIntraday(code, { points: 240 }) : [];
    return !points.some(function (p) { return p && p.source === 'tencent-intraday'; });
  }
  function ensureLiveIntraday(code, container) {
    if (!shouldRefreshLiveIntraday(code)) return;
    var bridge = window.costockBridge && window.costockBridge.market;
    liveIntradayRequests[code] = true;
    bridge.refreshIntraday({ code: code, points: 240 }).then(function (res) {
      liveIntradayReady[code] = true;
      if (res && res.snapshot) syncMarketSnapshot(res.snapshot, { deferRender: true });
    }).catch(function () {
      liveIntradayReady[code] = true;
    }).finally(function () {
      delete liveIntradayRequests[code];
      if (state.chartMode !== 'intraday') return;
      if (state.panel === 'market' && state.currentCode === code) drawCharts(code, '#detailView');
      if (state.panel === 'watch' && state.watchCurrentCode === code) drawCharts(code, '#watchDetailView');
    });
  }

  function syncMarketSnapshot(snapshot, options) {
    if (!snapshot) return;
    var opts = options || {};
    if (D && D.hydrate) D.hydrate(snapshot);
    marketLoaded = true;
    var status = D.getStatus ? D.getStatus() : null;
    var codes = D.allCodes();
    if (!state.currentCode || codes.indexOf(state.currentCode) < 0) state.currentCode = codes[0] || null;
    if (state.watchCurrentCode && codes.indexOf(state.watchCurrentCode) < 0) state.watchCurrentCode = null;
    if (status) {
      setDataBadge(status.connected ? '真实/延迟数据' : '本地/缓存数据', status.connected, status);
    }
    updateFormulaTestStocks();
    updateAiRuntime({ dataConnected: !!(status && status.connected) });
    if (opts.deferRender) return;
    renderMarketList();
    if (state.panel === 'market' && state.currentCode) renderSnapshotDetail('#detailView', state.currentCode);
    if (state.panel === 'watch' && state.watchCurrentCode) {
      if (chartHoverActive('#watchDetailView')) drawCharts(state.watchCurrentCode, '#watchDetailView');
      else renderWatchList();
    }
    if (state.panel === 'formula') renderFormulaList();
    if (state.panel === 'screener') renderScreenResults(state.lastScreenResults || []);
  }

  function chartHoverActive(container) {
    var root = $(container);
    return !!(root && root.querySelector('.chart-hover-tip.show, .chart-axis-label.show'));
  }

  function renderSnapshotDetail(container, code) {
    if (chartHoverActive(container)) {
      drawCharts(code, container);
      return;
    }
    renderDetail(container, code);
  }

  function initMarketSource() {
    if (window.costockBridge && window.costockBridge.market && window.costockBridge.market.getSnapshot) {
      window.costockBridge.market.getSnapshot().then(function (snapshot) {
        syncMarketSnapshot(snapshot);
        refreshLiveMarket(true, { universe: 'a-share', quoteLimit: 1500, klineCodeLimit: 1, aShareFallbackQuoteLimit: 1500, timeoutMs: 8000, kind: 'bootstrap', priority: 70 })
          .finally(refreshFullMarketInBackground);
      }).catch(function () {
        setDataBadge('本地/缓存数据', false, D.getStatus ? D.getStatus() : null);
      });
      return;
    }
    setDataBadge('本地/缓存数据', false, D.getStatus ? D.getStatus() : null);
    marketLoaded = true;
  }
  function shanghaiMarketClock(now) {
    var date = now || new Date();
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(date).reduce(function (acc, part) {
        acc[part.type] = part.value;
        return acc;
      }, {});
      var dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      var hour = Number(parts.hour);
      if (hour === 24) hour = 0;
      return {
        day: dayMap[parts.weekday] == null ? date.getDay() : dayMap[parts.weekday],
        minuteOfDay: hour * 60 + Number(parts.minute || 0)
      };
    } catch (err) {
      return {
        day: date.getDay(),
        minuteOfDay: date.getHours() * 60 + date.getMinutes()
      };
    }
  }
  function autoMarketRefreshInterval(now) {
    var clock = shanghaiMarketClock(now);
    var weekday = clock.day >= 1 && clock.day <= 5;
    var m = clock.minuteOfDay;
    var active = weekday && ((m >= 9 * 60 + 30 && m <= 11 * 60 + 30) || (m >= 13 * 60 && m <= 15 * 60));
    if (active) return AUTO_MARKET_ACTIVE_MS;
    var nearSession = weekday && m >= 9 * 60 && m <= 15 * 60 + 15;
    return nearSession ? AUTO_MARKET_NEAR_SESSION_MS : AUTO_MARKET_CLOSED_MS;
  }
  function shouldAutoRefreshMarket() {
    var bridge = window.costockBridge && window.costockBridge.market;
    if (!bridge || !bridge.refreshLive) return false;
    var status = D.getStatus ? D.getStatus() : null;
    return !(status && status.source === 'file');
  }
  function autoMarketPriorityCodes() {
    var out = [];
    function add(code) {
      if (!code || out.indexOf(code) >= 0) return;
      out.push(code);
    }
    if (state.panel === 'watch') add(state.watchCurrentCode);
    add(state.currentCode);
    add(state.watchCurrentCode);
    (state.watch || []).forEach(add);
    return out;
  }
  function autoMarketShardCodes(size) {
    var codes = D && D.allCodes ? D.allCodes() : [];
    if (!codes.length || !size) return [];
    var out = [];
    for (var i = 0; i < size && i < codes.length; i += 1) {
      out.push(codes[(autoMarketShardCursor + i) % codes.length]);
    }
    autoMarketShardCursor = (autoMarketShardCursor + out.length) % codes.length;
    return out;
  }
  function autoMarketRefreshOptions(includeShard) {
    var status = D.getStatus ? D.getStatus() : null;
    var count = (status && status.count) || 0;
    var fullMarket = count > 500;
    var priorityCodes = autoMarketPriorityCodes();
    var shardCodes = includeShard && fullMarket ? autoMarketShardCodes(AUTO_MARKET_SHARD_SIZE) : [];
    var refreshCodes = [];
    priorityCodes.concat(shardCodes).forEach(function (code) {
      if (code && refreshCodes.indexOf(code) < 0) refreshCodes.push(code);
    });
    return {
      universe: 'current',
      quoteLimit: fullMarket ? Math.max(80, refreshCodes.length) : Math.max(80, count || 80),
      klineCodeLimit: 1,
      priorityQuoteCodes: refreshCodes,
      priorityKlineCodes: priorityCodes,
      timeoutMs: 5000,
      quiet: true,
      auto: true
    };
  }
  function runAutoMarketRefresh(reason) {
    if (!shouldAutoRefreshMarket()) return Promise.resolve(null);
    var interval = autoMarketRefreshInterval();
    if (lastMarketSyncAt && Date.now() - lastMarketSyncAt < interval - 1000) return Promise.resolve(null);
    autoMarketRefreshTick += 1;
    var includeShard = autoMarketRefreshTick % AUTO_MARKET_SHARD_EVERY === 0;
    var opts = autoMarketRefreshOptions(includeShard);
    opts.kind = includeShard ? 'shard' : 'focus';
    opts.priority = includeShard ? 40 : 80;
    return refreshLiveMarket(true, opts);
  }
  function refreshFullMarketInBackground() {
    if (fullMarketChunksQueued || !shouldAutoRefreshMarket()) return fullMarketRefreshPromise || Promise.resolve(null);
    fullMarketChunksQueued = true;
    var tasks = [];
    var pageSize = 100;
    var pagesPerTask = 6;
    var quickPages = 15;
    var maxPages = 60;
    for (var start = quickPages + 1; start <= maxPages; start += pagesPerTask) {
      tasks.push(refreshLiveMarket(true, {
        universe: 'a-share',
        quoteLimit: pageSize * pagesPerTask,
        klineCodeLimit: 1,
        timeoutMs: 8000,
        quiet: true,
        background: true,
        kind: 'full-chunk',
        priority: 10,
        aShareStartPage: start,
        aSharePageCount: pagesPerTask,
        coalesceKey: 'full-chunk:' + start + ':' + pagesPerTask
      }));
    }
    fullMarketRefreshPromise = Promise.all(tasks).finally(function () {
      fullMarketChunksQueued = false;
      fullMarketRefreshPromise = null;
    });
    return fullMarketRefreshPromise;
  }
  function scheduleNextAutoMarketRefresh(delayMs) {
    if (autoMarketRefreshTimer) clearTimeout(autoMarketRefreshTimer);
    autoMarketRefreshTimer = setTimeout(function () {
      runAutoMarketRefresh('timer').finally(function () {
        scheduleNextAutoMarketRefresh(autoMarketRefreshInterval());
      });
    }, delayMs || autoMarketRefreshInterval());
  }
  function setupMarketAutoRefresh() {
    if (!shouldAutoRefreshMarket()) return;
    scheduleNextAutoMarketRefresh(autoMarketRefreshInterval());
    function refreshIfStale() {
      runAutoMarketRefresh('focus').finally(function () {
        scheduleNextAutoMarketRefresh(autoMarketRefreshInterval());
      });
    }
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshIfStale();
    });
  }
  function setMarketRefreshBusy(busy, options) {
    var opts = options || {};
    var refreshBtn = $('#refreshMarketBtn');
    var refreshAllBtn = $('#refreshAllMarketBtn');
    [refreshBtn, refreshAllBtn].forEach(function (btn) {
      if (!btn) return;
      btn.disabled = !!busy;
    });
    if (refreshBtn) refreshBtn.textContent = busy && opts.universe !== 'a-share' ? '刷新中' : '刷新行情';
    if (refreshAllBtn) refreshAllBtn.textContent = busy && opts.universe === 'a-share' ? '加载中' : '全A';
  }

  function marketRefreshPriority(silent, options) {
    var opts = options || {};
    if (opts.priority != null) return Number(opts.priority) || 0;
    if (!silent) return opts.universe === 'a-share' ? 100 : 90;
    if (opts.kind === 'focus') return 80;
    if (opts.kind === 'bootstrap') return 70;
    if (opts.kind === 'shard') return 40;
    if (opts.kind === 'full-chunk' || opts.background) return 10;
    return 50;
  }

  function marketRefreshCoalesceKey(options) {
    var opts = options || {};
    if (opts.coalesceKey) return opts.coalesceKey;
    if (opts.universe === 'a-share' && opts.aShareStartPage) {
      return 'a-share-page:' + opts.aShareStartPage + ':' + (opts.aSharePageCount || 1);
    }
    if (opts.universe === 'a-share') {
      return 'a-share:' + (opts.quoteLimit || 6000) + ':' + (opts.klineCodeLimit == null ? '' : opts.klineCodeLimit);
    }
    var codes = Array.isArray(opts.priorityQuoteCodes) ? opts.priorityQuoteCodes.slice(0, 80).join(',') : '';
    return (opts.kind || 'current') + ':' + codes + ':' + (opts.quoteLimit || 80);
  }

  function runMarketRefreshTask(task) {
    var bridge = window.costockBridge && window.costockBridge.market;
    var opts = task.options || {};
    if (!bridge || !bridge.refreshLive) return Promise.resolve(null);
    if (task.showBusy) setMarketRefreshBusy(true, opts);
    var currentStatus = D.getStatus ? D.getStatus() : null;
    if (task.showBusy) setDataBadge(opts.universe === 'a-share' ? '加载全A中' : '刷新行情中', currentStatus && currentStatus.connected, currentStatus, { loading: true });
    return bridge.refreshLive(opts).then(function (res) {
      if (!res || !res.snapshot) return null;
      syncMarketSnapshot(res.snapshot);
      lastMarketSyncAt = Date.now();
      var st = res.status || (D.getStatus ? D.getStatus() : null);
      var connected = !!(st && st.connected);
      setDataBadge(connected ? '真实/延迟数据' : '本地/缓存数据', connected, st);
      if (!task.silent) toast((connected ? (opts.universe === 'a-share' ? '全A已加载：' : '行情已刷新：') : '保留缓存：') + (st && st.count != null ? st.count : 0) + ' 只');
      return res;
    }).catch(function () {
      var st = D.getStatus ? D.getStatus() : null;
      setDataBadge(st && st.connected ? '真实/延迟数据' : '本地/缓存数据', st && st.connected, st);
      if (!task.silent) toast('行情刷新失败，保留当前缓存');
      return null;
    }).finally(function () {
      if (task.showBusy) setMarketRefreshBusy(false, opts);
    });
  }

  function getMarketRefreshScheduler() {
    if (!marketRefreshScheduler) {
      marketRefreshScheduler = window.CoStockMarketScheduler.createMarketRefreshScheduler({
        runner: runMarketRefreshTask,
        shouldAccept: function (task) {
          return !(task.auto || task.background) || shouldAutoRefreshMarket();
        }
      });
    }
    return marketRefreshScheduler;
  }

  function refreshLiveMarket(silent, options) {
    var bridge = window.costockBridge && window.costockBridge.market;
    var opts = options || {};
    if (!bridge || !bridge.refreshLive) return Promise.resolve(null);
    return getMarketRefreshScheduler().enqueue({
      kind: opts.kind || (opts.universe === 'a-share' ? 'full' : 'focus'),
      priority: marketRefreshPriority(silent, opts),
      coalesceKey: marketRefreshCoalesceKey(opts),
      options: opts,
      silent: !!silent,
      showBusy: !opts.quiet && !silent,
      auto: !!opts.auto,
      background: !!opts.background
    });
  }
  function setupMarketImport() {
    var btn = $('#importMarketBtn');
    var refreshBtn = $('#refreshMarketBtn');
    var refreshAllBtn = $('#refreshAllMarketBtn');
    if (refreshAllBtn) {
      if (window.costockBridge && window.costockBridge.market && window.costockBridge.market.refreshLive) {
        refreshAllBtn.onclick = function () { refreshLiveMarket(false, { universe: 'a-share', quoteLimit: 6000, klineCodeLimit: 30 }); };
      } else {
        refreshAllBtn.style.display = 'none';
      }
    }
    if (refreshBtn) {
      if (window.costockBridge && window.costockBridge.market && window.costockBridge.market.refreshLive) {
        refreshBtn.onclick = function () { refreshLiveMarket(false); };
      } else {
        refreshBtn.style.display = 'none';
      }
    }
    if (!btn) return;
    if (!(window.costockBridge && window.costockBridge.market && window.costockBridge.market.importFile)) {
      btn.style.display = 'none';
      return;
    }
    btn.onclick = function () {
      window.costockBridge.market.importFile().then(function (res) {
        if (!res || res.canceled) return;
        syncMarketSnapshot(res.snapshot);
        var st = res.status || (D.getStatus ? D.getStatus() : null);
        toast('已导入行情：' + (st && st.count != null ? st.count : 0) + ' 只' + (st && st.klineCount ? ' / ' + st.klineCount + ' 根K线' : ''));
      }).catch(function () {
        toast('行情导入失败');
      });
    };
  }
  function statusRow(label, value, extraClass) {
    return '<span class="status-k">' + esc(label) + '</span><span class="status-v ' + (extraClass || '') + '">' + esc(value) + '</span>';
  }
  function statusSection(title, rows) {
    return '<div class="status-section"><h4>' + esc(title) + '</h4><div class="status-grid">' + rows.join('') + '</div></div>';
  }
  function fmtStatusTime(ts) {
    return ts ? fmtTime(ts) : '-';
  }
	  function storageStatusLabel(ok) {
	    return ok ? '本机已写入' : '尚未写入';
	  }
	  function readableDataStatusLabel(running, injected, reachable) {
	    if (reachable) return '可读取完整数据';
	    if (injected || running) return '已接入应用数据';
	    return '未接入';
	  }
  function formatDataScopes(scopes) {
    var labels = {
      market_status: '行情状态',
      market_stocks: '股票清单',
      market_quotes: '行情报价',
      market_quote: '单股报价',
      market_klines: 'K线',
      market_intraday: '分时',
      market_indicators: '技术指标',
      watchlist: '自选股',
      formulas: '公式',
      formula_screener: '公式选股',
      builtin_screener: '条件选股',
      saved_strategies: '选股策略',
      strategy_screener: '策略选股',
      screener_results: '选股结果',
      screener_history: '选股历史',
      research_plans: '研究计划',
      trade_plans: '研究计划',
      ai_history: 'AI聊天历史',
      ai_consensus: 'AI共识',
      user_state: '本地用户状态',
      latest_context: '最新界面上下文'
    };
    labels.market_snapshot = '行情数据';
    labels.technical_indicators = '技术指标';
    labels.screening_strategies = '选股策略';
    labels.screening_results = '选股结果';
    labels.latest_renderer_context = '最新界面上下文';
    return (Array.isArray(scopes) ? scopes : []).map(function (scope) {
      return labels[scope] || scope;
    }).join('、') || '-';
  }
  function renderDataStatus(status) {
    var body = $('#dataStatusBody');
    if (!body) return;
    if (!status) {
      body.innerHTML = '<div class="status-loading">读取状态中…</div>';
      return;
    }
    var market = status.market || {};
    var user = status.user || {};
    var appServer = status.appServer || {};
    var ai = status.ai || {};
    var aiBackend = ai.backend || {};
    var aiSettings = ai.settings || {};
    var runtime = status.runtime || {};
    var sections = [];
    sections.push(statusSection('行情数据', [
      statusRow('连接状态', market.connected ? '真实/延迟数据' : '本地/缓存数据', market.connected ? 'up' : 'down'),
      statusRow('来源', market.provider || market.source || '-'),
      statusRow('股票数', market.count != null ? market.count + ' 只' : '-'),
      statusRow('K线数', market.klineCount != null ? market.klineCount + ' 根' : '-'),
      statusRow('分时点', market.intradayCount != null ? market.intradayCount + ' 点' : '-'),
      statusRow('更新时间', fmtStatusTime(market.updatedAt)),
      statusRow('缓存状态', market.path ? '本机缓存可用' : '当前会话'),
      statusRow('说明', market.note || '-')
    ]));
    sections.push(statusSection('本地状态', [
      statusRow('用户状态', user.exists === false ? '尚未写入' : '已接入'),
      statusRow('本地存储', storageStatusLabel(user.exists !== false)),
      statusRow('自选股', runtime.watchCount != null ? runtime.watchCount + ' 只' : '-'),
      statusRow('公式', runtime.formulaCount != null ? runtime.formulaCount + ' 个' : '-'),
      statusRow('选股策略', runtime.strategyCount != null ? runtime.strategyCount + ' 个' : '-'),
      statusRow('选股历史', runtime.screenHistoryCount != null ? runtime.screenHistoryCount + ' 次' : '-'),
      statusRow('研究计划', runtime.tradePlanCount != null ? runtime.tradePlanCount + ' 条' : '-')
    ]));
	    sections.push(statusSection('AI 聊天', [
	      statusRow('运行方式', 'Codex'),
	      statusRow('连接状态', aiBackend.enabled ? '已就绪' : '未就绪', aiBackend.enabled ? 'up' : 'down'),
	      statusRow('API Key', aiSettings.hasApiKey ? '已保存' : '使用 Codex 默认配置', aiSettings.hasApiKey ? 'up' : ''),
	      statusRow('Base URL', aiSettings.hasBaseUrl ? '已设置' : '使用 Codex 默认配置', aiSettings.hasBaseUrl ? 'up' : ''),
	      statusRow('数据接入', aiBackend.dataInjection ? '已接入应用数据' : '未接入', aiBackend.dataInjection ? 'up' : 'down'),
	      statusRow('只读范围', formatDataScopes(ai.readableTools))
	    ]));
	    var appRows = [
	      statusRow('读取方式', appServer.capabilities && appServer.capabilities.readOnly ? '只读' : '只读快照'),
	      statusRow('数据接入', aiBackend.dataInjection ? '已接入应用数据' : readableDataStatusLabel(appServer.running, false, aiBackend.localhostDataGatewayReachable), (appServer.running || aiBackend.dataInjection) ? 'up' : 'down'),
	      statusRow('数据范围', appServer.capabilities && Array.isArray(appServer.capabilities.dataScopes) ? formatDataScopes(appServer.capabilities.dataScopes) : '-')
	    ];
    sections.push(statusSection('AI 可读数据', appRows));
    body.innerHTML = sections.join('');
  }
  function collectDataStatus() {
    var marketBridge = window.costockBridge && window.costockBridge.market;
    var appServerBridge = window.costockBridge && window.costockBridge.aiAppServer;
    var aiBridge = window.costockBridge && window.costockBridge.ai;
    var user = userBridge();
    var localUser = localUserStateSnapshot();
    var runtime = {
      watchCount: state.watch.length,
      formulaCount: allFormulas().length,
      strategyCount: state.screeningStrategies.length,
      screenHistoryCount: load('costock.screeningHistory', []).length,
      tradePlanCount: state.tradePlans.length
    };
    var marketPromise = marketBridge && marketBridge.getStatus
      ? marketBridge.getStatus().catch(function () { return D.getStatus ? D.getStatus() : null; })
      : Promise.resolve(D.getStatus ? D.getStatus() : null);
    var userPromise = user && user.getStatus
      ? user.getStatus().catch(function () { return { exists: false, path: 'localStorage' }; })
      : Promise.resolve({ exists: false, path: 'localStorage' });
    var appPromise = appServerBridge && appServerBridge.getInfo
      ? appServerBridge.getInfo().catch(function () { return { running: false }; })
      : Promise.resolve({ running: false });
    var aiPromise = aiBridge && aiBridge.getStatus
      ? aiBridge.getStatus().catch(function () { return { backend: { source: 'codex-unavailable' }, readableTools: [], tradingDisabled: true }; })
      : Promise.resolve({ backend: { source: 'codex-unavailable' }, readableTools: [], tradingDisabled: true });
    return Promise.all([marketPromise, userPromise, appPromise, aiPromise]).then(function (items) {
      return {
        market: items[0],
        user: items[1],
        appServer: items[2],
        ai: items[3],
        runtime: runtime,
        userState: localUser
      };
    });
  }
  function openDataStatus() {
    var mask = $('#dataStatusMask');
    if (!mask) return;
    mask.classList.add('show');
    renderDataStatus(null);
    setTimeout(function () {
      var done = $('#dataStatusDone');
      if (done) done.focus();
    }, 40);
    collectDataStatus().then(renderDataStatus).catch(function () {
      var body = $('#dataStatusBody');
      if (body) body.innerHTML = '<div class="status-loading down">状态读取失败</div>';
    });
  }
  function closeDataStatus() {
    var mask = $('#dataStatusMask');
    if (mask) mask.classList.remove('show');
  }
  function setupDataStatusModal() {
    var close = $('#dataStatusClose');
    var done = $('#dataStatusDone');
    var refresh = $('#dataStatusRefresh');
    var mask = $('#dataStatusMask');
    [$('#dataBadge'), $('#dataMeta')].forEach(function (el) {
      if (!el) return;
      el.classList.add('status-trigger');
      el.onclick = openDataStatus;
    });
    if (close) close.onclick = closeDataStatus;
    if (done) done.onclick = closeDataStatus;
    if (refresh) refresh.onclick = openDataStatus;
    if (mask) {
      mask.onclick = function (e) { if (e.target === mask) closeDataStatus(); };
      mask.onkeydown = function (e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeDataStatus();
        }
      };
    }
  }
  function aiSettingsBridge() {
    return window.costockBridge && window.costockBridge.aiSettings ? window.costockBridge.aiSettings : null;
  }
  function closeAiSettings() {
    var mask = $('#aiSettingsMask');
    if (mask) mask.classList.remove('show');
  }
  function openAiSettings() {
    var mask = $('#aiSettingsMask');
    var apiKey = $('#aiApiKeyInput');
    var baseUrl = $('#aiBaseUrlInput');
    var clearKey = $('#aiApiKeyClear');
    if (!mask || !apiKey || !baseUrl || !clearKey) return;
    apiKey.value = '';
    baseUrl.value = '';
    clearKey.checked = false;
    mask.classList.add('show');
    var bridge = aiSettingsBridge();
    var promise = bridge && bridge.get ? bridge.get() : Promise.resolve(null);
    promise.then(function (settings) {
      var s = settings || {};
      apiKey.placeholder = s.hasApiKey ? '已保存，留空不变' : '输入 API Key';
      baseUrl.value = s.baseUrl || '';
    }).catch(function () {
      apiKey.placeholder = '输入 API Key';
    }).finally(function () {
      setTimeout(function () { apiKey.focus(); }, 40);
    });
  }
  function saveAiSettings() {
    var bridge = aiSettingsBridge();
    var apiKey = $('#aiApiKeyInput');
    var baseUrl = $('#aiBaseUrlInput');
    var clearKey = $('#aiApiKeyClear');
    if (!bridge || !bridge.save || !apiKey || !baseUrl || !clearKey) {
      toast('AI 设置不可用');
      return;
    }
    bridge.save({
      apiKey: apiKey.value,
      baseUrl: baseUrl.value,
      clearApiKey: clearKey.checked
    }).then(function () {
      toast('AI 设置已保存');
      closeAiSettings();
      refreshAiRuntime();
    }).catch(function (err) {
      toast((err && err.message) || 'AI 设置保存失败');
    });
  }
  function setupAiSettingsModal() {
    var open = $('#aiSettingsBtn');
    var close = $('#aiSettingsClose');
    var cancel = $('#aiSettingsCancel');
    var save = $('#aiSettingsSave');
    var mask = $('#aiSettingsMask');
    if (open) open.onclick = openAiSettings;
    if (close) close.onclick = closeAiSettings;
    if (cancel) cancel.onclick = closeAiSettings;
    if (save) save.onclick = saveAiSettings;
    if (mask) {
      mask.onclick = function (e) { if (e.target === mask) closeAiSettings(); };
      mask.onkeydown = function (e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeAiSettings();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          saveAiSettings();
        }
      };
    }
  }
  function redrawDetail() {
    if (state.currentCode) drawCharts(state.currentCode, '#detailView');
  }

  // ---------- 自选板块（分组 + 搜索） ----------
  function watchCodesInGroup() {
    if (state.watchGroup === '全部') return state.watch.slice();
    return (state.watchGroups[state.watchGroup] || []).slice();
  }
  function isDefaultWatchGroup(name) {
    return Object.prototype.hasOwnProperty.call(defaultWatchGroups, name);
  }
  function renderWatchGroups() {
    var box = $('#watchGroups'); if (!box) return;
    var tabs = ['全部'].concat(Object.keys(state.watchGroups));
    box.innerHTML = tabs.map(function (g) {
      var count = g === '全部' ? state.watch.length : (state.watchGroups[g] || []).length;
      var del = (g === '全部' || isDefaultWatchGroup(g)) ? '' : '<span class="wg-del" data-delgroup="' + g + '" title="删除分组">✕</span>';
      return '<span class="watch-group ' + (g === state.watchGroup ? 'active' : '') + '" data-group="' + g + '">' +
        g + '<span class="wg-count">' + count + '</span>' + del + '</span>';
    }).join('');
    $all('[data-group]', box).forEach(function (el) {
      el.onclick = function (e) {
        if (e.target.dataset.delgroup) return;
        state.watchGroup = el.dataset.group; renderWatchList();
      };
    });
    $all('[data-delgroup]', box).forEach(function (el) {
      el.onclick = function (e) {
        e.stopPropagation();
        var g = el.dataset.delgroup;
        if (isDefaultWatchGroup(g)) return;
        delete state.watchGroups[g];
        if (state.watchGroup === g) state.watchGroup = '全部';
        save('costock.watchGroups', state.watchGroups);
        renderWatchList();
      };
    });
  }
  function renderWatchList() {
    renderWatchGroups();
    var ul = $('#watchList');
    var empty = $('#watchEmpty');
    var codes = watchCodesInGroup();
    // 搜索过滤
    var kw = state.watchFilter.trim().toLowerCase();
    if (kw) codes = codes.filter(function (code) {
      var q = D.getQuote(code); return q && (code.indexOf(kw) >= 0 || q.name.toLowerCase().indexOf(kw) >= 0);
    });
    $('#watchCount').textContent = state.watch.length + ' 只';
    if (!codes.length) {
      ul.innerHTML = ''; empty.classList.remove('hidden');
      empty.innerHTML = kw ? '没有匹配「' + kw + '」的自选股' : (state.watchGroup === '全部' ? '暂无自选股<br/><span class="muted">在行情或选股结果中点击 ☆ 添加</span>' : '「' + state.watchGroup + '」分组为空<br/><span class="muted">悬浮列表项点 ⊕ 归入分组</span>');
      $('#watchDetailView').innerHTML = '<div class="empty-tip">该分组暂无股票</div>';
      return;
    }
    empty.classList.add('hidden');
    var quotes = codes.map(function (code) { return D.getQuote(code); }).filter(Boolean);
    ul.innerHTML = quotes.map(function (q) {
      var c = cls(q.changePercent);
      return '<li data-code="' + q.code + '" class="' + (q.code === state.watchCurrentCode ? 'active' : '') + '">' +
        '<span class="s-name-wrap"><span class="s-name">' + q.name + '<span class="li-group-btn" data-grp="' + q.code + '" title="归入分组">⊕</span></span><span class="s-code-sm">' + q.code + '</span></span>' +
        '<span class="s-price ' + c + '">' + fmtNum(q.price) + '</span>' +
        '<span class="s-chg ' + c + '">' + fmtPct(q.changePercent) + '</span>' +
        '</li>';
    }).join('');
    $all('li', ul).forEach(function (li) {
      li.onclick = function () { state.watchCurrentCode = li.dataset.code; renderDetail('#watchDetailView', li.dataset.code); $all('#watchList li').forEach(function (x) { x.classList.toggle('active', x === li); }); };
    });
    $all('[data-grp]', ul).forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); openGroupPop(b, b.dataset.grp); };
    });
    if (!state.watchCurrentCode || codes.indexOf(state.watchCurrentCode) < 0) state.watchCurrentCode = codes[0];
    renderDetail('#watchDetailView', state.watchCurrentCode);
    $all('#watchList li').forEach(function (li) { li.classList.toggle('active', li.dataset.code === state.watchCurrentCode); });
  }
  // 分组归类浮层
  function openGroupPop(anchor, code) {
    closeGroupPop();
    var pop = document.createElement('div'); pop.className = 'group-pop'; pop.id = 'groupPop';
    pop.innerHTML = Object.keys(state.watchGroups).map(function (g) {
      var on = state.watchGroups[g].indexOf(code) >= 0;
      return '<div data-setg="' + g + '" class="' + (on ? 'on' : '') + '"><span>' + g + '</span><span>' + (on ? '✓' : '') + '</span></div>';
    }).join('') + '<div data-newg style="border-top:1px solid var(--border);color:var(--blue)">＋ 新建分组…</div>';
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    pop.style.left = r.left + 'px'; pop.style.top = (r.bottom + 4) + 'px';
    $all('[data-setg]', pop).forEach(function (d) { d.onclick = function () { setStockGroup(code, d.dataset.setg); closeGroupPop(); }; });
    $('[data-newg]', pop).onclick = function (e) {
      e.stopPropagation();
      closeGroupPop();
      askText({ title: '新建自选分组', label: '分组名称', placeholder: '例如：观察' }).then(function (n) {
        if (n && n.trim()) {
          addWatchGroup(n.trim());
          setStockGroup(code, n.trim());
        }
      });
    };
    setTimeout(function () { document.addEventListener('click', closeGroupPop, { once: true }); }, 0);
  }
  function closeGroupPop() { var p = $('#groupPop'); if (p) p.remove(); }
  function addWatchGroup(name) {
    if (!state.watchGroups[name]) { state.watchGroups[name] = []; save('costock.watchGroups', state.watchGroups); }
  }
  function setupWatchControls() {
    var inp = $('#watchSearch');
    if (inp) inp.oninput = function () { state.watchFilter = inp.value; renderWatchList(); inp.focus(); };
    var addBtn = $('#watchAddGroup');
    if (addBtn) addBtn.onclick = function () {
      askText({ title: '新建自选分组', label: '分组名称', placeholder: '例如：短线' }).then(function (n) {
        if (n && n.trim()) {
          addWatchGroup(n.trim());
          state.watchGroup = n.trim();
          renderWatchList();
        }
      });
    };
    var impBtn = $('#watchImport');
    if (impBtn) impBtn.onclick = openImport;
    setupImportModal();
  }

  // ---------- 批量导入 ----------
  // 把单个 token 规整成 6 位股票代码，兼容通达信 .blk 格式及常见写法：
  //   通达信 .blk：  1600519(沪) / 0000858(深) / 1601318  —— 首位市场标识 + 6位代码
  //   带市场前缀：    SH600519 / sz000858
  //   带后缀：        600519.SH / 000858.SZ
  //   纯代码：        600519
  function normalizeCode(tk) {
    var t = tk.trim().toUpperCase();
    if (!t) return null;
    // 600519.SH / 000858.SZ
    var mSuffix = t.match(/^(\d{6})\.(SH|SZ|BJ)$/);
    if (mSuffix) return mSuffix[1];
    // SH600519 / SZ000858 / BJ...
    var mPrefix = t.match(/^(SH|SZ|BJ)(\d{6})$/);
    if (mPrefix) return mPrefix[2];
    // 通达信 .blk：7 位数字，首位 0/1/2 为市场标识
    var mBlk = t.match(/^[012](\d{6})$/);
    if (mBlk) return mBlk[1];
    // 纯 6 位代码
    if (/^\d{6}$/.test(t)) return t;
    return null; // 非代码（可能是名称）
  }
  // 解析文本为代码列表：兼容 TDX .blk、带市场前后缀、纯代码、以及股票名称
  function parseImport(text) {
    var tokens = text.split(/[\s,;，；、\t\r\n]+/).filter(Boolean);
    var ok = [], bad = [], seen = {};
    var all = D.listStocks();
    tokens.forEach(function (tk) {
      var t = tk.trim(); if (!t) return;
      // 先尝试按代码（含 TDX 市场前缀）规整
      var norm = normalizeCode(t);
      var hit = norm ? D.getStock(norm) : null;
      // 再按名称匹配
      if (!hit) {
        var byName = all.filter(function (q) { return q.name === t || q.name.indexOf(t) >= 0 || q.code.indexOf(t) >= 0; })[0];
        if (byName) hit = D.getStock(byName.code);
      }
      if (hit) { if (!seen[hit.code]) { seen[hit.code] = 1; ok.push(hit.code); } }
      else { bad.push(t); }
    });
    return { ok: ok, bad: bad };
  }
  function openImport() {
    var sel = $('#importGroup');
    sel.innerHTML = '<option value="">（不分组，仅加入自选）</option>' +
      Object.keys(state.watchGroups).map(function (g) { return '<option value="' + g + '">' + g + '</option>'; }).join('');
    if (state.watchGroup !== '全部') sel.value = state.watchGroup;
    $('#importText').value = '';
    $('#importPreview').innerHTML = '';
    var fn = $('#importFileName'); if (fn) fn.textContent = '';
    var fi = $('#importFile'); if (fi) fi.value = '';
    $('#importMask').classList.add('show');
    setTimeout(function () { $('#importText').focus(); }, 50);
  }
  function closeImport() { $('#importMask').classList.remove('show'); }
  function setupImportModal() {
    $('#importClose').onclick = closeImport;
    $('#importMask').onclick = function (e) { if (e.target === $('#importMask')) closeImport(); };
    $('#importMask').onkeydown = function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeImport();
      }
    };
    // 读取 .blk/.txt 文件到文本框
    var fileInput = $('#importFile');
    if (fileInput) fileInput.onchange = function () {
      var f = fileInput.files && fileInput.files[0]; if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        $('#importText').value = String(reader.result || '');
        $('#importFileName').textContent = f.name;
        renderImportPreview(parseImport($('#importText').value));
      };
      reader.readAsText(f);
    };
    $('#importParse').onclick = function () {
      var r = parseImport($('#importText').value);
      renderImportPreview(r);
    };
    $('#importConfirm').onclick = function () {
      var r = parseImport($('#importText').value);
      if (!r.ok.length) { toast('没有可导入的有效代码'); return; }
      var group = $('#importGroup').value;
      var added = 0;
      r.ok.forEach(function (code) {
        if (state.watch.indexOf(code) < 0) { state.watch.push(code); added++; }
        if (group && state.watchGroups[group] && state.watchGroups[group].indexOf(code) < 0) state.watchGroups[group].push(code);
      });
      save('costock.watch', state.watch);
      save('costock.watchGroups', state.watchGroups);
      closeImport();
      if (group) state.watchGroup = group;
      renderWatchList();
      toast('成功导入 ' + r.ok.length + ' 只' + (added < r.ok.length ? '（' + (r.ok.length-added) + ' 只已存在）' : ''));
    };
  }
  function renderImportPreview(r) {
    var box = $('#importPreview');
    var okHtml = r.ok.map(function (code) { var q = D.getQuote(code); return '<span class="ip-ok">' + q.name + ' ' + code + '</span>'; }).join('');
    var badHtml = r.bad.map(function (t) { return '<span class="ip-bad">' + t + '</span>'; }).join('');
    box.innerHTML =
      '<div class="ip-summary">可导入 <b>' + r.ok.length + '</b> 只' + (r.bad.length ? '，无法识别 <b>' + r.bad.length + '</b> 项' : '') + '</div>' +
      okHtml + (badHtml ? '<div style="margin-top:6px"></div>' + badHtml : '');
  }

  // ---------- 行情本地搜索 ----------
  function setupSearch() {
    var input = $('#marketSearch');
    if (!input) return;
    var sortSelect = $('#marketSort');
    var sortDir = $('#marketSortDir');
    if (sortSelect) sortSelect.onchange = function () {
      state.marketSort.key = sortSelect.value;
      save('costock.marketSort', state.marketSort);
      syncMarketSortControls();
      renderMarketList();
    };
    if (sortDir) sortDir.onclick = function () {
      state.marketSort.dir = state.marketSort.dir === 'asc' ? 'desc' : 'asc';
      save('costock.marketSort', state.marketSort);
      syncMarketSortControls();
      renderMarketList();
    };
    syncMarketSortControls();
    input.oninput = function () {
      state.marketFilter = input.value;
      renderMarketList();
      input.focus();
      // 若过滤后只剩相关结果，自动选中第一个，方便快速看图
      var first = $('#marketList li');
      if (input.value.trim() && first) showDetailKeepFocus(first.dataset.code, input);
    };
    input.onkeydown = function (e) {
      if (e.key === 'Enter') { var li = $('#marketList li'); if (li) showDetail(li.dataset.code); }
      else if (e.key === 'Escape') { input.value = ''; state.marketFilter = ''; renderMarketList(); }
    };
  }
  // 选中个股但不夺走搜索框焦点
  function showDetailKeepFocus(code, input) {
    state.currentCode = code;
    renderDetail('#detailView', code);
    $all('#marketList li').forEach(function (li) { li.classList.toggle('active', li.dataset.code === code); });
    if (input) input.focus();
  }

	  // ---------- 公式板块（分组 + 搜索） ----------
	  // 每个公式带 group 分类；用户新建的公式持久化到 localStorage
	  var BUILTIN_FORMULAS = [
	    { name: '均线金叉', desc: 'MA5 上穿 MA20', group: '趋势', code: 'MA5 := MA(C,5);\nMA20 := MA(C,20);\nXG: CROSS(MA5, MA20);' },
	    { name: '回踩均线', desc: '价格靠近20日线且趋势向上', group: '趋势', code: 'MA20 := MA(C,20);\nXG: C > MA20 AND C < MA20*1.03 AND MA20 > REF(MA20,5);' },
	    { name: '放量突破', desc: '收盘创20日新高且放量', group: '突破', code: 'XG: C >= HHV(C,20) AND V > MA(V,5)*1.5;' },
	    { name: '连续放量', desc: '近3日量能递增', group: '量能', code: 'XG: V > REF(V,1) AND REF(V,1) > REF(V,2);' },
	    { name: 'MACD金叉', desc: 'DIF 上穿 DEA', group: '指标', code: 'DIF := EMA(C,12) - EMA(C,26);\nDEA := EMA(DIF,9);\nXG: CROSS(DIF, DEA);' },
	    { name: 'KDJ低位金叉', desc: 'K 上穿 D 且处低位', group: '指标', code: 'RSV := (C - LLV(L,9)) / (HHV(H,9) - LLV(L,9)) * 100;\nK := SMA(RSV,3,1);\nD := SMA(K,3,1);\nXG: CROSS(K, D) AND K < 35;' }
	  ];
	  function customFormulas() {
	    return load('costock.formulas', []);
	  }
	  function allFormulas() {
	    var custom = customFormulas();  // [{name,desc,group,code}]
	    return BUILTIN_FORMULAS.map(function (f, i) {
	      return Object.assign({}, f, { custom: false, key: 'builtin:' + i });
	    }).concat(custom.map(function (f, i) {
	      return Object.assign({}, f, { custom: true, key: 'custom:' + i, customIndex: i });
	    }));
	  }
	  function getFormulaByKey(key) {
	    var list = allFormulas();
	    for (var i = 0; i < list.length; i += 1) {
	      if (list[i].key === key) return list[i];
	    }
	    return list[0] || null;
	  }
	  function updateFormulaEditorState() {
	    var f = getFormulaByKey(state.activeFormulaKey);
	    var meta = $('#formulaActiveMeta');
	    var saveBtn = $('#formulaSaveBtn');
	    var delBtn = $('#formulaDeleteBtn');
	    if (meta) {
	      meta.textContent = f ? ((f.custom ? '自建' : '内置') + ' · ' + (f.group || '未分类') + ' · ' + f.name) : '未选择公式';
	    }
	    if (saveBtn) {
	      saveBtn.disabled = !$('#formulaEditor');
	      saveBtn.textContent = f && !f.custom ? '另存' : '保存';
	      saveBtn.title = f && !f.custom ? '将当前公式保存为自建公式' : '保存当前自建公式';
	    }
	    if (delBtn) {
	      delBtn.disabled = !(f && f.custom);
	      delBtn.title = f && f.custom ? '删除当前自建公式' : '内置公式不可删除';
	    }
	  }
	  function selectFormulaByKey(key, options) {
	    var f = getFormulaByKey(key);
	    if (!f) return;
	    state.activeFormulaKey = f.key;
	    var editor = $('#formulaEditor');
	    if (editor) editor.value = f.code || '';
	    renderFormulaList();
	    updateFormulaEditorState();
	    if (!options || options.run !== false) runFormula();
	  }
	  function formulaGroupList() {
    var gs = {};
    allFormulas().forEach(function (f) { gs[f.group || '未分类'] = 1; });
    return Object.keys(gs);
  }
  function renderFormulaGroups() {
    var box = $('#formulaGroups'); if (!box) return;
    var tabs = ['全部'].concat(formulaGroupList());
    var all = allFormulas();
    box.innerHTML = tabs.map(function (g) {
      var count = g === '全部' ? all.length : all.filter(function (f) { return (f.group||'未分类') === g; }).length;
      return '<span class="watch-group ' + (g === state.formulaGroup ? 'active' : '') + '" data-fgroup="' + g + '">' + g + '<span class="wg-count">' + count + '</span></span>';
    }).join('');
    $all('[data-fgroup]', box).forEach(function (el) {
      el.onclick = function () { state.formulaGroup = el.dataset.fgroup; renderFormulaList(); };
    });
  }
  function renderFormulaList() {
    renderFormulaGroups();
    var ul = $('#formulaTemplates');
    var list = allFormulas();
    if (state.formulaGroup !== '全部') list = list.filter(function (f) { return (f.group||'未分类') === state.formulaGroup; });
    var kw = state.formulaFilter.trim().toLowerCase();
    if (kw) list = list.filter(function (f) { return f.name.toLowerCase().indexOf(kw) >= 0 || (f.desc||'').toLowerCase().indexOf(kw) >= 0; });
    $('#formulaCount').textContent = allFormulas().length + ' 个';
	    if (!list.length) { ul.innerHTML = '<li class="empty-tip" style="padding:20px">无匹配公式</li>'; return; }
	    ul.innerHTML = list.map(function (t) {
	      return '<li data-fkey="' + esc(t.key) + '" class="' + (t.key === state.activeFormulaKey ? 'active' : '') + '">' +
	        '<span class="tpl-name">' + esc(t.name) + (t.custom?' <span class="tag" style="font-size:9px">自建</span>':'') + '</span>' +
	        '<span class="tpl-desc">' + esc(t.desc||'') + '</span></li>';
	    }).join('');
	    $all('li[data-fkey]', ul).forEach(function (li) {
	      li.onclick = function () {
	        selectFormulaByKey(li.dataset.fkey);
	      };
	    });
	  }
	  function saveFormulaAsNew(defaultName, defaultGroup) {
	    askText({ title: '保存公式', label: '公式名称', value: defaultName || '', placeholder: '例如：放量突破' }).then(function (name) {
	      if (!name || !name.trim()) return;
	      askText({
	        title: '公式分组',
	        label: '所属分组',
	        value: defaultGroup || (state.formulaGroup === '全部' ? '自建' : state.formulaGroup),
	        placeholder: '趋势 / 突破 / 量能 / 指标'
	      }).then(function (group) {
	        var groupName = group && group.trim() ? group.trim() : '自建';
	        var custom = customFormulas();
	        custom.push({ name: name.trim(), desc: '自建公式', group: groupName, code: $('#formulaEditor').value });
	        save('costock.formulas', custom);
	        state.formulaGroup = groupName;
	        state.activeFormulaKey = 'custom:' + (custom.length - 1);
	        renderFormulaList();
	        updateFormulaEditorState();
	        checkFormula();
	        toast('已保存公式「' + name.trim() + '」');
	      });
	    });
	  }
	  function saveActiveFormula() {
	    var f = getFormulaByKey(state.activeFormulaKey);
	    if (!f || !f.custom) {
	      saveFormulaAsNew(f ? f.name + ' 副本' : '', f && f.group ? f.group : '');
	      return;
	    }
	    var custom = customFormulas();
	    if (typeof f.customIndex !== 'number' || !custom[f.customIndex]) {
	      saveFormulaAsNew(f.name, f.group || '自建');
	      return;
	    }
	    custom[f.customIndex] = Object.assign({}, custom[f.customIndex], { code: $('#formulaEditor').value });
	    save('costock.formulas', custom);
	    renderFormulaList();
	    updateFormulaEditorState();
	    checkFormula();
	    toast('已保存公式「' + f.name + '」');
	  }
	  function deleteActiveFormula() {
	    var f = getFormulaByKey(state.activeFormulaKey);
	    if (!f || !f.custom) {
	      toast('内置公式不可删除');
	      return;
	    }
	    askConfirm({
	      title: '删除公式',
	      message: '删除自建公式「' + f.name + '」？',
	      okLabel: '删除'
	    }).then(function (ok) {
	      if (!ok) return;
	      var custom = customFormulas();
	      if (typeof f.customIndex === 'number') custom.splice(f.customIndex, 1);
	      save('costock.formulas', custom);
	      state.activeFormulaKey = 'builtin:0';
	      state.formulaGroup = '全部';
	      selectFormulaByKey(state.activeFormulaKey, { run: false });
	      checkFormula();
	      toast('已删除公式');
	    });
	  }
	  function setupFormula() {
	    var sel = $('#formulaTestStock');
	    updateFormulaTestStocks();
	    sel.onchange = runFormula;
	    $('#formulaEditor').value = BUILTIN_FORMULAS[0].code;
	    $('#formulaEditor').oninput = updateFormulaEditorState;
	    $('#formulaSaveBtn').onclick = saveActiveFormula;
	    $('#formulaDeleteBtn').onclick = deleteActiveFormula;
	    $('#formulaCheckBtn').onclick = checkFormula;
	    $('#formulaRunBtn').onclick = runFormula;
	    // 搜索 + 新建
	    var inp = $('#formulaSearch');
	    if (inp) inp.oninput = function () { state.formulaFilter = inp.value; renderFormulaList(); inp.focus(); };
	    var newBtn = $('#formulaNewBtn');
	    if (newBtn) newBtn.onclick = function () {
	      saveFormulaAsNew('', state.formulaGroup === '全部' ? '自建' : state.formulaGroup);
	    };
	    var impBtn = $('#formulaImport');
	    if (impBtn) impBtn.onclick = openFormulaImport;
	    setupFormulaImportModal();
	    renderFormulaList();
	    updateFormulaEditorState();
	  }
	  function updateFormulaTestStocks() {
	    var sel = $('#formulaTestStock');
	    if (!sel) return;
	    var current = sel.value;
	    var quotes = D.listStocks();
	    sel.innerHTML = quotes.map(function (q) { return '<option value="' + q.code + '">' + q.name + ' ' + q.code + '</option>'; }).join('');
	    var preferred = current && D.getStock(current)
	      ? current
	      : (state.currentCode && D.getStock(state.currentCode) ? state.currentCode : (quotes[0] && quotes[0].code));
	    if (preferred) sel.value = preferred;
	  }

  // ---------- 公式批量导入 ----------
  // 解析多条公式：支持 "名称: 公式体" 单行；或 "===名称===" 分隔的多行公式块
  function parseFormulaImport(text) {
    var items = [];
    if (/^\s*===/m.test(text)) {
      // ===名称=== 分隔
      var blocks = text.split(/^===\s*(.+?)\s*===\s*$/m);
      // split 结果：[前导, name1, body1, name2, body2, ...]
      for (var i = 1; i < blocks.length; i += 2) {
        var name = (blocks[i] || '').trim();
        var body = (blocks[i + 1] || '').trim();
        if (name && body) items.push({ name: name, code: body });
      }
    } else {
      // 逐行 "名称: 公式体"
      text.split(/\r?\n/).forEach(function (line) {
        line = line.trim(); if (!line) return;
        var m = line.match(/^([^:：]{1,20})[:：]\s*(.+)$/);
        if (m) items.push({ name: m[1].trim(), code: m[2].trim() });
        else items.push({ name: '导入公式' + (items.length + 1), code: line });
      });
    }
    // 校验每条
    return items.map(function (it) {
      var v = F.validate(it.code);
      return { name: it.name, code: it.code, ok: v.ok, error: v.error };
    });
  }
  function openFormulaImport() {
    var sel = $('#fImportGroup');
    var groups = ['自建'].concat(formulaGroupList());
    sel.innerHTML = groups.filter(function (v, i, a) { return a.indexOf(v) === i; }).map(function (g) { return '<option value="' + g + '">' + g + '</option>'; }).join('');
    if (state.formulaGroup !== '全部') sel.value = state.formulaGroup;
    $('#fImportText').value = '';
    $('#fImportPreview').innerHTML = '';
    $('#fImportMask').classList.add('show');
    setTimeout(function () { $('#fImportText').focus(); }, 50);
  }
  function closeFormulaImport() { $('#fImportMask').classList.remove('show'); }
  function setupFormulaImportModal() {
    $('#fImportClose').onclick = closeFormulaImport;
    $('#fImportMask').onclick = function (e) { if (e.target === $('#fImportMask')) closeFormulaImport(); };
    $('#fImportMask').onkeydown = function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeFormulaImport();
      }
    };
    $('#fImportParse').onclick = function () { renderFormulaImportPreview(parseFormulaImport($('#fImportText').value)); };
    $('#fImportConfirm').onclick = function () {
      var items = parseFormulaImport($('#fImportText').value).filter(function (x) { return x.ok; });
      if (!items.length) { toast('没有语法正确的公式可导入'); return; }
	      var group = $('#fImportGroup').value || '自建';
	      var custom = customFormulas();
	      items.forEach(function (it) {
	        custom.push({ name: it.name, desc: '导入公式', group: group, code: it.code });
	      });
	      save('costock.formulas', custom);
	      closeFormulaImport();
	      state.formulaGroup = group;
	      state.activeFormulaKey = 'custom:' + (custom.length - items.length);
	      renderFormulaList();
	      updateFormulaEditorState();
	      toast('成功导入 ' + items.length + ' 条公式');
	    };
  }
  function renderFormulaImportPreview(items) {
    var box = $('#fImportPreview');
    var okN = items.filter(function (x) { return x.ok; }).length;
    var badN = items.length - okN;
    box.innerHTML = '<div class="ip-summary">可导入 <b>' + okN + '</b> 条' + (badN ? '，语法错误 <b>' + badN + '</b> 条' : '') + '</div>' +
      items.map(function (it) {
        return '<span class="' + (it.ok ? 'ip-ok' : 'ip-bad') + '" title="' + (it.ok ? '' : it.error) + '">' + it.name + (it.ok ? '' : ' ✗') + '</span>';
      }).join('');
  }
  function checkFormula() {
    var v = F.validate($('#formulaEditor').value);
    var st = $('#formulaStatus');
    if (v.ok) { st.className = 'formula-status up'; st.textContent = '✓ 语法正确'; }
    else { st.className = 'formula-status down'; st.textContent = '✗ ' + v.error; }
  }
  function runFormula() {
    var src = $('#formulaEditor').value;
    var code = $('#formulaTestStock').value;
    var st = $('#formulaStatus'), out = $('#formulaResult');
    try {
      var stock = D.getStock(code);
      if (!stock) throw new Error('未找到测试标的');
      var r = F.run(src, D.getKLines(code));
      st.className = 'formula-status up'; st.textContent = '✓ 运行成功';
      var rows = Object.keys(r.last).map(function (k) {
        var val = r.last[k];
        var disp = (val === 1 || val === 0) && (k === r.xgName) ? (val ? '满足 ✓' : '不满足') : (val == null ? '-' : (typeof val === 'number' ? val.toFixed(3) : val));
        return '<tr><td style="padding:4px 16px 4px 0;color:#8a93a6">' + k + (k===r.xgName?' (选股)':'') + '</td><td style="font-variant-numeric:tabular-nums">' + disp + '</td></tr>';
      }).join('');
      out.innerHTML =
        '<p style="margin-bottom:10px">测试标的：<b>' + stock.quote.name + ' ' + code + '</b>　最新公式末值：</p>' +
        '<table style="border-collapse:collapse">' + rows + '</table>' +
        '<p style="margin-top:14px;color:' + (r.xg?'#e0443e':'#8a93a6') + '">选股判定：' + (r.xg ? '★ 当前标的满足公式条件' : '当前标的不满足') + '</p>' +
        '<p class="muted" style="margin-top:8px">提示：到「选股」板块用此公式可扫描全市场。</p>';
    } catch (e) {
      st.className = 'formula-status down'; st.textContent = '✗ ' + e.message;
      out.innerHTML = '<p class="down">运行错误：' + e.message + '</p>';
    }
  }

  // ---------- 选股板块 ----------
  var BUILTIN = [
    { id: 'chg', label: '当日涨幅 ≥', val: 3, unit: '%' },
    { id: 'drop', label: '当日跌幅 ≤', val: -3, unit: '%' },
    { id: 'maUp', label: '收盘价站上 MA', val: 20, unit: '日均线' },
    { id: 'maDown', label: '收盘价跌破 MA', val: 20, unit: '日均线' },
    { id: 'volR', label: '成交量 ≥ MA5量 ×', val: 1.5, unit: '倍' },
    { id: 'turnover', label: '换手率 ≥', val: 3, unit: '%' },
    { id: 'marketCap', label: '总市值 ≥', val: 1000, unit: '亿' },
    { id: 'peMax', label: 'PE ≤', val: 30, unit: '' },
    { id: 'pbMax', label: 'PB ≤', val: 5, unit: '' },
    { id: 'macdGold', label: 'MACD 金叉', val: null, unit: '', hint: '无参数' },
    { id: 'macdDead', label: 'MACD 死叉', val: null, unit: '', hint: '无参数' },
    { id: 'kdjGold', label: 'KDJ 金叉', val: null, unit: '', hint: '无参数' },
    { id: 'kdjDead', label: 'KDJ 死叉', val: null, unit: '', hint: '无参数' },
    { id: 'newHigh', label: '创 N 日新高', val: 20, unit: '日' },
    { id: 'newLow', label: '创 N 日新低', val: 20, unit: '日' }
  ];
  function strategyId() {
    return 'screen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }
  function builtinDefaultValue(id) {
    var hit = BUILTIN.filter(function (item) { return item.id === id; })[0];
    return hit ? hit.val : null;
  }
  function setScreenMode(mode) {
    var next = mode === 'formula' ? 'formula' : 'builtin';
    $all('input[name="screenMode"]').forEach(function (r) { r.checked = r.value === next; });
    $('#builtinConditions').classList.toggle('hidden', next !== 'builtin');
    $('#formulaCondition').classList.toggle('hidden', next !== 'formula');
  }
  function currentScreenCriteria() {
    var mode = $('input[name="screenMode"]:checked').value;
    if (mode === 'formula') return { mode: 'formula', formula: $('#screenFormula').value };
    var conds = {};
    $all('[data-cond]').forEach(function (cb) {
      if (!cb.checked) return;
      var inp = $('[data-input="' + cb.dataset.cond + '"]');
      conds[cb.dataset.cond] = inp ? parseFloat(inp.value) : true;
    });
    return { mode: 'builtin', conditions: conds };
  }
  function applyScreenCriteria(criteria) {
    var c = criteria || {};
    setScreenMode(c.mode);
    if (c.mode === 'formula') {
      if (c.formula != null) $('#screenFormula').value = c.formula;
      return;
    }
    var conds = c.conditions || {};
    $all('[data-cond]').forEach(function (cb) {
      var has = Object.prototype.hasOwnProperty.call(conds, cb.dataset.cond);
      cb.checked = has;
      var inp = $('[data-input="' + cb.dataset.cond + '"]');
      if (inp) inp.value = has ? conds[cb.dataset.cond] : builtinDefaultValue(cb.dataset.cond);
      var body = $('[data-body="' + cb.dataset.cond + '"]');
      if (body) body.classList.toggle('disabled', !has);
    });
  }
  function renderScreenStrategies() {
    var sel = $('#screenStrategySelect');
    var del = $('#screenStrategyDelete');
    if (!sel) return;
    sel.innerHTML = '<option value="">未保存策略</option>' + state.screeningStrategies.map(function (s) {
      return '<option value="' + esc(s.id) + '">' + esc(s.name || s.id) + '</option>';
    }).join('');
    sel.value = state.screenStrategyId || '';
    if (del) del.disabled = !state.screenStrategyId;
  }
  function selectedScreenStrategy() {
    return state.screeningStrategies.filter(function (s) { return s.id === state.screenStrategyId; })[0] || null;
  }
  function saveScreenStrategy() {
    var criteria = currentScreenCriteria();
    if (criteria.mode === 'builtin' && !Object.keys(criteria.conditions || {}).length) {
      toast('请先勾选至少一个选股条件');
      return;
    }
    if (criteria.mode === 'formula') {
      var validation = F.validate(criteria.formula);
      if (!validation.ok) { toast('公式错误：' + validation.error); return; }
    }
    var existing = selectedScreenStrategy();
    return askText({
      title: existing ? '重命名并保存策略' : '保存选股策略',
      label: '策略名称',
      value: existing ? existing.name : (criteria.mode === 'formula' ? '公式选股策略' : '条件选股策略')
    }).then(function (name) {
      if (!name || !name.trim()) return;
      var item = {
        id: existing ? existing.id : strategyId(),
        name: name.trim(),
        type: criteria.mode,
        criteria: clone(criteria),
        updatedAt: Date.now(),
        createdAt: existing ? existing.createdAt : Date.now()
      };
      if (existing) {
        state.screeningStrategies = state.screeningStrategies.map(function (s) { return s.id === existing.id ? item : s; });
      } else {
        state.screeningStrategies.push(item);
      }
      state.screenStrategyId = item.id;
      save('costock.screeningStrategies', state.screeningStrategies);
      renderScreenStrategies();
      toast('已保存策略「' + item.name + '」');
    });
  }
  function loadScreenStrategy(id) {
    var item = state.screeningStrategies.filter(function (s) { return s.id === id; })[0];
    if (!item) {
      state.screenStrategyId = '';
      renderScreenStrategies();
      return;
    }
    state.screenStrategyId = item.id;
    applyScreenCriteria(item.criteria);
    renderScreenStrategies();
    toast('已载入策略「' + item.name + '」');
  }
  function deleteScreenStrategy() {
    var item = selectedScreenStrategy();
    if (!item) { toast('请先选择策略'); return; }
    askConfirm({
      title: '删除选股策略',
      message: '删除策略「' + item.name + '」？',
      okLabel: '删除'
    }).then(function (confirmed) {
      if (!confirmed) return;
      state.screeningStrategies = state.screeningStrategies.filter(function (s) { return s.id !== item.id; });
      state.screenStrategyId = '';
      save('costock.screeningStrategies', state.screeningStrategies);
      renderScreenStrategies();
      toast('已删除策略');
    });
  }
  function setupScreener() {
    var box = $('#builtinConditions');
    box.innerHTML = BUILTIN.map(function (c) {
      var body = c.val === null
        ? '<div class="cond-body disabled" data-body="' + c.id + '">（' + (c.hint || '无参数') + '）</div>'
        : '<div class="cond-body disabled" data-body="' + c.id + '"><input type="number" step="0.1" value="' + c.val + '" data-input="' + c.id + '"/> ' + c.unit + '</div>';
      return '<div class="cond-item">' +
        '<label class="cond-title"><input type="checkbox" data-cond="' + c.id + '"/> ' + c.label + '</label>' + body + '</div>';
    }).join('');
    $all('[data-cond]', box).forEach(function (cb) {
      cb.onchange = function () {
        var body = $('[data-body="' + cb.dataset.cond + '"]', box);
        if (body) body.classList.toggle('disabled', !cb.checked);
      };
    });
    $all('input[name="screenMode"]').forEach(function (r) {
      r.onchange = function () {
        if (!r.checked) return;
        state.screenStrategyId = '';
        setScreenMode(r.value);
        renderScreenStrategies();
      };
    });
    var strategySelect = $('#screenStrategySelect');
    if (strategySelect) strategySelect.onchange = function () { loadScreenStrategy(strategySelect.value); };
    var saveStrategyBtn = $('#screenStrategySave');
    if (saveStrategyBtn) saveStrategyBtn.onclick = saveScreenStrategy;
    var delStrategyBtn = $('#screenStrategyDelete');
    if (delStrategyBtn) delStrategyBtn.onclick = deleteScreenStrategy;
    $('#runScreenBtn').onclick = runScreen;
    // 结果过滤搜索
    var sInput = $('#screenSearch');
    if (sInput) sInput.oninput = function () { state.screenFilter = sInput.value; renderScreenResults(state.lastScreenResults || []); sInput.focus(); };
    // 默认勾选涨幅+金叉
    $('[data-cond="macdGold"]').checked = true;
    $('[data-body="macdGold"]').classList.toggle('disabled', false);
    renderScreenStrategies();
  }
  function runScreen() {
    var criteria = currentScreenCriteria();
    var mode = criteria.mode;
    var results = [];
    var ind = window.CoStockIndicator;
    var codes = D.allCodes();
    var status = $('#screenStatus');
    var runMeta = clone(criteria);
    if (state.screenStrategyId) runMeta.strategyId = state.screenStrategyId;

    if (mode === 'formula') {
      var src = criteria.formula;
      var v = F.validate(src);
      if (!v.ok) { status.textContent = '公式错误: ' + v.error; status.className = 'down'; return; }
      codes.forEach(function (code) {
        try {
          var r = F.run(src, D.getKLines(code));
          if (r.xg) { var q = D.getQuote(code); results.push({ q: q, reasons: ['命中公式 ' + (r.xgName||'XG')] }); }
        } catch (e) {}
      });
    } else {
      var conds = criteria.conditions || {};
      if (!Object.keys(conds).length) { status.textContent = '请至少勾选一个条件'; status.className = 'down'; return; }
      codes.forEach(function (code) {
        var stock = D.getStock(code), q = stock.quote, kl = stock.klines;
        var closes = ind.closes(kl), vols = ind.vols(kl);
        var n = closes.length - 1;
        var reasons = [], pass = true;
        if ('chg' in conds) { if (q.changePercent >= conds.chg) reasons.push('涨幅' + q.changePercent.toFixed(2) + '%'); else pass = false; }
        if (pass && 'drop' in conds) { if (q.changePercent <= conds.drop) reasons.push('跌幅' + q.changePercent.toFixed(2) + '%'); else pass = false; }
        if (pass && 'maUp' in conds) { var ma = ind.MA(closes, conds.maUp); var last = ma[n]; if (last != null && q.price > last) reasons.push('站上MA' + conds.maUp); else pass = false; }
        if (pass && 'maDown' in conds) { var maDown = ind.MA(closes, conds.maDown); var maDownLast = maDown[n]; if (maDownLast != null && q.price < maDownLast) reasons.push('跌破MA' + conds.maDown); else pass = false; }
        if (pass && 'volR' in conds) { var mav = ind.MA(vols, 5); var lv = mav[n]; if (lv != null && q.volume >= lv * conds.volR) reasons.push('放量' + (q.volume/lv).toFixed(1) + '倍'); else pass = false; }
        if (pass && 'turnover' in conds) { if (q.turnoverRate != null && q.turnoverRate >= conds.turnover) reasons.push('换手' + q.turnoverRate.toFixed(2) + '%'); else pass = false; }
        if (pass && 'marketCap' in conds) { if (q.marketCap != null && q.marketCap >= conds.marketCap * 1e8) reasons.push('总市值' + fmtCap(q.marketCap)); else pass = false; }
        if (pass && 'peMax' in conds) { if (q.pe != null && q.pe <= conds.peMax) reasons.push('PE ' + q.pe.toFixed(2)); else pass = false; }
        if (pass && 'pbMax' in conds) { if (q.pb != null && q.pb <= conds.pbMax) reasons.push('PB ' + q.pb.toFixed(2)); else pass = false; }
        if (pass && ('macdGold' in conds || 'macdDead' in conds)) {
          var m = ind.MACD(closes);
          if (pass && 'macdGold' in conds) { if (m.dif[n]!=null && m.dea[n]!=null && m.dif[n-1]!=null && m.dea[n-1]!=null && m.dif[n-1]<=m.dea[n-1] && m.dif[n]>m.dea[n]) reasons.push('MACD金叉'); else pass = false; }
          if (pass && 'macdDead' in conds) { if (m.dif[n]!=null && m.dea[n]!=null && m.dif[n-1]!=null && m.dea[n-1]!=null && m.dif[n-1]>=m.dea[n-1] && m.dif[n]<m.dea[n]) reasons.push('MACD死叉'); else pass = false; }
        }
        if (pass && ('kdjGold' in conds || 'kdjDead' in conds)) {
          var kdj = ind.KDJ(kl);
          if (pass && 'kdjGold' in conds) { if (kdj.k[n]!=null && kdj.d[n]!=null && kdj.k[n-1]!=null && kdj.d[n-1]!=null && kdj.k[n-1]<=kdj.d[n-1] && kdj.k[n]>kdj.d[n]) reasons.push('KDJ金叉'); else pass = false; }
          if (pass && 'kdjDead' in conds) { if (kdj.k[n]!=null && kdj.d[n]!=null && kdj.k[n-1]!=null && kdj.d[n-1]!=null && kdj.k[n-1]>=kdj.d[n-1] && kdj.k[n]<kdj.d[n]) reasons.push('KDJ死叉'); else pass = false; }
        }
        if (pass && 'newHigh' in conds) { var hh = ind.HHV(closes, conds.newHigh); if (q.price >= hh[n]) reasons.push('创' + conds.newHigh + '日新高'); else pass = false; }
        if (pass && 'newLow' in conds) { var ll = ind.LLV(closes, conds.newLow); if (q.price <= ll[n]) reasons.push('创' + conds.newLow + '日新低'); else pass = false; }
        if (pass) results.push({ q: q, reasons: reasons });
      });
    }
    renderScreenResults(results);
    saveScreeningRun(runMeta, results, codes.length);
    status.className = 'muted';
    status.textContent = '扫描 ' + codes.length + ' 只，命中 ' + results.length + ' 只';
  }
  function compactScreenResults(results, limit) {
    return (results || []).slice(0, limit || 200).map(function (r) {
      var q = r.q || {};
      return {
        code: q.code,
        name: q.name,
        price: q.price,
        changePercent: q.changePercent,
        marketCap: q.marketCap,
        pe: q.pe,
        pb: q.pb,
        reasons: (r.reasons || []).slice()
      };
    });
  }
  function saveScreeningRun(criteria, results, scanned) {
    var compact = compactScreenResults(results, 200);
    var run = {
      at: Date.now(),
      criteria: clone(criteria || {}),
      scanned: scanned || 0,
      matched: results.length,
      results: compact.slice(0, 80)
    };
    save('costock.screeningResults', compact);
    var history = load('costock.screeningHistory', []);
    history.push(run);
    save('costock.screeningHistory', history.slice(-20));
  }
  function renderScreenResults(results) {
    state.lastScreenResults = results;
    var ul = $('#screenResults'), empty = $('#screenEmpty');
    $('#screenResultCount').textContent = '(' + results.length + ')';
    // 结果内搜索过滤
    var kw = (state.screenFilter || '').trim().toLowerCase();
    var shown = kw ? results.filter(function (r) { return r.q.code.indexOf(kw) >= 0 || r.q.name.toLowerCase().indexOf(kw) >= 0; }) : results;
    if (!results.length) { ul.innerHTML = ''; empty.classList.remove('hidden'); empty.textContent = '无符合条件的股票，试试放宽条件'; return; }
    if (!shown.length) { ul.innerHTML = ''; empty.classList.remove('hidden'); empty.textContent = '没有匹配「' + kw + '」的结果'; return; }
    empty.classList.add('hidden');
    ul.innerHTML = shown.map(function (r) {
      var q = r.q, c = cls(q.changePercent);
      return '<li data-code="' + q.code + '">' +
        '<span class="col-star"><span class="star-btn ' + (inWatch(q.code)?'on':'') + '" data-star="' + q.code + '">' + (inWatch(q.code)?'★':'☆') + '</span></span>' +
        '<span class="col-code">' + q.code + '</span>' +
        '<span class="col-sname">' + q.name + '</span>' +
        '<span class="col-rprice ' + c + '">' + fmtNum(q.price) + '</span>' +
        '<span class="col-rchg ' + c + '">' + fmtPct(q.changePercent) + '</span>' +
        '<span class="col-reason">' + r.reasons.map(function (x){ return '<span class="tag hit">' + x + '</span>'; }).join('') + '</span>' +
        '<span class="col-act"><button class="btn" data-plan="' + q.code + '">计划</button><button class="btn" data-view="' + q.code + '">查看</button></span>' +
        '</li>';
    }).join('');
    $all('[data-star]', ul).forEach(function (s) {
      s.onclick = function (e) { e.stopPropagation(); toggleWatch(s.dataset.star); s.classList.toggle('on'); s.textContent = inWatch(s.dataset.star)?'★':'☆'; };
    });
    $all('[data-view]', ul).forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); switchPanel('market'); showDetail(b.dataset.view); };
    });
    $all('[data-plan]', ul).forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var hit = shown.filter(function (r) { return r.q.code === b.dataset.plan; })[0];
        createTradePlan(b.dataset.plan, { source: 'screener', reasons: hit ? hit.reasons : [] });
      };
    });
    $all('li', ul).forEach(function (li) { li.onclick = function () { switchPanel('market'); showDetail(li.dataset.code); }; });
  }

  // ---------- 研究计划（本地计划，不下单） ----------
  function tradePlanId() {
    return 'plan-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }
  function planStatusLabel(status) {
    if (status === 'done') return '已完成';
    if (status === 'archived') return '已归档';
    return '观察中';
  }
  function planSourceLabel(source) {
    if (source === 'screener') return '选股结果';
    if (source === 'ai') return 'AI 研究';
    return '个股详情';
  }
  function createTradePlan(code, options) {
    var stock = D.getStock(code);
    if (!stock) { toast('未找到标的'); return; }
    var opts = options || {};
    var q = stock.quote;
    var ind = indicatorSummary(code);
    var reasons = (opts.reasons && opts.reasons.length ? opts.reasons : ['手动观察']).slice(0, 6);
    var ma20 = ind.ma20 || q.low;
    var stopLine = Math.max(0.01, Math.min(q.low, ma20) * 0.985);
    var entryLow = Math.max(0.01, Math.min(q.price, ma20 || q.price) * 0.995);
    var entryHigh = Math.max(entryLow, q.price * 1.015);
    var target = q.price * (q.changePercent >= 0 ? 1.05 : 1.035);
    var existing = state.tradePlans.filter(function (p) { return p.code === code && p.status !== 'archived'; })[0];
    var now = Date.now();
    var plan = {
      id: existing ? existing.id : tradePlanId(),
      code: code,
      name: q.name || stock.name || code,
      industry: stock.industry || '',
      market: stock.market || '',
      status: 'watching',
      source: opts.source || 'detail',
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      quote: {
        price: q.price,
        changePercent: q.changePercent,
        turnoverRate: q.turnoverRate,
        amount: q.amount,
        marketCap: q.marketCap,
        pe: q.pe,
        pb: q.pb,
      },
      thesis: reasons.join('；') + '。结合当前' + currentDataLabel() + '，先作为观察计划，不构成操作指令。',
      entryZone: [entryLow, entryHigh],
      stopLine: stopLine,
      targetPrice: target,
      checklist: [
        '观察价格是否维持在 MA20 附近或重新站上短期均线',
        '确认成交额和换手率没有明显萎缩',
        '若来自选股结果，复查命中条件是否连续两日保持',
        '盘中异动只记录，不自动触发任何外部操作'
      ],
      invalidation: [
        '跌破计划失效线且无法快速收回',
        '放量下跌并跌破主要均线',
        '行业或个股出现新的重大风险信息'
      ],
      reasons: reasons
    };
    if (existing) {
      state.tradePlans = state.tradePlans.map(function (p) { return p.id === existing.id ? plan : p; });
    } else {
      state.tradePlans.unshift(plan);
    }
    saveTradePlans();
    state.currentPlanId = plan.id;
    switchPanel('plans');
    toast(existing ? '已更新研究计划' : '已生成研究计划');
  }
  function saveTradePlans() {
    save('costock.tradePlans', state.tradePlans);
    renderPlanList();
  }
  function activePlan() {
    return state.tradePlans.filter(function (p) { return p.id === state.currentPlanId; })[0] || state.tradePlans[0] || null;
  }
  function renderPlanList() {
    var ul = $('#planList');
    var empty = $('#planEmpty');
    var count = $('#planCount');
    if (!ul) return;
    var kw = (state.planFilter || '').trim().toLowerCase();
    var plans = state.tradePlans.slice();
    if (kw) plans = plans.filter(function (p) {
      return String(p.code || '').indexOf(kw) >= 0 ||
        String(p.name || '').toLowerCase().indexOf(kw) >= 0 ||
        planSourceLabel(p.source).toLowerCase().indexOf(kw) >= 0;
    });
    if (count) count.textContent = state.tradePlans.length + ' 条';
    if (!state.currentPlanId && state.tradePlans[0]) state.currentPlanId = state.tradePlans[0].id;
    if (!plans.length) {
      ul.innerHTML = '';
      if (empty) { empty.classList.remove('hidden'); empty.innerHTML = kw ? '没有匹配「' + esc(kw) + '」的计划' : '暂无研究计划<br/><span class="muted">在个股详情或选股结果中生成</span>'; }
      var detail = $('#planDetailView');
      if (detail) detail.innerHTML = '<div class="empty-tip">' + (kw ? '没有匹配的研究计划' : '暂无研究计划') + '<br/><span class="muted">从个股详情或选股结果生成</span></div>';
      return;
    }
    if (empty) empty.classList.add('hidden');
    ul.innerHTML = plans.map(function (p) {
      return '<li data-plan-id="' + esc(p.id) + '" class="' + (p.id === state.currentPlanId ? 'active' : '') + '">' +
        '<span class="plan-row-main">' +
          '<span class="plan-row-title"><span class="plan-row-name">' + esc(p.name) + '</span><span class="plan-status">' + esc(planStatusLabel(p.status)) + '</span></span>' +
          '<span class="plan-row-meta">' + esc(p.code) + ' · ' + esc(planSourceLabel(p.source)) + ' · ' + esc(fmtTime(p.updatedAt)) + '</span>' +
        '</span>' +
      '</li>';
    }).join('');
    $all('[data-plan-id]', ul).forEach(function (li) {
      li.onclick = function () {
        state.currentPlanId = li.dataset.planId;
        renderPlanList();
      };
    });
    renderPlanDetail();
  }
  function renderPlanDetail() {
    var box = $('#planDetailView');
    if (!box) return;
    var p = activePlan();
    if (!p) {
      box.innerHTML = '<div class="empty-tip">暂无研究计划<br/><span class="muted">从个股资料卡或选股结果生成</span></div>';
      return;
    }
    var c = cls(p.quote && p.quote.changePercent);
    box.innerHTML = '<div class="plan-detail">' +
      '<div class="plan-detail-head">' +
        '<div class="plan-detail-title">' +
          '<h2>' + esc(p.name) + ' <span class="dh-code">' + esc(p.code) + '</span></h2>' +
          '<p>' + esc(planSourceLabel(p.source)) + ' · ' + esc(planStatusLabel(p.status)) + ' · 更新 ' + esc(fmtTime(p.updatedAt)) + '</p>' +
        '</div>' +
        '<div class="plan-actions">' +
          '<button class="btn" data-plan-open="' + esc(p.code) + '">打开个股</button>' +
          '<button class="btn" data-plan-toggle="' + esc(p.id) + '">' + (p.status === 'done' ? '设为观察' : '标记完成') + '</button>' +
          '<button class="btn" data-plan-delete="' + esc(p.id) + '">删除</button>' +
        '</div>' +
      '</div>' +
      '<div class="plan-grid">' +
        planMetric('现价', fmtNum(p.quote && p.quote.price), c) +
        planMetric('观察区间', fmtNum(p.entryZone && p.entryZone[0]) + ' - ' + fmtNum(p.entryZone && p.entryZone[1]), '') +
        planMetric('失效线', fmtNum(p.stopLine), 'down') +
        planMetric('目标观察', fmtNum(p.targetPrice), 'up') +
      '</div>' +
      planSection('计划逻辑', '<p>' + esc(p.thesis) + '</p>' + reasonTags(p.reasons)) +
      planSection('观察清单', listHtml(p.checklist)) +
      planSection('失效条件', listHtml(p.invalidation) + '<p class="plan-note">这是研究计划，不是订单；只用于观察复盘，不构成操作建议。</p>') +
    '</div>';
    var open = $('[data-plan-open]', box); if (open) open.onclick = function () { switchPanel('market'); showDetail(open.dataset.planOpen); };
    var toggle = $('[data-plan-toggle]', box); if (toggle) toggle.onclick = function () { togglePlanStatus(toggle.dataset.planToggle); };
    var del = $('[data-plan-delete]', box); if (del) del.onclick = function () { deletePlan(del.dataset.planDelete); };
  }
  function planMetric(label, value, c) {
    return '<div class="plan-metric"><span>' + esc(label) + '</span><b class="' + (c || '') + '">' + esc(value) + '</b></div>';
  }
  function planSection(title, body) {
    return '<div class="plan-section"><h3>' + esc(title) + '</h3>' + body + '</div>';
  }
  function reasonTags(reasons) {
    return '<p style="margin-top:8px">' + (reasons || []).map(function (r) { return '<span class="tag hit">' + esc(r) + '</span>'; }).join('') + '</p>';
  }
  function listHtml(items) {
    return '<ul>' + (items || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  }
  function togglePlanStatus(id) {
    state.tradePlans = state.tradePlans.map(function (p) {
      if (p.id !== id) return p;
      var next = clone(p);
      next.status = p.status === 'done' ? 'watching' : 'done';
      next.updatedAt = Date.now();
      return next;
    });
    saveTradePlans();
  }
  function deletePlan(id) {
    var p = state.tradePlans.filter(function (item) { return item.id === id; })[0];
    if (!p) return;
    askConfirm({
      title: '删除研究计划',
      message: '删除「' + p.name + '」研究计划？',
      okLabel: '删除'
    }).then(function (confirmed) {
      if (!confirmed) return;
      state.tradePlans = state.tradePlans.filter(function (item) { return item.id !== id; });
      if (state.currentPlanId === id) state.currentPlanId = state.tradePlans[0] ? state.tradePlans[0].id : null;
      saveTradePlans();
      toast('已删除研究计划');
    });
  }
  function setupPlans() {
    var search = $('#planSearch');
    if (search) search.oninput = function () { state.planFilter = search.value; renderPlanList(); search.focus(); };
    var btn = $('#planNewCurrent');
    if (btn) btn.onclick = function () {
      var code = aiContextCode() || state.currentCode;
      if (!code) { toast('请先选择个股'); return; }
      createTradePlan(code, { source: 'detail', reasons: ['从当前个股生成'] });
    };
    renderPlanList();
  }

  // ---------- AI 智库（Codex） ----------
  var aiRuntimeState = {
    source: 'codex-unavailable',
    backendEnabled: false,
    backendConnected: false,
    dataConnected: false,
    appServerRunning: false,
    appServerOrigin: '',
    dataLabel: '本地/缓存数据',
    dataInjected: false,
    codexSandbox: '',
    localhostDataGatewayReachable: false,
    readableTools: [],
    settings: {
      configured: false,
      hasApiKey: false,
      hasBaseUrl: false,
      baseUrl: ''
    }
  };
  var submitAiPrompt = null;
  function updateAiRuntime(meta) {
    var status = D.getStatus ? D.getStatus() : null;
    var next = Object.assign({}, aiRuntimeState, meta || {});
    next.dataConnected = meta && 'dataConnected' in meta ? !!meta.dataConnected : !!(status && status.connected);
    next.dataLabel = currentDataLabel();
    aiRuntimeState = next;
    renderAiRuntime();
  }
  function renderAiRuntime() {
    var box = $('#aiRuntime');
    if (!box) return;
    var backendUp = aiRuntimeState.backendEnabled || aiRuntimeState.source === 'codex-exec' || aiRuntimeState.backendConnected;
    var dataReady = !!(aiRuntimeState.dataInjected || aiRuntimeState.appServerRunning);
    var chips = [
      {
        label: backendUp ? 'Codex已就绪' : 'Codex未就绪',
        cls: backendUp ? 'up' : '',
        title: backendUp ? 'AI 回复通过 Codex 生成' : '请在 AI 设置中配置 API Key、Base URL，并确认 Codex 可执行'
      },
      {
        label: dataReady ? '已接入当前数据' : '数据未接入',
        cls: dataReady ? 'up' : 'down',
        title: dataReady
          ? 'Codex 会结合行情、自选股、公式、选股结果和研究计划'
          : '当前应用数据尚未进入 Codex 上下文'
      }
    ];
    box.innerHTML = chips.map(function (chip) {
      return '<span class="ai-runtime-chip ' + chip.cls + '" title="' + esc(chip.title) + '">' + esc(chip.label) + '</span>';
    }).join('');
  }
  function refreshAiRuntime() {
    var aiBridge = window.costockBridge && window.costockBridge.ai;
    var aiPromise = aiBridge && aiBridge.getStatus
      ? aiBridge.getStatus().catch(function () { return null; })
      : Promise.resolve(null);
    return aiPromise.then(function (status) {
      var backend = status && status.backend ? status.backend : {};
      var appServer = status && status.appServer ? status.appServer : {};
      updateAiRuntime({
        source: backend.source || aiRuntimeState.source,
        backendEnabled: !!backend.enabled,
        dataInjected: !!backend.dataInjection,
        codexSandbox: backend.sandbox || '',
        localhostDataGatewayReachable: !!backend.localhostDataGatewayReachable,
        appServerRunning: !!appServer.running,
        appServerOrigin: appServer.origin || '',
        readableTools: Array.isArray(status && status.readableTools) ? status.readableTools : [],
        settings: status && status.settings ? status.settings : aiRuntimeState.settings
      });
      return status;
    });
  }
  function applyAiMessageMeta(msg, meta) {
    var role = $('.ai-role', msg);
    if (!role) return;
    role.textContent = 'AI';
  }
  function aiHistory() {
    return load('costock.aiHistory', []);
  }
  function saveAiHistory(items) {
    save('costock.aiHistory', items.slice(-30));
  }
  function saveAiTurn(prompt, reply, meta) {
    var items = aiHistory();
    items.push({
      at: Date.now(),
      panel: state.panel,
      code: aiContextCode(),
      prompt: prompt,
      reply: reply,
      source: meta && meta.source,
      connected: !!(meta && meta.connected),
      backendConnected: !!(meta && meta.backendConnected),
      dataConnected: !!(meta && meta.dataConnected),
      appServerRunning: !!(meta && meta.appServerRunning)
    });
    saveAiHistory(items);
    save('costock.aiConsensus', {
      at: Date.now(),
      panel: state.panel,
      code: aiContextCode(),
      summary: reply.slice(0, 240),
      source: meta && meta.source,
      connected: !!(meta && meta.connected),
      backendConnected: !!(meta && meta.backendConnected),
      dataConnected: !!(meta && meta.dataConnected),
      appServerRunning: !!(meta && meta.appServerRunning)
    });
  }
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
      updatedAt: q.updatedAt
    };
  }
  function klineWindow(code, limit) {
    return D.getKLines(code).slice(-limit).map(function (k) {
      return {
        timestamp: k.timestamp,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
        amount: k.amount
      };
    });
  }
  function intradayWindow(code, limit) {
    if (!D.getIntraday) return [];
    return D.getIntraday(code, { points: limit }).slice(-limit).map(function (p) {
      return {
        timestamp: p.timestamp,
        timeLabel: p.timeLabel,
        price: p.price,
        avg: p.avg,
        volume: p.volume,
        amount: p.amount,
        preClose: p.preClose,
        source: p.source
      };
    });
  }
  function indicatorSummary(code) {
    var ind = window.CoStockIndicator;
    var kl = D.getKLines(code);
    if (!Array.isArray(kl) || !kl.length) return {};
    var closes = ind.closes(kl), vols = ind.vols(kl), n = closes.length - 1;
    var ma5 = ind.MA(closes, 5)[n];
    var ma10 = ind.MA(closes, 10)[n];
    var ma20 = ind.MA(closes, 20)[n];
    var ma60 = ind.MA(closes, 60)[n];
    var macd = ind.MACD(closes);
    var rsi14 = ind.RSI(closes, 14)[n];
    var volMa5 = ind.MA(vols, 5)[n];
    return {
      ma5: ma5,
      ma10: ma10,
      ma20: ma20,
      ma60: ma60,
      trend: ma5 != null && ma20 != null ? (ma5 > ma20 ? 'MA5 在 MA20 上方' : 'MA5 在 MA20 下方') : null,
      macdDif: macd.dif[n],
      macdDea: macd.dea[n],
      macdValue: macd.macd[n],
      macdState: macd.dif[n] != null && macd.dea[n] != null ? (macd.dif[n] > macd.dea[n] ? 'DIF 在 DEA 上方' : 'DIF 在 DEA 下方') : null,
      rsi14: rsi14,
      volumeRatio5: volMa5 ? vols[n] / volMa5 : null
    };
  }
  function buildAiContextSnapshot(prompt) {
    var code = aiContextCode();
    var stock = code ? D.getStock(code) : null;
    var formulaSource = $('#formulaEditor') ? $('#formulaEditor').value : '';
    var validation = formulaSource ? F.validate(formulaSource) : null;
    var marketStatus = D.getStatus ? D.getStatus() : { connected: false, source: 'mock', note: '本地/缓存数据' };
    var relevantCodes = {};
    if (code) relevantCodes[code] = true;
    state.watch.slice(0, 80).forEach(function (c) { relevantCodes[c] = true; });
    state.tradePlans.slice(-30).forEach(function (p) { if (p && p.code) relevantCodes[p.code] = true; });
    (state.lastScreenResults || []).slice(0, 60).forEach(function (r) {
      var q = r && r.q;
      if (q && q.code) relevantCodes[q.code] = true;
    });
    var marketQuotes = D.listStocks().filter(function (q) {
      return q && (relevantCodes[q.code] || Math.abs(Number(q.changePercent) || 0) >= 7);
    }).slice(0, 120).map(compactQuote);
    return {
      prompt: prompt,
      dataStatus: {
        marketDataConnected: !!marketStatus.connected,
        source: marketStatus.source,
        provider: marketStatus.provider,
        updatedAt: marketStatus.updatedAt,
        count: marketStatus.count,
        klineCount: marketStatus.klineCount,
        intradayCount: marketStatus.intradayCount,
        note: marketStatus.note || (marketStatus.connected ? '真实/延迟数据' : '本地/缓存数据')
      },
      panel: state.panel,
      currentCode: code,
      stock: stock ? { code: stock.code, name: stock.name, market: stock.market, industry: stock.industry } : null,
      quote: stock ? compactQuote(stock.quote) : null,
      marketQuotes: marketQuotes,
      klines: code ? klineWindow(code, Math.min(state.bars || 120, 250)) : [],
      intraday: code ? intradayWindow(code, 240) : [],
      indicators: code ? indicatorSummary(code) : {},
      watchlist: {
        codes: state.watch.slice(),
        groups: JSON.parse(JSON.stringify(state.watchGroups || {})),
        currentGroup: state.watchGroup
      },
      formula: {
        currentSource: formulaSource,
        validation: validation,
        builtins: BUILTIN_FORMULAS,
        all: allFormulas()
      },
      screener: {
        strategies: state.screeningStrategies.slice(),
        lastResults: compactScreenResults(state.lastScreenResults || [], 40),
        persistedResults: load('costock.screeningResults', []).slice(0, 40),
        history: load('costock.screeningHistory', []).slice(-5)
      },
      researchPlans: state.tradePlans.slice(-30),
      currentResearchPlan: state.panel === 'plans' ? activePlan() : null,
      history: aiHistory().slice(-12),
      consensus: load('costock.aiConsensus', null),
      dataAccess: {
        appServerRunning: aiRuntimeState.appServerRunning,
        appServerOrigin: aiRuntimeState.appServerOrigin,
        readableTools: aiRuntimeState.readableTools.slice(),
        writeAccess: false
      },
      userState: {
        watch: state.watch.slice(),
        watchGroups: clone(state.watchGroups || defaultWatchGroups),
        formulas: allFormulas(),
        screeningStrategies: state.screeningStrategies.slice(),
        screeningResultCount: load('costock.screeningResults', []).length,
        screeningHistoryCount: load('costock.screeningHistory', []).length,
        researchPlanCount: state.tradePlans.length,
        aiHistoryCount: aiHistory().length,
        hasConsensus: !!load('costock.aiConsensus', null)
      },
      permissions: {
        readableTools: aiRuntimeState.readableTools.length
          ? aiRuntimeState.readableTools.slice()
          : ['market_quote', 'market_klines', 'market_intraday', 'market_indicators', 'watchlist', 'formula_screener', 'builtin_screener'],
        writableTools: [],
        writeAccess: false
      }
    };
  }
  function minimalAiContextSnapshot(prompt) {
    var code = aiContextCode();
    var stock = code ? D.getStock(code) : null;
    var marketStatus = D.getStatus ? D.getStatus() : { connected: false, source: 'mock', note: '本地/缓存数据' };
    return {
      prompt: prompt,
      panel: state.panel,
      currentCode: code,
      dataStatus: {
        marketDataConnected: !!marketStatus.connected,
        source: marketStatus.source,
        provider: marketStatus.provider,
        updatedAt: marketStatus.updatedAt,
        count: marketStatus.count,
        klineCount: marketStatus.klineCount,
        intradayCount: marketStatus.intradayCount,
        note: marketStatus.note || (marketStatus.connected ? '真实/延迟数据' : '本地/缓存数据')
      },
      stock: stock ? { code: stock.code, name: stock.name, market: stock.market, industry: stock.industry } : null,
      quote: stock ? compactQuote(stock.quote) : null,
      userState: {
        watch: state.watch.slice(),
        watchGroups: clone(state.watchGroups || defaultWatchGroups),
        formulas: allFormulas()
      },
      dataAccess: {
        appServerRunning: aiRuntimeState.appServerRunning,
        readableTools: aiRuntimeState.readableTools.slice(),
        writeAccess: false
      },
      permissions: {
        readableTools: aiRuntimeState.readableTools.length ? aiRuntimeState.readableTools.slice() : ['market_quote', 'market_klines', 'market_intraday', 'watchlist', 'formulas', 'screener_results', 'research_plans'],
        writableTools: [],
        writeAccess: false
      }
    };
  }
  function codexUnavailableMeta(context) {
    var ctx = context || {};
    var dataStatus = ctx.dataStatus || {};
    return {
      source: 'codex-unavailable',
      ok: false,
      connected: false,
      backendConnected: false,
      dataConnected: dataStatus.marketDataConnected != null ? !!dataStatus.marketDataConnected : !!(D.getStatus && D.getStatus().connected),
      appServerRunning: !!aiRuntimeState.appServerRunning,
      dataInjected: !!aiRuntimeState.dataInjected,
      readableTools: aiRuntimeState.readableTools.slice()
    };
  }
  function codexUnavailableText(context) {
    var ctx = context || {};
    var userState = ctx.userState || {};
    var watchlist = ctx.watchlist || {};
    var codes = Array.isArray(watchlist.codes) ? watchlist.codes : (Array.isArray(userState.watch) ? userState.watch : []);
    var formulas = Array.isArray(userState.formulas)
      ? userState.formulas
      : (ctx.formula && Array.isArray(ctx.formula.all) ? ctx.formula.all : []);
    var dataStatus = ctx.dataStatus || {};
    var connected = dataStatus.marketDataConnected != null ? dataStatus.marketDataConnected : !!(D.getStatus && D.getStatus().connected);
    return '本次已准备当前应用数据：行情、自选股' + (codes.length ? ' ' + codes.length + ' 只' : '') + '、公式' + (formulas.length ? ' ' + formulas.length + ' 条' : '') + '、选股结果和研究计划。' +
      (connected ? '当前行情为真实/延迟数据。' : '当前行情为本地/缓存数据。') +
      ' Codex 未就绪，请在 AI 设置中检查 API Key 和 Base URL，或确认 Codex 可执行。';
  }
  function stockAiPrompt(code) {
    var q = code ? D.getQuote(code) : null;
    return q
      ? '请基于当前行情、K线、指标、自选股、公式和研究计划，分析 ' + q.name + ' ' + code + ' 的观察重点和风险。'
      : '请基于当前行情、自选股、公式和选股结果，概括今天需要优先观察的内容。';
  }
  function quickAiPrompt() {
    if (state.panel === 'formula') return '请基于当前公式编辑器内容，解释公式逻辑、校验风险，并说明如何用于选股。';
    if (state.panel === 'screener') return '请基于当前选股条件和最近一次选股结果，归纳命中特征、风险点和后续观察重点。';
    if (state.panel === 'plans') return '请基于当前研究计划，复盘观察区间、失效线、风险点和后续需要验证的数据。';
    return stockAiPrompt(aiContextCode());
  }
  function typeText(el, text, done) {
    text = String(text || '');
    var startedAt = Date.now();
    var charsPerMs = 2 / 18;
    var timer = setInterval(function () {
      var idx = Math.floor((Date.now() - startedAt) * charsPerMs);
      el.textContent = text.slice(0, idx);
      el.parentElement.parentElement.scrollTop = el.parentElement.parentElement.scrollHeight;
      if (idx >= text.length) { clearInterval(timer); el.classList.remove('ai-typing'); el.textContent = text; done && done(); }
    }, 18);
  }
  function expandAiDock() {
    var dock = $('#aiDock');
    var fab = $('#aiFab');
    if (dock) dock.classList.remove('collapsed');
    if (fab) fab.classList.remove('show');
    state.aiOpen = true;
    updateAiContext();
    refreshCharts();
  }
  function setupAiDock() {
    function collapse() {
      var dock = $('#aiDock');
      var fab = $('#aiFab');
      if (dock) dock.classList.add('collapsed');
      if (fab) fab.classList.add('show');
      state.aiOpen = false;
      refreshCharts();
    }
    function expand() {
      expandAiDock();
    }
    var collapseBtn = $('#aiCollapse');
    var fabBtn = $('#aiFab');
    if (collapseBtn) collapseBtn.onclick = collapse;
    if (fabBtn) fabBtn.onclick = expand;
    function ask(value) {
      var input = $('#aiAsk');
      var v = String(value != null ? value : (input ? input.value : '')).trim();
      if (!v) return;
      var stream = $('#aiStream'); clearAiEmpty();
      var u = document.createElement('div'); u.className = 'ai-msg user'; u.innerHTML = '<div class="ai-text"></div>';
      $('.ai-text', u).textContent = v;
      stream.appendChild(u);
      var a = document.createElement('div'); a.className = 'ai-msg'; a.innerHTML = '<div class="ai-role">AI</div><div class="ai-text ai-typing"></div>';
      stream.appendChild(a);
      applyAiMessageMeta(a, aiRuntimeState);
      var context;
      try {
        context = buildAiContextSnapshot(v);
      } catch (err) {
        context = minimalAiContextSnapshot(v);
      }
      var payload = { prompt: v, context: context };
      var bridge = window.costockBridge && window.costockBridge.aiChat;
      if (!bridge) {
        var unavailableMeta = codexUnavailableMeta(context);
        var unavailableText = codexUnavailableText(context);
        applyAiMessageMeta(a, unavailableMeta);
        updateAiRuntime(unavailableMeta);
        typeText($('.ai-text', a), unavailableText);
        saveAiTurn(v, unavailableText, unavailableMeta);
        if (input) input.value = '';
        return;
      }
      Promise.resolve().then(function () {
        return bridge(payload);
      }).then(function (res) {
        var meta = res || codexUnavailableMeta(context);
        var reply = res && res.text ? String(res.text) : codexUnavailableText(context);
        applyAiMessageMeta(a, meta);
        updateAiRuntime(meta);
        typeText($('.ai-text', a), reply);
        saveAiTurn(v, reply, meta);
      }).catch(function () {
        var errMeta = codexUnavailableMeta(context);
        var errText = codexUnavailableText(context);
        applyAiMessageMeta(a, errMeta);
        updateAiRuntime(errMeta);
        typeText($('.ai-text', a), errText);
        saveAiTurn(v, errText, errMeta);
      }).finally(function () {
        if (input) input.value = '';
      });
    }
    submitAiPrompt = ask;
    $('#aiAnalyzeBtn').onclick = function () { ask(quickAiPrompt()); };
    $('#aiAskBtn').onclick = ask;
    $('#aiAsk').onkeydown = function (e) { if (e.key === 'Enter') ask(); };
    updateAiContext();
    refreshAiRuntime();
  }
  function clearAiEmpty() { var e = $('#aiStream .ai-empty'); if (e) e.remove(); }
  function refreshCharts() {
    if (state.panel === 'market') redrawDetail();
    else if (state.panel === 'watch' && state.watchCurrentCode) drawCharts(state.watchCurrentCode, '#watchDetailView');
  }

  // AI 面板的上下文：根据当前板块决定"分析对象"和按钮文案
  function aiContextCode() {
    if (state.panel === 'watch') return state.watchCurrentCode;
    if (state.panel === 'plans') {
      var plan = activePlan();
      return plan ? plan.code : state.currentCode;
    }
    return state.currentCode; // market/formula/screener 都用行情当前股
  }
  function updateAiContext() {
    var ctxEl = $('#aiContext'); var btn = $('#aiAnalyzeBtn'); var ask = $('#aiAsk');
    if (!ctxEl) return;
    if (state.panel === 'formula') {
      ctxEl.innerHTML = '公式 · 辅助编写/解释';
      if (btn) btn.title = '解释当前公式'; ask.placeholder = '帮我写一个选股公式…';
    } else if (state.panel === 'screener') {
      ctxEl.innerHTML = '选股 · 解读结果';
      if (btn) btn.title = '解读选股结果'; ask.placeholder = '这批结果有什么共性？';
    } else if (state.panel === 'plans') {
      var plan = activePlan();
      ctxEl.innerHTML = plan ? ('计划 · <b>' + plan.name + ' ' + plan.code + '</b>') : '计划 · 复盘';
      if (btn) btn.title = '复盘当前计划'; ask.placeholder = '这份计划的风险点是什么？';
    } else {
      var code = aiContextCode();
      var q = code ? D.getQuote(code) : null;
      ctxEl.innerHTML = q ? ('分析对象 · <b>' + q.name + ' ' + code + '</b>') : '未选择个股';
      if (btn) btn.title = '快速分析个股'; ask.placeholder = '发消息…';
    }
  }

  // ---------- 通用：所有板块左侧列表 可拖拽调宽 + 可收起 ----------
  function savedSideWidths() {
    return load('costock.sideWidths', {});
  }
  function applySavedSideWidths() {
    var widths = savedSideWidths();
    $all('.panel').forEach(function (panel) {
      var name = panel.dataset.panel;
      var sidebar = panel.querySelector('.sidebar');
      var width = widths[name];
      if (!sidebar || !width) return;
      sidebar.style.width = width + 'px';
    });
  }
  function setupSidebars() {
    var widths = savedSideWidths();   // { market: 280, watch: 320, ... }
    $all('.panel').forEach(function (panel) {
      var name = panel.dataset.panel;
      var sidebar = panel.querySelector('.sidebar');
      if (!sidebar) return;

      // 恢复保存的宽度
      if (widths[name]) sidebar.style.width = widths[name] + 'px';

      // 折叠按钮
      var head = sidebar.querySelector('.sidebar-head');
      var label = head ? head.textContent.trim().replace(/\s+\d+.*$/, '') : '列表';
      if (head && !head.querySelector('.side-collapse')) {
        var btn = document.createElement('button');
        btn.className = 'side-collapse'; btn.title = '收起列表'; btn.textContent = '⟨';
        head.appendChild(btn);
        btn.onclick = function () { setCollapsed(true); };
      }
      // 拖拽手柄
      if (!sidebar.querySelector('.side-resizer')) {
        var rez = document.createElement('div'); rez.className = 'side-resizer';
        sidebar.appendChild(rez);
        bindResize(rez, sidebar, name, widths);
      }
      // 收起后的窄轨
      var rail = panel.querySelector('.side-rail');
      if (!rail) {
        rail = document.createElement('div'); rail.className = 'side-rail';
        rail.innerHTML = '⟩<span class="rail-label">' + label + '</span>';
        sidebar.parentNode.insertBefore(rail, sidebar.nextSibling);
        rail.onclick = function () { setCollapsed(false); };
      }
      function setCollapsed(v) {
        sidebar.classList.toggle('collapsed', v);
        rail.classList.toggle('show', v);
        requestAnimationFrame(function () { refreshCharts(); });
      }
    });
  }
  function bindResize(handle, sidebar, name, widths) {
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      handle.classList.add('dragging');
      var startX = e.clientX, startW = sidebar.offsetWidth;
      function onMove(ev) {
        var w = Math.max(180, Math.min(520, startW + ev.clientX - startX));
        sidebar.style.width = w + 'px';
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        widths[name] = sidebar.offsetWidth; save('costock.sideWidths', widths);
        refreshCharts();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---------- 时钟 ----------
  function tickClock() {
    var d = new Date();
    function p(n){ return n<10?'0'+n:n; }
    $('#clock').textContent = p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
  }

  // ---------- 初始化 ----------
  function init() {
    if (window.costockBridge && window.costockBridge.platform) {
      var platformClass = 'platform-' + window.costockBridge.platform;
      document.documentElement.classList.add(platformClass);
      document.body.classList.add(platformClass);
    }
    initMarketSource();
    setupMarketImport();
    setupMarketAutoRefresh();
    $all('.tab').forEach(function (t) { t.onclick = function () { switchPanel(t.dataset.tab); }; });
    document.addEventListener('keydown', function (e) {
      if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      if (e.key === '1') switchPanel('market');
      if (e.key === '2') switchPanel('watch');
      if (e.key === '3') switchPanel('formula');
      if (e.key === '4') switchPanel('screener');
      if (e.key === '5') switchPanel('plans');
    });
    renderMarketList();
    showDetail(D.allCodes()[0]);
    setupSearch();
    setupTextPromptModal();
    setupDataStatusModal();
    setupAiSettingsModal();
    setupFormula();
    setupScreener();
    setupPlans();
    setupAiDock();
    setupSidebars();
    setupWatchControls();
    syncUserState();
    tickClock(); setInterval(tickClock, 1000);
    window.addEventListener('resize', function () {
      if (state.panel === 'market') redrawDetail();
      if (state.panel === 'watch' && state.watchCurrentCode) drawCharts(state.watchCurrentCode, '#watchDetailView');
    });
  }
  document.addEventListener('DOMContentLoaded', init);
})();
