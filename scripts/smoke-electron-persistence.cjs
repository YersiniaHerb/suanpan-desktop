const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { resolveCommandBin } = require('../electron/codex-cli.cjs');

const ROOT = path.join(__dirname, '..');

function resolveElectronBin() {
  const local = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  if (fs.existsSync(local)) return local;
  const resolved = resolveCommandBin({
    command: 'electron',
    env: process.env,
    explicitEnvName: 'ELECTRON_BIN',
    notFoundMessage: 'Electron executable not found. Install project dependencies or provide ELECTRON_BIN.',
  });
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.bin;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(1000, () => req.destroy(new Error(`Timed out: ${url}`)));
    req.on('error', reject);
  });
}

async function waitForTargets(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (err) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Electron remote debugging target was not ready');
}

function connectCdp(wsUrl) {
  if (typeof WebSocket !== 'function') {
    throw new Error('Node WebSocket global is unavailable; use Node 22+ or set up a CDP-capable smoke runner');
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params: params || {} }));
          return new Promise((res, rej) => pending.set(id, { res, rej, method }));
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id || !pending.has(msg.id)) return;
      const item = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) item.rej(new Error(`${item.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
      else item.res(msg.result);
    });
    ws.addEventListener('error', reject);
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const ex = result.exceptionDetails.exception;
    throw new Error((ex && (ex.description || ex.value)) || result.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return result.result ? result.result.value : undefined;
}

async function waitForEval(cdp, expression, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await evaluate(cdp, expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for expression: ${expression}`);
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      resolve();
    }
    child.once('exit', finish);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      finish();
    }, 1500).unref();
  });
}

async function launchElectron(userDataDir) {
  const port = await findFreePort();
  const child = spawn(resolveElectronBin(), [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`, '.'], {
    cwd: ROOT,
    env: {
      ...process.env,
      COSTOCK_CODEX_BACKEND: 'local',
      COSTOCK_WINDOW_WIDTH: '1280',
      COSTOCK_WINDOW_HEIGHT: '840',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const target = await waitForTargets(port, 15000);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await waitForEval(cdp, `document.readyState === 'complete' && !!document.querySelector('.main-chart')`, 15000);
  await waitForEval(cdp, `(() => {
    const refresh = document.querySelector('#refreshMarketBtn');
    const refreshAll = document.querySelector('#refreshAllMarketBtn');
    const badge = document.querySelector('#dataBadge');
    return refresh && refreshAll && badge &&
      refresh.textContent.trim() === '刷新行情' &&
      refreshAll.textContent.trim() === '全A' &&
      !badge.classList.contains('loading');
  })()`, 30000);
  await waitForEval(cdp, `(() => {
    const D = window.CoStockData;
    const status = D && D.getStatus ? D.getStatus() : null;
    return status && status.connected && status.count >= 20;
  })()`, 10000);

  return {
    child,
    cdp,
  };
}

async function closeSession(session) {
  if (!session) return;
  if (session.cdp) session.cdp.close();
  await stopChild(session.child);
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'costock-electron-persist-'));
  let first = null;
  let second = null;
  try {
	    first = await launchElectron(userDataDir);
	    const created = await evaluate(first.cdp, `(async () => {
	      function delay(ms) {
	        return new Promise((resolve) => setTimeout(resolve, ms));
	      }
	      async function waitFor(fn, label) {
	        const started = Date.now();
	        while (Date.now() - started < 8000) {
	          const value = fn();
	          if (value) return value;
	          await delay(50);
	        }
	        throw new Error('Timed out waiting for ' + label);
	      }
	      document.querySelector('[data-tab="market"]').click();
	      const targetRow = await waitFor(() => {
	        const rows = Array.from(document.querySelectorAll('#marketList li[data-code]'));
	        return rows.find((row) => row.dataset.code === '600519') || rows[0] || null;
	      }, 'market row');
	      const targetCode = targetRow.dataset.code;
	      targetRow.click();
	      const starSelector = '[data-star="' + targetCode + '"]';
	      const star = await waitFor(() => document.querySelector(starSelector), 'detail star');
	      await waitFor(() => document.querySelector('[data-card-plan]'), 'detail plan button');
	      if (star.textContent.trim() !== '★') star.click();
	      const freshPlanBtn = await waitFor(() => document.querySelector('[data-card-plan]'), 'fresh detail plan button');
	      freshPlanBtn.click();
	      const watch = JSON.parse(localStorage.getItem('costock.watch') || '[]');
	      const freshStar = document.querySelector(starSelector);
	      return {
	        ok: true,
	        code: targetCode,
	        watchOn: watch.indexOf(targetCode) >= 0 && freshStar && freshStar.textContent.trim() === '★',
	        planCount: document.querySelector('#planCount') ? document.querySelector('#planCount').textContent.trim() : ''
	      };
	    })()`);
    assert.strictEqual(created.ok, true);
    assert.ok(/^\d{6}$/.test(created.code), JSON.stringify(created));
    assert.strictEqual(created.watchOn, true);
    assert.ok(/1 条/.test(created.planCount), created.planCount);
    const createdCode = created.code;

    const uiStateCreated = await evaluate(first.cdp, `(async () => {
      function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }
      async function waitFor(fn, label) {
        const started = Date.now();
        while (Date.now() - started < 6000) {
          const value = fn();
          if (value) return value;
          await delay(50);
        }
        throw new Error('Timed out waiting for ' + label);
      }
      document.querySelector('[data-tab="market"]').click();
      const sidebar = await waitFor(() => document.querySelector('[data-panel="market"] .sidebar'), 'market sidebar');
      const handle = await waitFor(() => sidebar.querySelector('.side-resizer'), 'market sidebar resizer');
      const startRect = sidebar.getBoundingClientRect();
      const targetWidth = Math.max(340, Math.min(460, Math.round(startRect.width + 48)));
      const startX = Math.round(startRect.right - 1);
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: startX }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: startX + targetWidth - Math.round(startRect.width) }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: startX + targetWidth - Math.round(startRect.width) }));
      const marketSort = document.querySelector('#marketSort');
      const marketSortDir = document.querySelector('#marketSortDir');
      marketSort.value = 'amount';
      marketSort.dispatchEvent(new Event('change', { bubbles: true }));
      if (marketSortDir.textContent.trim() !== '↑') marketSortDir.click();
      await waitFor(() => {
        const sideWidths = JSON.parse(localStorage.getItem('costock.sideWidths') || '{}');
        const sort = JSON.parse(localStorage.getItem('costock.marketSort') || '{}');
        return sideWidths.market >= 340 && sort.key === 'amount' && sort.dir === 'asc';
      }, 'local ui state');
      const sideWidths = JSON.parse(localStorage.getItem('costock.sideWidths') || '{}');
      const marketSortState = JSON.parse(localStorage.getItem('costock.marketSort') || '{}');
      return {
        marketWidth: sideWidths.market,
        domWidth: Math.round(sidebar.getBoundingClientRect().width),
        marketSort: marketSortState
      };
    })()`);
    assert.ok(uiStateCreated.marketWidth >= 340, JSON.stringify(uiStateCreated));
    assert.ok(Math.abs(uiStateCreated.domWidth - uiStateCreated.marketWidth) <= 2, JSON.stringify(uiStateCreated));
    assert.deepStrictEqual(uiStateCreated.marketSort, { key: 'amount', dir: 'asc' });

    await evaluate(first.cdp, `(() => {
      const input = document.querySelector('#aiAsk');
      input.value = '请用当前数据生成一个本地共识摘要';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#aiAskBtn').click();
    })()`);

    const localResearchState = await evaluate(first.cdp, `(async () => {
      function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }
      async function waitFor(fn, label) {
        const started = Date.now();
        while (Date.now() - started < 6000) {
          const value = fn();
          if (value) return value;
          await delay(50);
        }
        throw new Error('Timed out waiting for ' + label);
      }
      function fillPrompt(value) {
        const input = document.querySelector('#promptInput');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#promptOk').click();
      }
      function storageArray(key) {
        return JSON.parse(localStorage.getItem(key) || '[]');
      }

      document.querySelector('[data-tab="formula"]').click();
      await waitFor(() => document.querySelector('#formulaEditor'), 'formula editor');
      document.querySelector('#formulaEditor').value = 'XG: C > REF(C,1);';
      document.querySelector('#formulaNewBtn').click();
      await waitFor(() => {
        const mask = document.querySelector('#promptMask');
        const title = document.querySelector('#promptTitle');
        return mask && mask.classList.contains('show') && title && title.textContent.trim() === '保存公式';
      }, 'formula name prompt');
      fillPrompt('Smoke公式');
      await waitFor(() => {
        const mask = document.querySelector('#promptMask');
        const title = document.querySelector('#promptTitle');
        return mask && mask.classList.contains('show') && title && title.textContent.trim() === '公式分组';
      }, 'formula group prompt');
      fillPrompt('自建Smoke');
      await waitFor(() => storageArray('costock.formulas').some((item) => item.name === 'Smoke公式'), 'saved formula');

      document.querySelector('[data-tab="screener"]').click();
      await waitFor(() => document.querySelector('#runScreenBtn') && document.querySelector('[data-cond="chg"]'), 'screener controls');
      document.querySelectorAll('[data-cond]').forEach((box) => {
        if (box.checked) box.click();
      });
      const chg = document.querySelector('[data-cond="chg"]');
      if (!chg.checked) chg.click();
      const chgInput = document.querySelector('[data-input="chg"]');
      chgInput.value = '-100';
      chgInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#screenStrategySave').click();
      await waitFor(() => {
        const mask = document.querySelector('#promptMask');
        const title = document.querySelector('#promptTitle');
        return mask && mask.classList.contains('show') && title && title.textContent.trim() === '保存选股策略';
      }, 'strategy prompt');
      fillPrompt('Smoke选股策略');
      await waitFor(() => storageArray('costock.screeningStrategies').some((item) => item.name === 'Smoke选股策略'), 'saved strategy');
      document.querySelector('#runScreenBtn').click();
      await waitFor(() => {
        const results = storageArray('costock.screeningResults');
        const history = storageArray('costock.screeningHistory');
        return results.length > 0 && history.length > 0;
      }, 'screening run');

      return {
        formulaCount: storageArray('costock.formulas').length,
        strategyCount: storageArray('costock.screeningStrategies').length,
        screeningResultCount: storageArray('costock.screeningResults').length,
        screeningHistoryCount: storageArray('costock.screeningHistory').length
      };
    })()`);
    assert.strictEqual(localResearchState.formulaCount, 1);
    assert.strictEqual(localResearchState.strategyCount, 1);
    assert.ok(localResearchState.screeningResultCount > 0, JSON.stringify(localResearchState));
    assert.strictEqual(localResearchState.screeningHistoryCount, 1);

	    const persisted = await waitForEval(first.cdp, `(async () => {
	      const createdCode = ${JSON.stringify(createdCode)};
	      if (!window.costockBridge || !window.costockBridge.user) return null;
	      const status = await window.costockBridge.user.getStatus();
	      if (status.watchCount !== 1 || status.formulaCount !== 1 || status.screeningStrategyCount !== 1) return null;
	      if (status.screeningResultCount < 1 || status.screeningHistoryCount !== 1) return null;
	      if (status.tradePlanCount !== 1 || !status.hasConsensus) return null;
	      const state = await window.costockBridge.user.getState();
	      if (!state.tradePlans || state.tradePlans.length !== 1) return null;
	      if (!state.watch || state.watch.indexOf(createdCode) < 0) return null;
	      if (state.tradePlans[0].code !== createdCode) return null;
	      if (!state.formulas || !state.formulas.some((item) => item.name === 'Smoke公式')) return null;
	      if (!state.screeningStrategies || !state.screeningStrategies.some((item) => item.name === 'Smoke选股策略')) return null;
      if (!state.screeningResults || state.screeningResults.length < 1) return null;
      if (!state.screeningHistory || state.screeningHistory.length !== 1) return null;
      if (!state.aiConsensus || !state.aiConsensus.summary) return null;
      if (!state.marketSort || state.marketSort.key !== 'amount' || state.marketSort.dir !== 'asc') return null;
      if (!state.sideWidths || state.sideWidths.market < 340) return null;
      return {
        path: status.path,
        watchCount: status.watchCount,
        formulaCount: status.formulaCount,
        screeningStrategyCount: status.screeningStrategyCount,
        screeningResultCount: status.screeningResultCount,
        screeningHistoryCount: status.screeningHistoryCount,
        tradePlanCount: status.tradePlanCount,
        hasConsensus: status.hasConsensus,
        marketSort: state.marketSort,
        marketSidebarWidth: state.sideWidths.market,
        sideWidthCount: status.sideWidthCount,
        code: state.tradePlans[0].code,
        name: state.tradePlans[0].name,
        consensus: state.aiConsensus.summary
      };
    })()`, 12000);
    assert.strictEqual(persisted.watchCount, 1);
    assert.strictEqual(persisted.formulaCount, 1);
    assert.strictEqual(persisted.screeningStrategyCount, 1);
    assert.ok(persisted.screeningResultCount > 0);
	    assert.strictEqual(persisted.screeningHistoryCount, 1);
	    assert.strictEqual(persisted.tradePlanCount, 1);
	    assert.strictEqual(persisted.hasConsensus, true);
	    assert.deepStrictEqual(persisted.marketSort, { key: 'amount', dir: 'asc' });
	    assert.ok(persisted.marketSidebarWidth >= 340, JSON.stringify(persisted));
	    assert.ok(persisted.sideWidthCount >= 1, JSON.stringify(persisted));
	    assert.ok(persisted.path && fs.existsSync(persisted.path), persisted.path);
	    const rawState = JSON.parse(fs.readFileSync(persisted.path, 'utf8'));
	    assert.ok(rawState.watch.includes(createdCode));
	    assert.strictEqual(rawState.formulas.length, 1);
	    assert.strictEqual(rawState.screeningStrategies.length, 1);
	    assert.ok(rawState.screeningResults.length > 0);
	    assert.strictEqual(rawState.screeningHistory.length, 1);
	    assert.strictEqual(rawState.tradePlans.length, 1);
	    assert.strictEqual(rawState.tradePlans[0].code, createdCode);
    assert.ok(rawState.aiConsensus && rawState.aiConsensus.summary);
    assert.deepStrictEqual(rawState.marketSort, { key: 'amount', dir: 'asc' });
    assert.ok(rawState.sideWidths && rawState.sideWidths.market >= 340, JSON.stringify(rawState.sideWidths));

    const clearedLocalStorage = await evaluate(first.cdp, `(async () => {
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const key = localStorage.key(i);
        if (key && key.indexOf('costock.') === 0) localStorage.removeItem(key);
      }
      const remote = await window.costockBridge.user.getState();
      return {
        localWatch: localStorage.getItem('costock.watch'),
        localFormulas: localStorage.getItem('costock.formulas'),
        localStrategies: localStorage.getItem('costock.screeningStrategies'),
        localResults: localStorage.getItem('costock.screeningResults'),
        localHistory: localStorage.getItem('costock.screeningHistory'),
        localTradePlans: localStorage.getItem('costock.tradePlans'),
        localConsensus: localStorage.getItem('costock.aiConsensus'),
        localMarketSort: localStorage.getItem('costock.marketSort'),
        localSideWidths: localStorage.getItem('costock.sideWidths'),
        remoteWatch: remote.watch.length,
        remoteFormulas: remote.formulas.length,
        remoteStrategies: remote.screeningStrategies.length,
        remoteResults: remote.screeningResults.length,
        remoteHistory: remote.screeningHistory.length,
        remotePlans: remote.tradePlans.length,
        remoteHasConsensus: !!remote.aiConsensus,
        remoteMarketSort: remote.marketSort,
        remoteMarketSidebarWidth: remote.sideWidths && remote.sideWidths.market
      };
    })()`);
    assert.strictEqual(clearedLocalStorage.localWatch, null);
    assert.strictEqual(clearedLocalStorage.localFormulas, null);
    assert.strictEqual(clearedLocalStorage.localStrategies, null);
    assert.strictEqual(clearedLocalStorage.localResults, null);
    assert.strictEqual(clearedLocalStorage.localHistory, null);
    assert.strictEqual(clearedLocalStorage.localTradePlans, null);
    assert.strictEqual(clearedLocalStorage.localConsensus, null);
    assert.strictEqual(clearedLocalStorage.localMarketSort, null);
    assert.strictEqual(clearedLocalStorage.localSideWidths, null);
    assert.strictEqual(clearedLocalStorage.remoteWatch, 1);
    assert.strictEqual(clearedLocalStorage.remoteFormulas, 1);
    assert.strictEqual(clearedLocalStorage.remoteStrategies, 1);
    assert.ok(clearedLocalStorage.remoteResults > 0);
    assert.strictEqual(clearedLocalStorage.remoteHistory, 1);
    assert.strictEqual(clearedLocalStorage.remotePlans, 1);
    assert.strictEqual(clearedLocalStorage.remoteHasConsensus, true);
    assert.deepStrictEqual(clearedLocalStorage.remoteMarketSort, { key: 'amount', dir: 'asc' });
    assert.ok(clearedLocalStorage.remoteMarketSidebarWidth >= 340, JSON.stringify(clearedLocalStorage));
    await closeSession(first);
    first = null;

    second = await launchElectron(userDataDir);
    const rehydrated = await waitForEval(second.cdp, `(async () => {
      const remote = await window.costockBridge.user.getState();
      const status = await window.costockBridge.user.getStatus();
      const localWatch = JSON.parse(localStorage.getItem('costock.watch') || '[]');
      const localFormulas = JSON.parse(localStorage.getItem('costock.formulas') || '[]');
      const localStrategies = JSON.parse(localStorage.getItem('costock.screeningStrategies') || '[]');
      const localResults = JSON.parse(localStorage.getItem('costock.screeningResults') || '[]');
      const localHistory = JSON.parse(localStorage.getItem('costock.screeningHistory') || '[]');
      const local = JSON.parse(localStorage.getItem('costock.tradePlans') || '[]');
      const localConsensus = JSON.parse(localStorage.getItem('costock.aiConsensus') || 'null');
      const localMarketSort = JSON.parse(localStorage.getItem('costock.marketSort') || 'null');
      const localSideWidths = JSON.parse(localStorage.getItem('costock.sideWidths') || '{}');
      const marketSidebar = document.querySelector('[data-panel="market"] .sidebar');
      const marketSortSelect = document.querySelector('#marketSort');
      const marketSortDir = document.querySelector('#marketSortDir');
      const restoredMarketWidth = marketSidebar ? Math.round(marketSidebar.getBoundingClientRect().width) : 0;
      document.querySelector('[data-tab="plans"]').click();
      const countText = document.querySelector('#planCount') ? document.querySelector('#planCount').textContent.trim() : '';
      const listText = document.querySelector('#planList') ? document.querySelector('#planList').innerText : '';
      if (remote.watch.length !== 1 || remote.formulas.length !== 1 || remote.screeningStrategies.length !== 1) return null;
      if (remote.screeningResults.length < 1 || remote.screeningHistory.length !== 1) return null;
      if (remote.tradePlans.length !== 1 || !remote.aiConsensus) return null;
      if (localWatch.length !== 1 || localFormulas.length !== 1 || localStrategies.length !== 1) return null;
      if (localResults.length < 1 || localHistory.length !== 1 || local.length !== 1 || !localConsensus || !/1 条/.test(countText)) return null;
      if (!remote.marketSort || remote.marketSort.key !== 'amount' || remote.marketSort.dir !== 'asc') return null;
      if (!localMarketSort || localMarketSort.key !== 'amount' || localMarketSort.dir !== 'asc') return null;
      if (!remote.sideWidths || remote.sideWidths.market < 340 || !localSideWidths.market || localSideWidths.market < 340) return null;
      if (Math.abs(restoredMarketWidth - remote.sideWidths.market) > 2) return null;
      return {
        remoteWatch: remote.watch.length,
        remoteFormulas: remote.formulas.length,
        remoteStrategies: remote.screeningStrategies.length,
        remoteResults: remote.screeningResults.length,
        remoteHistory: remote.screeningHistory.length,
        remotePlans: remote.tradePlans.length,
        remoteHasConsensus: !!remote.aiConsensus,
        remoteMarketSort: remote.marketSort,
        remoteMarketSidebarWidth: remote.sideWidths.market,
        localWatch: localWatch.length,
        localFormulas: localFormulas.length,
        localStrategies: localStrategies.length,
        localResults: localResults.length,
        localHistory: localHistory.length,
        localPlans: local.length,
        localHasConsensus: !!localConsensus,
        localMarketSort,
        localMarketSidebarWidth: localSideWidths.market,
        restoredMarketWidth,
        marketSortSelectValue: marketSortSelect ? marketSortSelect.value : '',
        marketSortDirText: marketSortDir ? marketSortDir.textContent.trim() : '',
        statusWatch: status.watchCount,
        statusFormulas: status.formulaCount,
        statusStrategies: status.screeningStrategyCount,
        statusResults: status.screeningResultCount,
        statusHistory: status.screeningHistoryCount,
        statusHasConsensus: status.hasConsensus,
        statusMarketSort: status.marketSort,
        statusSideWidthCount: status.sideWidthCount,
        countText,
        code: remote.tradePlans[0].code,
        name: remote.tradePlans[0].name,
        consensus: remote.aiConsensus.summary,
        listText
      };
    })()`, 10000);
    assert.strictEqual(rehydrated.remoteWatch, 1);
    assert.strictEqual(rehydrated.remoteFormulas, 1);
    assert.strictEqual(rehydrated.remoteStrategies, 1);
    assert.ok(rehydrated.remoteResults > 0);
    assert.strictEqual(rehydrated.remoteHistory, 1);
    assert.strictEqual(rehydrated.remotePlans, 1);
    assert.strictEqual(rehydrated.remoteHasConsensus, true);
    assert.deepStrictEqual(rehydrated.remoteMarketSort, { key: 'amount', dir: 'asc' });
    assert.ok(rehydrated.remoteMarketSidebarWidth >= 340, JSON.stringify(rehydrated));
    assert.strictEqual(rehydrated.localWatch, 1);
    assert.strictEqual(rehydrated.localFormulas, 1);
    assert.strictEqual(rehydrated.localStrategies, 1);
    assert.ok(rehydrated.localResults > 0);
    assert.strictEqual(rehydrated.localHistory, 1);
    assert.strictEqual(rehydrated.localPlans, 1);
    assert.strictEqual(rehydrated.localHasConsensus, true);
    assert.deepStrictEqual(rehydrated.localMarketSort, { key: 'amount', dir: 'asc' });
    assert.ok(rehydrated.localMarketSidebarWidth >= 340, JSON.stringify(rehydrated));
    assert.ok(Math.abs(rehydrated.restoredMarketWidth - rehydrated.remoteMarketSidebarWidth) <= 2, JSON.stringify(rehydrated));
    assert.strictEqual(rehydrated.marketSortSelectValue, 'amount');
    assert.strictEqual(rehydrated.marketSortDirText, '↑');
    assert.strictEqual(rehydrated.statusWatch, 1);
    assert.strictEqual(rehydrated.statusFormulas, 1);
    assert.strictEqual(rehydrated.statusStrategies, 1);
    assert.ok(rehydrated.statusResults > 0);
    assert.strictEqual(rehydrated.statusHistory, 1);
    assert.strictEqual(rehydrated.statusHasConsensus, true);
    assert.deepStrictEqual(rehydrated.statusMarketSort, { key: 'amount', dir: 'asc' });
    assert.ok(rehydrated.statusSideWidthCount >= 1, JSON.stringify(rehydrated));
    assert.ok(/1 条/.test(rehydrated.countText), rehydrated.countText);
    assert.ok(rehydrated.listText.includes(rehydrated.code) || rehydrated.listText.includes(rehydrated.name), rehydrated.listText);

    console.log(JSON.stringify({
      ok: true,
      persistedWatch: persisted.watchCount,
      persistedFormulas: persisted.formulaCount,
      persistedStrategies: persisted.screeningStrategyCount,
      persistedResults: persisted.screeningResultCount,
      persistedHistory: persisted.screeningHistoryCount,
      persistedPlans: persisted.tradePlanCount,
      persistedConsensus: persisted.hasConsensus,
      persistedMarketSort: persisted.marketSort,
      persistedMarketSidebarWidth: persisted.marketSidebarWidth,
      rehydratedWatch: rehydrated.remoteWatch,
      rehydratedFormulas: rehydrated.remoteFormulas,
      rehydratedStrategies: rehydrated.remoteStrategies,
      rehydratedResults: rehydrated.remoteResults,
      rehydratedHistory: rehydrated.remoteHistory,
      rehydratedPlans: rehydrated.remotePlans,
      rehydratedConsensus: rehydrated.remoteHasConsensus,
      rehydratedMarketSort: rehydrated.remoteMarketSort,
      rehydratedMarketSidebarWidth: rehydrated.remoteMarketSidebarWidth,
      localWatchRebuilt: rehydrated.localWatch,
      localFormulasRebuilt: rehydrated.localFormulas,
      localStrategiesRebuilt: rehydrated.localStrategies,
      localResultsRebuilt: rehydrated.localResults,
      localHistoryRebuilt: rehydrated.localHistory,
      localStorageRebuilt: rehydrated.localPlans,
      localConsensusRebuilt: rehydrated.localHasConsensus,
      localMarketSortRebuilt: rehydrated.localMarketSort,
      localMarketSidebarWidthRebuilt: rehydrated.localMarketSidebarWidth,
      restoredMarketWidth: rehydrated.restoredMarketWidth,
      code: rehydrated.code,
      countText: rehydrated.countText,
    }, null, 2));
  } finally {
    await closeSession(first);
    await closeSession(second);
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
