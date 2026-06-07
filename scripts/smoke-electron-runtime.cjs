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
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyRealMouseChartLabels(cdp, sampleKlineCode) {
  const setup = await evaluate(cdp, `(() => {
    const sampleKlineCode = ${JSON.stringify(sampleKlineCode)};
    const marketTab = document.querySelector('[data-tab="market"]');
    if (marketTab) marketTab.click();
    const search = document.querySelector('#marketSearch');
    if (search) {
      search.value = sampleKlineCode;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const row = document.querySelector('#marketList li[data-code="' + sampleKlineCode + '"]') || document.querySelector('#marketList li[data-code]');
    if (row) row.click();
    const klineButton = document.querySelector('#detailView [data-chartmode="kline"]');
    if (klineButton && !klineButton.classList.contains('on')) klineButton.click();
    for (let add = 0; add < 3 && document.querySelectorAll('#detailView .subCanvas').length < 3; add += 1) {
      const addSub = document.querySelector('#detailView [data-addsub]');
      if (addSub) addSub.click();
    }
    const star = document.querySelector('#detailView [data-star]');
    if (star && !star.classList.contains('on')) star.click();
    const watchTab = document.querySelector('[data-tab="watch"]');
    if (watchTab) watchTab.click();
    const watchKlineButton = document.querySelector('#watchDetailView [data-chartmode="kline"]');
    if (watchKlineButton && !watchKlineButton.classList.contains('on')) watchKlineButton.click();
    for (let add = 0; add < 3 && document.querySelectorAll('#watchDetailView .subCanvas').length < 3; add += 1) {
      const addSub = document.querySelector('#watchDetailView [data-addsub]');
      if (addSub) addSub.click();
    }
    const marketTargets = [document.querySelector('#detailView .main-chart')]
      .concat(Array.from(document.querySelectorAll('#detailView .subCanvas')).slice(0, 3))
      .filter(Boolean)
      .map((canvas, index) => ({ scope: '#detailView', id: index === 0 ? 'main' : 'sub-' + (index - 1) }));
    const watchTargets = [document.querySelector('#watchDetailView .main-chart')]
      .concat(Array.from(document.querySelectorAll('#watchDetailView .subCanvas')).slice(0, 3))
      .filter(Boolean)
      .map((canvas, index) => ({ scope: '#watchDetailView', id: index === 0 ? 'main' : 'sub-' + (index - 1) }));
    return {
      count: marketTargets.length + watchTargets.length,
      targets: marketTargets.concat(watchTargets)
    };
  })()`);
  assert.ok(setup && setup.count >= 8, JSON.stringify(setup));

  async function hoverAndRead(target) {
    const point = await evaluate(cdp, `(() => {
      const scope = ${JSON.stringify(target.scope)};
      const targetId = ${JSON.stringify(target.id)};
      const tab = document.querySelector(scope === '#detailView' ? '[data-tab="market"]' : '[data-tab="watch"]');
      if (tab) tab.click();
      const root = document.querySelector(scope);
      if (!root) return null;
      const canvas = targetId === 'main'
        ? root.querySelector('.main-chart')
        : Array.from(root.querySelectorAll('.subCanvas'))[Number(targetId.split('-')[1])];
      if (!canvas) return null;
      canvas.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + Math.min(targetId === 'main' ? 160 : 140, rect.width / 2),
        y: rect.top + Math.min(targetId === 'main' ? 110 : 54, rect.height / 2),
        width: rect.width,
        height: rect.height
      };
    })()`);
    assert.ok(point && point.width > 0 && point.height > 0, `${target.scope} ${target.id}: ${JSON.stringify(point)}`);
    async function readState() {
      return evaluate(cdp, `(() => {
      const scope = ${JSON.stringify(target.scope)};
      const targetId = ${JSON.stringify(target.id)};
      const root = document.querySelector(scope);
      if (!root) return null;
      const canvas = targetId === 'main'
        ? root.querySelector('.main-chart')
        : Array.from(root.querySelectorAll('.subCanvas'))[Number(targetId.split('-')[1])];
      if (!canvas) return null;
      const frame = canvas.closest('.charts');
      const owner = canvas.dataset.chartOwner || '';
      const tip = owner && frame ? frame.querySelector('.chart-hover-tip[data-chart-owner="' + owner + '"]') : null;
      const axisX = owner && frame ? frame.querySelector('.chart-axis-label-x[data-chart-owner="' + owner + '"]') : null;
      const axisY = owner && frame ? frame.querySelector('.chart-axis-label-y[data-chart-owner="' + owner + '"]') : null;
      const rect = canvas.getBoundingClientRect();
      const center = { x: rect.left + Math.min(targetId === 'main' ? 160 : 140, rect.width / 2), y: rect.top + Math.min(targetId === 'main' ? 110 : 54, rect.height / 2) };
      const hit = document.elementFromPoint(center.x, center.y);
      const masks = Array.from(document.querySelectorAll('.modal-mask')).map((mask) => ({
        id: mask.id,
        show: mask.classList.contains('show'),
        display: getComputedStyle(mask).display
      }));
      function style(el) {
        if (!el) return { display: '', text: '', width: 0, height: 0, zIndex: 0, darkBg: false };
        const box = el.getBoundingClientRect();
        const computed = getComputedStyle(el);
        const match = computed.backgroundColor.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
        const rgb = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [255, 255, 255];
        const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
        const content = el.closest('.content');
        const contentBox = content ? content.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
        const tabbar = document.querySelector('.tabbar');
        const tabbarTop = tabbar ? tabbar.getBoundingClientRect().top : window.innerHeight;
        const bounds = {
          left: Math.max(0, contentBox.left),
          top: Math.max(0, contentBox.top),
          right: Math.min(window.innerWidth, contentBox.right),
          bottom: Math.min(window.innerHeight, contentBox.bottom, tabbarTop)
        };
        return {
          display: computed.display,
          text: el.textContent.trim(),
          width: box.width,
          height: box.height,
          zIndex: Number(computed.zIndex) || 0,
          darkBg: luminance < 90,
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          visibleInViewport: box.right > bounds.left && box.left < bounds.right && box.bottom > bounds.top && box.top < bounds.bottom
        };
      }
      return {
        scope,
        id: targetId,
        owner,
        hit: hit ? { tag: hit.tagName, id: hit.id, className: String(hit.className || ''), sameCanvas: hit === canvas } : null,
        masks,
        canvas: {
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          visibleInViewport: rect.right > 0 && rect.left < window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight,
          pointer: canvas.__coStockChartState ? canvas.__coStockChartState.pointer : null,
          metrics: canvas.__coStockChartState && canvas.__coStockChartState.metrics ? {
            padL: canvas.__coStockChartState.metrics.padL,
            plotW: canvas.__coStockChartState.metrics.plotW,
            h: canvas.__coStockChartState.metrics.h,
            view: canvas.__coStockChartState.metrics.view ? canvas.__coStockChartState.metrics.view.length : 0
          } : null
        },
        tip: tip && tip.classList.contains('show') ? tip.innerText : '',
        axisX: axisX && axisX.classList.contains('show') ? axisX.textContent.trim() : '',
        axisY: axisY && axisY.classList.contains('show') ? axisY.textContent.trim() : '',
        axisStyles: {
          x: style(axisX),
          y: style(axisY)
        }
      };
    })()`);
    }
    async function readLinkedStates() {
      return evaluate(cdp, `(() => {
        const scope = ${JSON.stringify(target.scope)};
        const root = document.querySelector(scope);
        if (!root) return [];
        function labelStyle(el) {
          if (!el) return { display: '', text: '', width: 0, height: 0, zIndex: 0, darkBg: false };
          const box = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const match = style.backgroundColor.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
          const rgb = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [255, 255, 255];
          const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
          const content = el.closest('.content');
          const contentBox = content ? content.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
          const tabbar = document.querySelector('.tabbar');
          const tabbarTop = tabbar ? tabbar.getBoundingClientRect().top : window.innerHeight;
          const bounds = {
            left: Math.max(0, contentBox.left),
            top: Math.max(0, contentBox.top),
            right: Math.min(window.innerWidth, contentBox.right),
            bottom: Math.min(window.innerHeight, contentBox.bottom, tabbarTop)
          };
          return {
            display: style.display,
            text: el.textContent.trim(),
            width: box.width,
            height: box.height,
            zIndex: Number(style.zIndex) || 0,
            darkBg: luminance < 90,
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            visibleInViewport: box.right > bounds.left && box.left < bounds.right && box.bottom > bounds.top && box.top < bounds.bottom
          };
        }
        function canvasVisible(canvas) {
          const box = canvas.getBoundingClientRect();
          const content = canvas.closest('.content');
          const contentBox = content ? content.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
          const tabbar = document.querySelector('.tabbar');
          const tabbarTop = tabbar ? tabbar.getBoundingClientRect().top : window.innerHeight;
          const bounds = {
            left: Math.max(0, contentBox.left),
            top: Math.max(0, contentBox.top),
            right: Math.min(window.innerWidth, contentBox.right),
            bottom: Math.min(window.innerHeight, contentBox.bottom, tabbarTop)
          };
          return box.right > bounds.left && box.left < bounds.right && box.bottom > bounds.top && box.top < bounds.bottom;
        }
        return Array.from(root.querySelectorAll('.main-chart, .subCanvas')).map((canvas, index) => {
          const frame = canvas.closest('.charts');
          const owner = canvas.dataset.chartOwner || '';
          const tip = owner && frame ? frame.querySelector('.chart-hover-tip[data-chart-owner="' + owner + '"]') : null;
          const axisX = owner && frame ? frame.querySelector('.chart-axis-label-x[data-chart-owner="' + owner + '"]') : null;
          const axisY = owner && frame ? frame.querySelector('.chart-axis-label-y[data-chart-owner="' + owner + '"]') : null;
          return {
            id: canvas.classList.contains('main-chart') ? 'main' : 'sub-' + index,
            owner,
            canvasVisibleInViewport: canvasVisible(canvas),
            tip: tip && tip.classList.contains('show') ? tip.innerText : '',
            axisX: axisX && axisX.classList.contains('show') ? axisX.textContent.trim() : '',
            axisY: axisY && axisY.classList.contains('show') ? axisY.textContent.trim() : '',
            axisStyles: {
              x: labelStyle(axisX),
              y: labelStyle(axisY)
            }
          };
        });
      })()`);
    }
    async function forceRepaint() {
      return evaluate(cdp, `(() => {
        const scope = ${JSON.stringify(target.scope)};
        const targetId = ${JSON.stringify(target.id)};
        const root = document.querySelector(scope);
        if (!root) return false;
        const canvas = targetId === 'main'
          ? root.querySelector('.main-chart')
          : Array.from(root.querySelectorAll('.subCanvas'))[Number(targetId.split('-')[1])];
        if (!canvas || !canvas.__coStockChartState || !canvas.__coStockChartState.render) return false;
        canvas.__coStockChartState.render(null);
        return true;
      })()`);
    }
    async function forceGroupRepaint() {
      return evaluate(cdp, `(() => {
        const scope = ${JSON.stringify(target.scope)};
        const root = document.querySelector(scope);
        if (!root) return 0;
        let count = 0;
        Array.from(root.querySelectorAll('.main-chart, .subCanvas')).forEach((canvas) => {
          if (!canvas || !canvas.__coStockChartState || !canvas.__coStockChartState.render) return;
          canvas.__coStockChartState.render(null);
          count += 1;
        });
        return count;
      })()`);
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 2,
      y: 2,
      button: 'none',
      pointerType: 'mouse',
    });
    await delay(80);
    const offsets = [[0, 0], [6, 0], [0, 6], [-6, 0]];
    let lastState = null;
    for (const offset of offsets) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x + offset[0],
        y: point.y + offset[1],
        button: 'none',
        pointerType: 'mouse',
      });
      await delay(160);
      lastState = await readState();
      if (lastState && lastState.axisX && lastState.axisY && lastState.tip) break;
    }
    if (!lastState || !lastState.axisX || !lastState.axisY || !lastState.tip) return lastState;
    const visibleLabelStates = await readLinkedStates();
    const groupRepainted = await forceGroupRepaint();
    await delay(80);
    const afterGroupRepaintStates = await readLinkedStates();
    const repainted = await forceRepaint();
    await delay(80);
    const afterRepaint = await readState();
    afterRepaint.repaintPreserved = !!(repainted && afterRepaint.axisX && afterRepaint.axisY && afterRepaint.tip);
    afterRepaint.visibleLabelStates = visibleLabelStates;
    afterRepaint.groupRepainted = groupRepainted;
    afterRepaint.afterGroupRepaintStates = afterGroupRepaintStates;
    return afterRepaint;
  }

  const states = [];
  for (const target of setup.targets.slice(0, 8)) {
    states.push(await hoverAndRead(target));
  }
  return states;
}

async function verifyRuntimeMarketImport(cdp) {
  return evaluate(cdp, `(async () => {
    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    async function waitFor(fn, label, timeoutMs) {
      const started = Date.now();
      const timeout = timeoutMs || 5000;
      while (Date.now() - started < timeout) {
        const value = fn();
        if (value) return value;
        await delay(40);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    function makeImportKlines(startText, count, base) {
      const start = Date.parse(startText);
      return Array.from({ length: count }, (_, index) => {
        const open = Number((base + index * 0.1).toFixed(2));
        const close = Number((open + 0.05).toFixed(2));
        return {
          period: '1d',
          timestamp: start + index * 86400000,
          open,
          high: Number((close + 0.3).toFixed(2)),
          low: Number((open - 0.2).toFixed(2)),
          close,
          volume: 1000000 + index * 10000,
          amount: Math.round(close * (1000000 + index * 10000))
        };
      });
    }
    function canvasInk(canvas) {
      if (!canvas) return { missing: true, nonBlank: 0, colored: 0, width: 0, height: 0 };
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlank = 0;
      let colored = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a && (r < 245 || g < 245 || b < 245)) nonBlank += 1;
        if (a && Math.max(r, g, b) - Math.min(r, g, b) > 40) colored += 1;
      }
      return { missing: false, nonBlank, colored, width: canvas.width, height: canvas.height };
    }
    const importSnapshot = {
      source: 'file',
      provider: 'runtime-import-smoke.csv',
      connected: true,
      updatedAt: Date.now(),
      note: '从 runtime-import-smoke.csv 导入',
      stocks: [
        {
          code: '688001',
          name: 'Smoke导入甲',
          market: 'SH',
          industry: '验证',
          klines: makeImportKlines('2026-04-20', 24, 10)
        },
        {
          code: '300001',
          name: 'Smoke导入乙',
          market: 'SZ',
          industry: '验证',
          klines: makeImportKlines('2026-04-23', 21, 20)
        }
      ]
    };
    const bridge = window.costockBridge && window.costockBridge.market;
    if (!bridge || !bridge.hydrateSnapshot) return { skipped: true };
    await bridge.hydrateSnapshot(importSnapshot);
    window.CoStockData.hydrate(importSnapshot);
    document.querySelector('[data-tab="market"]').click();
    const search = document.querySelector('#marketSearch');
    if (search) {
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await waitFor(() => window.CoStockData.allCodes().length === 2 && document.querySelectorAll('#marketList li[data-code]').length === 2, 'runtime market import list render');
    const first = document.querySelector('#marketList li[data-code="688001"]');
    if (first) first.click();
    await waitFor(() => document.querySelector('#detailView').innerText.includes('Smoke导入甲'), 'runtime market import detail');
    const importedKlines = window.CoStockData.getKLines('688001');
    return {
      skipped: false,
      statusCount: window.CoStockData.getStatus().count,
      statusKlineCount: window.CoStockData.getStatus().klineCount,
      storeCodes: window.CoStockData.allCodes(),
      rows: Array.from(document.querySelectorAll('#marketList li[data-code]')).map((li) => li.dataset.code),
      detailHasImportedName: document.querySelector('#detailView').innerText.includes('Smoke导入甲'),
      klineCount: importedKlines.length,
      quotePrice: window.CoStockData.getQuote('688001').price,
      provider: window.CoStockData.getStatus().provider,
      dataBadge: document.querySelector('#dataBadge').textContent.trim(),
      chartInk: canvasInk(document.querySelector('#detailView .main-chart'))
    };
  })()`);
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

async function main() {
  const port = await findFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'costock-electron-smoke-'));
  const electronBin = resolveElectronBin();
  const child = spawn(electronBin, [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`, '.'], {
    cwd: ROOT,
    env: {
      ...process.env,
      COSTOCK_CODEX_BACKEND: 'local',
      COSTOCK_WINDOW_WIDTH: '1280',
      COSTOCK_WINDOW_HEIGHT: '840',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  let cdp = null;
  try {
    const target = await waitForTargets(port, 15000);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await waitForEval(cdp, `document.readyState === 'complete' && !!document.querySelector('.main-chart')`, 15000);
    await waitForEval(cdp, `document.querySelector('#aiRuntime') && document.querySelector('#aiRuntime').innerText.length > 0`, 8000);
    await waitForEval(cdp, `(() => {
      const refresh = document.querySelector('#refreshMarketBtn');
      const refreshAll = document.querySelector('#refreshAllMarketBtn');
      const badge = document.querySelector('#dataBadge');
      return refresh && refreshAll && badge &&
        refresh.textContent.trim() === '刷新行情' &&
        refreshAll.textContent.trim() === '全A' &&
        !badge.classList.contains('loading');
    })()`, 30000);
    const sampleKlineCode = await waitForEval(cdp, `(() => {
      const D = window.CoStockData;
      const status = D && D.getStatus ? D.getStatus() : null;
      const codes = D && D.allCodes ? D.allCodes() : [];
      const sample = codes.find((code) => D.getKLines(code).length >= 120);
      return status && status.connected && status.count >= 20 && sample;
    })()`, 20000);

    const result = await evaluate(cdp, `(async () => {
      const sampleKlineCode = ${JSON.stringify(sampleKlineCode)};
      window.prompt = () => { throw new Error('native prompt must not be used'); };
      window.confirm = () => { throw new Error('native confirm must not be used'); };
      function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }
	      async function waitFor(fn, label, timeoutMs) {
	        const started = Date.now();
	        const timeout = timeoutMs || 4000;
	        while (Date.now() - started < timeout) {
	          const value = fn();
          if (value) return value;
          await delay(40);
	        }
	        throw new Error('Timed out waiting for ' + label);
	      }
	      function canvasInk(canvas) {
	        if (!canvas) return { missing: true, nonBlank: 0, colored: 0, width: 0, height: 0 };
	        const ctx = canvas.getContext('2d');
	        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
	        let nonBlank = 0;
	        let colored = 0;
	        for (let i = 0; i < data.length; i += 4) {
	          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
	          if (a && (r < 245 || g < 245 || b < 245)) nonBlank += 1;
	          if (a && Math.max(r, g, b) - Math.min(r, g, b) > 40) colored += 1;
	        }
	        return { missing: false, nonBlank, colored, width: canvas.width, height: canvas.height };
	      }
	      const text = document.body.innerText;
	      const topbar = document.querySelector('.topbar');
	      const safe = document.querySelector('.traffic-safe-zone');
	      const brand = document.querySelector('.brand');
	      const marketSearchTarget = window.CoStockData.getQuote(sampleKlineCode) || window.CoStockData.listStocks()[0];
      if (!marketSearchTarget) throw new Error('missing quote for market search workflow');
      const marketSearch = document.querySelector('#marketSearch');
      const marketSort = document.querySelector('#marketSort');
      const marketSortDir = document.querySelector('#marketSortDir');
      marketSearch.value = marketSearchTarget.code;
      marketSearch.dispatchEvent(new Event('input', { bubbles: true }));
      const filteredRows = Array.from(document.querySelectorAll('#marketList li[data-code]'));
      const filteredCountText = document.querySelector('#marketCount').textContent.trim();
      const marketFilterDetail = document.querySelector('#detailView').innerText;
      const marketFilterFocused = document.activeElement === marketSearch;
      marketSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const allRowsAfterEscape = Array.from(document.querySelectorAll('#marketList li[data-code]'));
      marketSort.value = 'code';
      marketSort.dispatchEvent(new Event('change', { bubbles: true }));
      if (marketSortDir.textContent.trim() !== '↑') marketSortDir.click();
      const ascRows = Array.from(document.querySelectorAll('#marketList li[data-code]')).map((li) => li.dataset.code);
      if (marketSortDir.textContent.trim() !== '↓') marketSortDir.click();
      const descRows = Array.from(document.querySelectorAll('#marketList li[data-code]')).map((li) => li.dataset.code);
      const storedMarketSort = JSON.parse(localStorage.getItem('costock.marketSort') || 'null');
      const marketInteraction = {
        searchCode: marketSearchTarget.code,
        filteredCount: filteredRows.length,
        filteredCodes: filteredRows.map((li) => li.dataset.code),
        filterCountText: filteredCountText,
        detailHasSearchCode: marketFilterDetail.indexOf(marketSearchTarget.code) >= 0,
        filterFocused: marketFilterFocused,
        resetCount: allRowsAfterEscape.length,
        ascFirst: ascRows[0],
        ascSecond: ascRows[1],
        descFirst: descRows[0],
        descSecond: descRows[1],
        storedMarketSort,
        sortDirLabel: marketSortDir.textContent.trim()
      };
      const sampleRow = document.querySelector('#marketList li[data-code="' + sampleKlineCode + '"]');
      if (sampleRow) sampleRow.click();
      const sparseCode = window.CoStockData.allCodes().find((code) => code !== sampleKlineCode && window.CoStockData.getKLines(code).length < 20);
      let sparseChartState = { code: '', text: '', shown: false, subBlank: false };
      if (sparseCode) {
        const sparseRow = document.querySelector('#marketList li[data-code="' + sparseCode + '"]');
        if (sparseRow) sparseRow.click();
        const empty = document.querySelector('#chartEmpty');
        const sub = document.querySelector('.subCanvas');
        const subRect = sub ? sub.getBoundingClientRect() : { width: 0, height: 0 };
        sparseChartState = {
          code: sparseCode,
          text: empty ? empty.textContent.trim() : '',
          shown: !!(empty && empty.classList.contains('show')),
          subBlank: !!(sub && subRect.width > 0 && subRect.height > 0)
        };
        if (sampleRow) sampleRow.click();
      }
      const canvas = document.querySelector('#detailView .main-chart');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: rect.left + Math.min(160, rect.width / 2),
        clientY: rect.top + Math.min(110, rect.height / 2)
      }));
      function axisLabelStyle(el) {
        if (!el) return { display: '', text: '', width: 0, height: 0, zIndex: 0, darkBg: false };
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const match = style.backgroundColor.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
        const rgb = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [255, 255, 255];
        const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
        const content = el.closest('.content');
        const contentBox = content ? content.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
        const tabbar = document.querySelector('.tabbar');
        const tabbarTop = tabbar ? tabbar.getBoundingClientRect().top : window.innerHeight;
        const bounds = {
          left: Math.max(0, contentBox.left),
          top: Math.max(0, contentBox.top),
          right: Math.min(window.innerWidth, contentBox.right),
          bottom: Math.min(window.innerHeight, contentBox.bottom, tabbarTop)
        };
        return {
          display: style.display,
          text: el.textContent.trim(),
          width: box.width,
          height: box.height,
          zIndex: Number(style.zIndex) || 0,
          darkBg: luminance < 90,
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          visibleInViewport: box.right > bounds.left && box.left < bounds.right && box.bottom > bounds.top && box.top < bounds.bottom
        };
      }
      function chartOwner(canvas) {
        const frame = canvas && canvas.closest ? canvas.closest('.charts') : null;
        if (!frame || !canvas) return {};
        const owner = canvas.dataset.chartOwner || '';
        return {
          root: frame,
          owner,
          tip: owner ? frame.querySelector('.chart-hover-tip[data-chart-owner="' + owner + '"]') : null,
          axisX: owner ? frame.querySelector('.chart-axis-label-x[data-chart-owner="' + owner + '"]') : null,
          axisY: owner ? frame.querySelector('.chart-axis-label-y[data-chart-owner="' + owner + '"]') : null,
        };
      }
      const mainOwned = chartOwner(canvas);
      const mainAxisLabelX = mainOwned.axisX;
      const mainAxisLabelY = mainOwned.axisY;
      const mainAxisLabels = {
        x: mainAxisLabelX && mainAxisLabelX.classList.contains('show') ? mainAxisLabelX.textContent.trim() : '',
        y: mainAxisLabelY && mainAxisLabelY.classList.contains('show') ? mainAxisLabelY.textContent.trim() : ''
      };
      const mainAxisStyles = {
        x: axisLabelStyle(mainAxisLabelX),
        y: axisLabelStyle(mainAxisLabelY)
      };
      function hoverSubState(sub) {
        sub = sub || document.querySelector('.subCanvas');
        if (!sub) return { tip: '', axisX: '', axisY: '', axisStyles: { x: axisLabelStyle(null), y: axisLabelStyle(null) } };
        sub.scrollIntoView({ block: 'center', inline: 'nearest' });
        const sr = sub.getBoundingClientRect();
        sub.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true,
          clientX: sr.left + Math.min(120, sr.width / 2),
          clientY: sr.top + Math.min(50, sr.height / 2)
        }));
        const owned = chartOwner(sub);
        const tip = owned.tip;
        const axisX = owned.axisX;
        const axisY = owned.axisY;
        return {
          tip: tip && tip.classList.contains('show') ? tip.innerText : '',
          axisX: axisX && axisX.classList.contains('show') ? axisX.textContent.trim() : '',
          axisY: axisY && axisY.classList.contains('show') ? axisY.textContent.trim() : '',
          owner: owned.owner || '',
          axisStyles: {
            x: axisLabelStyle(axisX),
            y: axisLabelStyle(axisY)
          }
        };
      }
      function hoverAtRatio(target, xRatio, yRatio) {
        const box = target.getBoundingClientRect();
        target.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true,
          clientX: box.left + box.width * xRatio,
          clientY: box.top + box.height * yRatio
        }));
        const owned = chartOwner(target);
        return {
          owner: owned.owner || '',
          axisX: owned.axisX && owned.axisX.classList.contains('show') ? owned.axisX.textContent.trim() : '',
          axisY: owned.axisY && owned.axisY.classList.contains('show') ? owned.axisY.textContent.trim() : '',
          tip: owned.tip && owned.tip.classList.contains('show') ? owned.tip.innerText : '',
          axisStyles: {
            x: axisLabelStyle(owned.axisX),
            y: axisLabelStyle(owned.axisY)
          }
        };
      }
      const subMacdState = hoverSubState();
      const kdjPick = document.querySelector('[data-subpick="0:KDJ"]');
      if (kdjPick) kdjPick.click();
      const subKdjState = hoverSubState();
      const rsiPick = document.querySelector('[data-subpick="0:RSI"]');
      if (rsiPick) rsiPick.click();
      const subRsiState = hoverSubState();
      const intradayButton = document.querySelector('[data-chartmode="intraday"]');
      const klineButton = document.querySelector('[data-chartmode="kline"]');
      if (intradayButton) intradayButton.click();
      await waitFor(() => {
        const points = window.CoStockData.getIntraday(sampleKlineCode, { points: 240 });
        return points.some((p) => p && p.source === 'tencent-intraday');
      }, 'real intraday loaded', 12000);
      const intradayCanvas = document.querySelector('#detailView .main-chart');
      const intradayRect = intradayCanvas.getBoundingClientRect();
      intradayCanvas.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: intradayRect.left + Math.min(180, intradayRect.width / 2),
        clientY: intradayRect.top + Math.min(90, intradayRect.height / 2)
      }));
      const intradayOwned = chartOwner(intradayCanvas);
      const intradayTip = intradayOwned.tip;
      const intradayAxisX = intradayOwned.axisX;
      const intradayAxisY = intradayOwned.axisY;
      const intradayState = {
        count: window.CoStockData.getIntraday(sampleKlineCode, { points: 240 }).length,
        realCount: window.CoStockData.getIntraday(sampleKlineCode, { points: 240 }).filter((p) => p && p.source === 'tencent-intraday').length,
        tip: intradayTip && intradayTip.classList.contains('show') ? intradayTip.innerText : '',
        axisX: intradayAxisX && intradayAxisX.classList.contains('show') ? intradayAxisX.textContent.trim() : '',
        axisY: intradayAxisY && intradayAxisY.classList.contains('show') ? intradayAxisY.textContent.trim() : '',
        axisStyles: {
          x: axisLabelStyle(intradayAxisX),
          y: axisLabelStyle(intradayAxisY)
        },
        subHidden: Array.from(document.querySelectorAll('.sub-window')).every((el) => getComputedStyle(el).display === 'none'),
        addSubHidden: document.querySelector('.add-sub-btn') ? getComputedStyle(document.querySelector('.add-sub-btn')).display === 'none' : false
      };
      if (klineButton) klineButton.click();
      for (let add = 0; add < 3 && document.querySelectorAll('.subCanvas').length < 3; add += 1) {
        const addSub = document.querySelector('[data-addsub]');
        if (addSub) addSub.click();
      }
      const multiSubStates = Array.from(document.querySelectorAll('.subCanvas')).map((sub) => hoverSubState(sub));
      const edgeHoverStates = [document.querySelector('#detailView .main-chart')]
        .concat(Array.from(document.querySelectorAll('#detailView .subCanvas')).slice(0, 3))
        .filter(Boolean)
        .map((target, index) => Object.assign({ id: index === 0 ? 'main' : 'sub-' + index }, hoverAtRatio(target, 0.96, 0.5)));
      const restoredCanvas = document.querySelector('#detailView .main-chart');
      const restoredRect = restoredCanvas.getBoundingClientRect();
      restoredCanvas.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: restoredRect.left + Math.min(160, restoredRect.width / 2),
        clientY: restoredRect.top + Math.min(110, restoredRect.height / 2)
      }));
      const restoredOwned = chartOwner(restoredCanvas);
      const klineRestoredState = {
        subVisible: Array.from(document.querySelectorAll('.sub-window')).some((el) => getComputedStyle(el).display !== 'none'),
        addSubVisible: document.querySelector('.add-sub-btn') ? getComputedStyle(document.querySelector('.add-sub-btn')).display !== 'none' : false
      };
      const v = restoredOwned.owner && restoredOwned.root ? restoredOwned.root.querySelector('.chart-crosshair-v[data-chart-owner="' + restoredOwned.owner + '"]') : null;
      const h = restoredOwned.owner && restoredOwned.root ? restoredOwned.root.querySelector('.chart-crosshair-h[data-chart-owner="' + restoredOwned.owner + '"]') : null;
      const restoredCrosshairShown = !!(v && h && v.classList.contains('show') && h.classList.contains('show'));
      const safeRect = safe.getBoundingClientRect();
      const brandRect = brand.getBoundingClientRect();
      const logoImg = document.querySelector('.brand .logo img');
      const topbarRect = topbar.getBoundingClientRect();
      const topbarRightRect = document.querySelector('.topbar-right').getBoundingClientRect();
      const workspaceRect = document.querySelector('.workspace').getBoundingClientRect();
      const layoutRect = document.querySelector('.layout').getBoundingClientRect();
      const aiDockRect = document.querySelector('#aiDock').getBoundingClientRect();
      const tabbarRect = document.querySelector('.tabbar').getBoundingClientRect();
      const aiCollapseBtn = document.querySelector('#aiCollapse');
      const aiFab = document.querySelector('#aiFab');
      if (aiCollapseBtn) aiCollapseBtn.click();
      const aiFabRect = aiFab ? aiFab.getBoundingClientRect() : { width: 0, height: 0, right: 0, bottom: 0 };
      const aiFabStyle = aiFab ? getComputedStyle(aiFab) : { display: 'none' };
      const aiFabCenter = aiFab ? {
        x: aiFabRect.left + aiFabRect.width / 2,
        y: aiFabRect.top + aiFabRect.height / 2
      } : { x: -1, y: -1 };
      const aiFabHit = document.elementFromPoint(aiFabCenter.x, aiFabCenter.y);
      const aiCollapsed = document.querySelector('#aiDock').classList.contains('collapsed');
      const cardActionRects = Array.from(document.querySelectorAll('.stock-card button')).map((button) => button.getBoundingClientRect());
      function intersects(a, b) {
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      }
      const aiFabCoversCardAction = !!(aiFab && cardActionRects.some((rect) => intersects(aiFabRect, rect)));
      const aiFabVisible = !!(aiFab && aiFab.classList.contains('show') && aiFabStyle.display !== 'none' && aiFabRect.width >= 44 && aiFabRect.height >= 44 && aiFabRect.right <= window.innerWidth + 1 && aiFabRect.bottom <= tabbarRect.top - 8 && (aiFabHit === aiFab || (aiFabHit && aiFab.contains(aiFabHit))) && !aiFabCoversCardAction);
      if (aiFab) aiFab.click();
      const aiExpandedAgain = !document.querySelector('#aiDock').classList.contains('collapsed') && !aiFab.classList.contains('show');
      document.querySelector('[data-tab="watch"]').click();
      const defaultWatchGroupDeleteState = (() => {
        const base = ['长线', '短线', '观察'];
        const groups = Array.from(document.querySelectorAll('#watchGroups [data-group]'));
        return {
          present: base.every((name) => groups.some((el) => el.dataset.group === name)),
          defaultDeleteCount: groups.filter((el) => base.includes(el.dataset.group) && el.querySelector('[data-delgroup]')).length,
          allDeleteGroupValues: Array.from(document.querySelectorAll('#watchGroups [data-delgroup]')).map((el) => el.dataset.delgroup)
        };
      })();
      document.querySelector('#watchAddGroup').click();
      const promptMask = document.querySelector('#promptMask');
      const promptTitle = document.querySelector('#promptTitle');
      const promptVisible = promptMask.classList.contains('show');
      const promptTitleText = promptTitle ? promptTitle.textContent.trim() : '';
      const promptInput = document.querySelector('#promptInput');
      if (promptInput) {
        promptInput.value = 'Smoke临时分组';
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('#promptOk').click();
      await waitFor(() => document.querySelector('#watchGroups [data-group="Smoke临时分组"]'), 'custom watch group');
      const customWatchGroupDeleteState = (() => {
        const custom = document.querySelector('#watchGroups [data-group="Smoke临时分组"]');
        const del = custom ? custom.querySelector('[data-delgroup="Smoke临时分组"]') : null;
        return {
          present: !!custom,
          deletable: !!del,
          deleteText: del ? del.textContent.trim() : ''
        };
      })();
      document.querySelector('#watchImport').click();
      const importMask = document.querySelector('#importMask');
      const importRole = importMask.querySelector('.modal').getAttribute('role');
      const importAria = importMask.querySelector('.modal').getAttribute('aria-modal');
      const importVisible = importMask.classList.contains('show');
      document.querySelector('#importText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const importEscClosed = !importMask.classList.contains('show');
      document.querySelector('[data-tab="formula"]').click();
      document.querySelector('#formulaImport').click();
      const formulaImportMask = document.querySelector('#fImportMask');
      const formulaImportRole = formulaImportMask.querySelector('.modal').getAttribute('role');
      const formulaImportAria = formulaImportMask.querySelector('.modal').getAttribute('aria-modal');
      const formulaImportVisible = formulaImportMask.classList.contains('show');
      document.querySelector('#fImportText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const formulaImportEscClosed = !formulaImportMask.classList.contains('show');
      document.querySelector('[data-tab="screener"]').click();
      const builtinConditionContainerCount = document.querySelectorAll('#builtinConditions').length;
      const condBox = document.querySelector('#builtinConditions');
      const runBtn = document.querySelector('#runScreenBtn');
      const firstCond = condBox ? condBox.querySelector('.cond-item:first-child') : null;
      const firstCondRect = firstCond ? firstCond.getBoundingClientRect() : { bottom: 0 };
      const firstRunRect = runBtn ? runBtn.getBoundingClientRect() : { top: 0 };
      if (condBox) condBox.scrollTop = condBox.scrollHeight;
      const lastCond = condBox ? condBox.querySelector('.cond-item:last-child') : null;
      const condRect = condBox ? condBox.getBoundingClientRect() : { bottom: 0, top: 0, height: 0 };
      const lastCondRect = lastCond ? lastCond.getBoundingClientRect() : { bottom: 0, top: 0, height: 0 };
      const runRect = runBtn ? runBtn.getBoundingClientRect() : { top: 0, bottom: 0 };
      const resultList = document.querySelector('#screenResults');
      document.querySelectorAll('[data-cond]').forEach((cb) => { if (cb.checked) cb.click(); });
      const chg = document.querySelector('[data-cond="chg"]');
      if (chg && !chg.checked) chg.click();
      const chgInput = document.querySelector('[data-input="chg"]');
      if (chgInput) {
        chgInput.value = '-100';
        chgInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('#runScreenBtn').click();
      if (resultList) resultList.scrollTop = resultList.scrollHeight;
      const lastResult = resultList ? resultList.querySelector('li:last-child') : null;
      const resultRect = resultList ? resultList.getBoundingClientRect() : { bottom: 0, top: 0 };
      const lastResultRect = lastResult ? lastResult.getBoundingClientRect() : { bottom: 0, top: 0 };
      const tabbarRectForResults = document.querySelector('.tabbar').getBoundingClientRect();
	      const screenerScroll = {
	        conditionScrollable: !!(condBox && condBox.scrollHeight > condBox.clientHeight),
        firstConditionClearOfButton: !!(firstCond && firstCondRect.bottom <= firstRunRect.top - 1),
        lastConditionVisible: !!(lastCond && lastCondRect.bottom <= condRect.bottom + 1 && lastCondRect.top >= condRect.top - 1),
        runButtonBelowConditions: !!(runBtn && runRect.top >= condRect.bottom - 1),
        runButtonVisible: !!(runBtn && runRect.bottom <= window.innerHeight - 44 + 1),
        resultScrollable: !!(resultList && resultList.scrollHeight > resultList.clientHeight),
        lastResultVisible: !!(lastResult && lastResultRect.bottom <= resultRect.bottom + 1 && lastResultRect.top >= resultRect.top - 1),
	        resultClearOfTabbar: !!(resultRect.bottom <= tabbarRectForResults.top + 1)
	      };
	      document.querySelector('[data-tab="market"]').click();
	      const marketSampleRow = document.querySelector('#marketList li[data-code="' + sampleKlineCode + '"]') || document.querySelector('#marketList li');
	      if (marketSampleRow) marketSampleRow.click();
	      const cardPlanBtn = document.querySelector('[data-card-plan]');
	      if (!cardPlanBtn) throw new Error('missing detail plan button after market switch');
	      cardPlanBtn.click();
      const planCount = document.querySelector('#planCount').textContent.trim();
      document.querySelector('[data-plan-delete]').click();
      const confirmVisible = promptMask.classList.contains('show');
      const confirmTitle = promptTitle ? promptTitle.textContent.trim() : '';
      document.querySelector('#promptCancel').click();
      document.querySelector('[data-tab="market"]').click();
      document.querySelector('#dataBadge').click();
      const dataBadge = document.querySelector('#dataBadge');
      const dataStatusMask = document.querySelector('#dataStatusMask');
      const dataStatusRole = dataStatusMask.querySelector('.modal').getAttribute('role');
      const dataStatusAria = dataStatusMask.querySelector('.modal').getAttribute('aria-modal');
      const marketStatus = window.CoStockData.getStatus();
      const klineCount = window.CoStockData.getKLines(sampleKlineCode).length;
      const activeCanvas = document.querySelector('[data-panel="market"]:not(.hidden) .main-chart') || document.querySelector('.main-chart') || canvas;
      const activeCanvasRect = activeCanvas.getBoundingClientRect();
      const visibleText = document.body.innerText;
      const hiddenUiText = Array.from(document.querySelectorAll('[title], [aria-label]'))
        .filter((el) => {
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })
        .map((el) => [el.getAttribute('title') || '', el.getAttribute('aria-label') || ''].join(' '))
        .join('\\n');
      const forbiddenUiPattern = /本地后备|Codex App Server|App Server|Localhost|localhost|127\\.0\\.0\\.1|入口地址|token|Header|COSTOCK|dataAccess|appServer|local-fallback|main-process-fallback|codex-cli-exec|sandbox|本地AI回复|Codex数据入口|Codex数据已注入|本地AI分析中|本地模拟数据|本地模拟行情快照|真实\\/外部数据|交易接口|交易端点|轻仓|分批操作|后续继续扩展|接入舆情|接入大模型|多 Agent|技术分析师|基本面分析师|情绪分析师|风控专家/;
      return {
        url: location.href,
        tabs: Array.from(document.querySelectorAll('.tab')).map((x) => x.textContent.trim()),
        hasAiSettingsButton: !!document.querySelector('#aiSettingsBtn'),
        hasUpdateBridge: !!(window.costockBridge && window.costockBridge.update && window.costockBridge.update.getStatus && window.costockBridge.update.onStatus),
        logoLoaded: !!(logoImg && logoImg.complete && logoImg.naturalWidth > 0 && logoImg.naturalHeight > 0),
        cardButtons: Array.from(document.querySelectorAll('.stock-card button')).map((x) => x.textContent.trim()),
        aiRuntime: document.querySelector('#aiRuntime').innerText,
        dataBadge: dataBadge ? dataBadge.textContent.trim() : '',
	        marketProvider: marketStatus.provider,
	        marketCount: marketStatus.count,
	        marketInteraction,
        sparseChartState,
        sampleKlineCode,
        currentKlineCount: klineCount,
        dataBadgeLoading: dataBadge ? dataBadge.classList.contains('loading') : true,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1,
        workspaceWidth: workspaceRect.width,
        layoutWidth: layoutRect.width,
        aiDockRight: aiDockRect.right,
        aiCollapsed,
        aiFabVisible,
        aiFabText: aiFab ? aiFab.textContent.trim() : '',
        aiFabHitId: aiFabHit ? aiFabHit.id : '',
        aiFabBottom: aiFabRect.bottom,
        aiFabCoversCardAction,
        tabbarTop: tabbarRect.top,
        aiExpandedAgain,
        tabbarBottom: tabbarRect.bottom,
        topbarRightLeft: topbarRightRect.left,
        brandRight: brandRect.right,
        canvasWidth: activeCanvasRect.width,
        legacyMainChartIdCount: document.querySelectorAll('#mainChart').length,
        mainChartCount: document.querySelectorAll('.main-chart').length,
        hiddenUiText,
        hasPaperText: /模拟交易|模拟账户|模拟持仓|模拟买入|模拟卖出/.test(visibleText),
        hasOldWording: forbiddenUiPattern.test(visibleText),
        hasHiddenOldWording: forbiddenUiPattern.test(hiddenUiText),
        hasSyntheticOrderbook: /五档盘口/.test(text),
        hasQuoteStatsCard: /报价统计/.test(text),
        trafficSafeWidth: safeRect.width,
        brandLeft: brandRect.left,
        topbarLeft: topbarRect.left,
        canvasCursor: getComputedStyle(activeCanvas).cursor,
        crosshairShown: restoredCrosshairShown,
        mainAxisLabels,
        mainAxisStyles,
        subTipMacdText: subMacdState.tip,
        subTipKdjText: subKdjState.tip,
        subTipRsiText: subRsiState.tip,
        subAxisMacd: { x: subMacdState.axisX, y: subMacdState.axisY },
        subAxisKdj: { x: subKdjState.axisX, y: subKdjState.axisY },
        subAxisRsi: { x: subRsiState.axisX, y: subRsiState.axisY },
        multiSubStates,
        edgeHoverStates,
        intradayState,
        klineRestoredState,
        defaultWatchGroupDeleteState,
        customWatchGroupDeleteState,
        builtinConditionContainerCount,
        subAxisStyles: {
          macd: subMacdState.axisStyles,
          kdj: subKdjState.axisStyles,
          rsi: subRsiState.axisStyles
        },
        promptVisible,
        promptTitle: promptTitleText,
        importVisible,
        importEscClosed,
        importRole,
        importAria,
        formulaImportVisible,
	        formulaImportEscClosed,
	        formulaImportRole,
	        formulaImportAria,
	        screenerScroll,
	        confirmVisible,
        confirmTitle,
        planCount,
        modalVisible: dataStatusMask.classList.contains('show'),
        dataStatusRole,
        dataStatusAria
      };
    })()`);

    assert.deepStrictEqual(result.tabs, ['① 行情', '② 自选', '③ 公式', '④ 选股', '⑤ 计划']);
    assert.deepStrictEqual(result.cardButtons, ['生成研究计划', '🤖 让 AI 分析该股']);
    assert.strictEqual(result.hasPaperText, false);
    assert.strictEqual(result.hasOldWording, false);
    assert.strictEqual(result.hasHiddenOldWording, false, result.hiddenUiText);
    assert.strictEqual(result.hasSyntheticOrderbook, false);
    assert.strictEqual(result.hasQuoteStatsCard, true);
    assert.strictEqual(result.hasAiSettingsButton, true);
    assert.strictEqual(result.hasUpdateBridge, true);
    assert.strictEqual(result.logoLoaded, true);
    assert.ok(result.aiRuntime.includes('Codex'), result.aiRuntime);
    assert.ok(result.aiRuntime.includes('已接入当前数据'), result.aiRuntime);
    assert.strictEqual(/本地AI回复|Codex数据入口|Codex数据已注入/.test(result.aiRuntime), false, result.aiRuntime);
    assert.ok(result.dataBadge === '真实/延迟数据' || result.dataBadge === '本地/缓存数据', result.dataBadge);
	    assert.strictEqual(result.dataBadge, '真实/延迟数据', result.dataBadge);
	    assert.ok(result.marketCount >= 20, `marketCount=${result.marketCount}`);
	    assert.strictEqual(result.marketInteraction.filteredCount, 1, JSON.stringify(result.marketInteraction));
    assert.deepStrictEqual(result.marketInteraction.filteredCodes, [result.marketInteraction.searchCode]);
    assert.ok(result.marketInteraction.filterCountText.startsWith('1 / '), JSON.stringify(result.marketInteraction));
    assert.strictEqual(result.marketInteraction.detailHasSearchCode, true, JSON.stringify(result.marketInteraction));
    assert.strictEqual(result.marketInteraction.filterFocused, true, JSON.stringify(result.marketInteraction));
    assert.ok(result.marketInteraction.resetCount >= 20, JSON.stringify(result.marketInteraction));
    assert.ok(result.marketInteraction.ascFirst < result.marketInteraction.ascSecond, JSON.stringify(result.marketInteraction));
    assert.ok(result.marketInteraction.descFirst > result.marketInteraction.descSecond, JSON.stringify(result.marketInteraction));
    assert.deepStrictEqual(result.marketInteraction.storedMarketSort, { key: 'code', dir: 'desc' });
    assert.strictEqual(result.marketInteraction.sortDirLabel, '↓', JSON.stringify(result.marketInteraction));
    if (result.sparseChartState.code) {
      assert.strictEqual(result.sparseChartState.shown, true, JSON.stringify(result.sparseChartState));
      assert.ok(/日K数据加载中|当前快照未包含足够日K/.test(result.sparseChartState.text), JSON.stringify(result.sparseChartState));
    }
    assert.ok(/eastmoney|tencent|sina|network/i.test(result.marketProvider), result.marketProvider);
    assert.ok(result.currentKlineCount >= 120, `currentKlineCount=${result.currentKlineCount}`);
    assert.strictEqual(result.dataBadgeLoading, false);
    assert.ok(result.viewportWidth >= 1200 && result.viewportWidth <= 1320, `viewportWidth=${result.viewportWidth}`);
    assert.ok(result.viewportHeight >= 780 && result.viewportHeight <= 900, `viewportHeight=${result.viewportHeight}`);
    assert.strictEqual(result.horizontalOverflow, false);
    assert.ok(result.workspaceWidth > 0 && result.layoutWidth > 0, `workspace=${result.workspaceWidth}, layout=${result.layoutWidth}`);
    assert.ok(result.aiDockRight <= result.viewportWidth + 1, `aiDockRight=${result.aiDockRight}, viewport=${result.viewportWidth}`);
    assert.strictEqual(result.aiCollapsed, true);
    assert.strictEqual(result.aiFabVisible, true);
    assert.strictEqual(result.aiFabText, 'AI');
    assert.strictEqual(result.aiFabHitId, 'aiFab');
    assert.strictEqual(result.aiFabCoversCardAction, false);
    assert.ok(result.aiFabBottom <= result.tabbarTop - 8, `aiFabBottom=${result.aiFabBottom}, tabbarTop=${result.tabbarTop}`);
    assert.strictEqual(result.aiExpandedAgain, true);
    assert.ok(result.tabbarBottom <= result.viewportHeight + 1, `tabbarBottom=${result.tabbarBottom}, viewport=${result.viewportHeight}`);
    assert.ok(result.brandRight <= result.topbarRightLeft + 1, `brandRight=${result.brandRight}, topbarRightLeft=${result.topbarRightLeft}`);
    assert.ok(result.canvasWidth >= 360, `canvasWidth=${result.canvasWidth}`);
    assert.strictEqual(result.legacyMainChartIdCount, 0, `legacyMainChartIdCount=${result.legacyMainChartIdCount}`);
    assert.ok(result.mainChartCount >= 1, `mainChartCount=${result.mainChartCount}`);
    assert.ok(result.trafficSafeWidth >= 160 || process.platform !== 'darwin', `trafficSafeWidth=${result.trafficSafeWidth}`);
    assert.ok(result.brandLeft >= result.topbarLeft + result.trafficSafeWidth, `brandLeft=${result.brandLeft}, safe=${result.trafficSafeWidth}`);
    assert.strictEqual(result.canvasCursor, 'crosshair');
    assert.strictEqual(result.crosshairShown, true);
    assert.ok(/\d{1,2}\/\d{1,2}/.test(result.mainAxisLabels.x), JSON.stringify(result.mainAxisLabels));
    assert.ok(/^-?\d+(\.\d+)?/.test(result.mainAxisLabels.y) || /^量 /.test(result.mainAxisLabels.y), JSON.stringify(result.mainAxisLabels));
    function assertVisibleAxisLabel(style) {
      assert.strictEqual(style.display, 'block', JSON.stringify(style));
      assert.ok(style.width >= 24 && style.height >= 16, JSON.stringify(style));
      assert.ok(style.zIndex >= 12, JSON.stringify(style));
      assert.strictEqual(style.darkBg, true, JSON.stringify(style));
    }
    function assertViewportAxisLabel(style) {
      assertVisibleAxisLabel(style);
      assert.strictEqual(style.visibleInViewport, true, JSON.stringify(style));
    }
    [result.mainAxisStyles.x, result.mainAxisStyles.y].forEach(assertVisibleAxisLabel);
    assert.ok(/价\s+-?\d+(\.\d+)?/.test(result.intradayState.tip) && /均\s+-?\d+(\.\d+)?/.test(result.intradayState.tip) && /量\s+/.test(result.intradayState.tip), result.intradayState.tip);
    assert.ok(result.intradayState.realCount > 0, JSON.stringify(result.intradayState));
    assert.ok(/^\d{2}:\d{2}$/.test(result.intradayState.axisX), JSON.stringify(result.intradayState));
    assert.ok(/^-?\d+(\.\d+)?/.test(result.intradayState.axisY), JSON.stringify(result.intradayState));
    [result.intradayState.axisStyles.x, result.intradayState.axisStyles.y].forEach(assertVisibleAxisLabel);
    assert.strictEqual(result.intradayState.subHidden, true, JSON.stringify(result.intradayState));
    assert.strictEqual(result.intradayState.addSubHidden, true, JSON.stringify(result.intradayState));
    assert.strictEqual(result.klineRestoredState.subVisible, true, JSON.stringify(result.klineRestoredState));
    assert.strictEqual(result.klineRestoredState.addSubVisible, true, JSON.stringify(result.klineRestoredState));
    assert.ok(/MACD/.test(result.subTipMacdText) && /DIF/.test(result.subTipMacdText) && /DEA/.test(result.subTipMacdText), result.subTipMacdText);
    assert.ok(/KDJ/.test(result.subTipKdjText) && /\bK\b/.test(result.subTipKdjText) && /\bD\b/.test(result.subTipKdjText) && /\bJ\b/.test(result.subTipKdjText), result.subTipKdjText);
    assert.ok(/RSI/.test(result.subTipRsiText) && /RSI6/.test(result.subTipRsiText) && /RSI12/.test(result.subTipRsiText) && /RSI24/.test(result.subTipRsiText), result.subTipRsiText);
    [result.subAxisMacd, result.subAxisKdj, result.subAxisRsi].forEach((axis) => {
      assert.ok(/\d{1,2}\/\d{1,2}/.test(axis.x), JSON.stringify(axis));
      assert.ok(/^-?\d+(\.\d+)?/.test(axis.y), JSON.stringify(axis));
    });
    [
      result.subAxisStyles.macd.x,
      result.subAxisStyles.macd.y,
      result.subAxisStyles.kdj.x,
      result.subAxisStyles.kdj.y,
      result.subAxisStyles.rsi.x,
      result.subAxisStyles.rsi.y,
    ].forEach(assertVisibleAxisLabel);
    assert.ok(Array.isArray(result.multiSubStates) && result.multiSubStates.length >= 3, JSON.stringify(result.multiSubStates));
	    result.multiSubStates.slice(0, 3).forEach((sub) => {
	      assert.ok(/\d{1,2}\/\d{1,2}/.test(sub.axisX), JSON.stringify(sub));
	      assert.ok(/^-?\d+(\.\d+)?/.test(sub.axisY), JSON.stringify(sub));
	      assert.ok(/MACD|KDJ|RSI/.test(sub.tip), JSON.stringify(sub));
	      assert.ok(sub.owner, JSON.stringify(sub));
	      [sub.axisStyles.x, sub.axisStyles.y].forEach(assertViewportAxisLabel);
	    });
    assert.ok(Array.isArray(result.edgeHoverStates) && result.edgeHoverStates.length >= 4, JSON.stringify(result.edgeHoverStates));
    result.edgeHoverStates.slice(0, 4).forEach((item) => {
      assert.ok(item.owner, JSON.stringify(item));
      assert.ok(/\d{1,2}\/\d{1,2}/.test(item.axisX), JSON.stringify(item));
      assert.ok(/^-?\d+(\.\d+)?/.test(item.axisY) || /^量 /.test(item.axisY), JSON.stringify(item));
      assert.ok(item.tip, JSON.stringify(item));
	      [item.axisStyles.x, item.axisStyles.y].forEach(item.canvasVisibleInViewport ? assertViewportAxisLabel : assertVisibleAxisLabel);
	    });
	    assert.strictEqual(result.defaultWatchGroupDeleteState.present, true, JSON.stringify(result.defaultWatchGroupDeleteState));
	    assert.strictEqual(result.defaultWatchGroupDeleteState.defaultDeleteCount, 0, JSON.stringify(result.defaultWatchGroupDeleteState));
	    assert.strictEqual(result.customWatchGroupDeleteState.present, true, JSON.stringify(result.customWatchGroupDeleteState));
	    assert.strictEqual(result.customWatchGroupDeleteState.deletable, true, JSON.stringify(result.customWatchGroupDeleteState));
	    assert.strictEqual(result.builtinConditionContainerCount, 1, `builtinConditionContainerCount=${result.builtinConditionContainerCount}`);
	    assert.strictEqual(result.promptVisible, true);
    assert.strictEqual(result.promptTitle, '新建自选分组');
    assert.strictEqual(result.importVisible, true);
    assert.strictEqual(result.importEscClosed, true);
    assert.strictEqual(result.importRole, 'dialog');
    assert.strictEqual(result.importAria, 'true');
	    assert.strictEqual(result.formulaImportVisible, true);
	    assert.strictEqual(result.formulaImportEscClosed, true);
	    assert.strictEqual(result.formulaImportRole, 'dialog');
	    assert.strictEqual(result.formulaImportAria, 'true');
	    assert.strictEqual(result.screenerScroll.conditionScrollable, true, JSON.stringify(result.screenerScroll));
	    assert.strictEqual(result.screenerScroll.firstConditionClearOfButton, true, JSON.stringify(result.screenerScroll));
	    assert.strictEqual(result.screenerScroll.lastConditionVisible, true, JSON.stringify(result.screenerScroll));
	    assert.strictEqual(result.screenerScroll.runButtonBelowConditions, true, JSON.stringify(result.screenerScroll));
	    assert.strictEqual(result.screenerScroll.runButtonVisible, true, JSON.stringify(result.screenerScroll));
	    assert.strictEqual(result.screenerScroll.resultScrollable, true, JSON.stringify(result.screenerScroll));
	    assert.strictEqual(result.screenerScroll.lastResultVisible, true, JSON.stringify(result.screenerScroll));
	    assert.strictEqual(result.screenerScroll.resultClearOfTabbar, true, JSON.stringify(result.screenerScroll));
	    assert.strictEqual(result.confirmVisible, true);
    assert.strictEqual(result.confirmTitle, '删除研究计划');
    assert.ok(/1 条/.test(result.planCount), result.planCount);
    assert.strictEqual(result.modalVisible, true);
    assert.strictEqual(result.dataStatusRole, 'dialog');
    assert.strictEqual(result.dataStatusAria, 'true');

    const modalText = await waitForEval(cdp, `(() => {
      const el = document.querySelector('#dataStatusBody');
      return el && el.innerText.includes('AI 可读数据') ? el.innerText : '';
    })()`, 8000);
    assert.ok(modalText.includes('运行方式') && modalText.includes('Codex'), modalText);
    assert.ok(modalText.includes('已接入应用数据'), modalText);
    assert.ok(modalText.includes('自选股'), modalText);
    assert.ok(modalText.includes('公式'), modalText);
    assert.ok(modalText.includes('API Key'), modalText);
    assert.ok(modalText.includes('Base URL'), modalText);
    assert.ok(modalText.includes('软件版本'), modalText);
    assert.ok(modalText.includes('当前版本'), modalText);
    assert.ok(modalText.includes('更新检测'), modalText);
    assert.strictEqual(/本地AI回复|Codex数据入口|Codex数据已注入/.test(modalText), false, modalText);
    assert.strictEqual(/127\.0\.0\.1|https?:\/\/|入口地址/.test(modalText), false, modalText);
    assert.strictEqual(/缓存文件|用户文件|\/Users\/|\/var\/|user-state\.json|market-snapshot\.json|codex-data|latest-context\.json|[A-Za-z]:\\/.test(modalText), false, modalText);
    assert.ok(modalText.includes('缓存状态'), modalText);
    assert.ok(modalText.includes('本地存储'), modalText);
	    const dataStatusEscClosed = await evaluate(cdp, `(() => {
	      const mask = document.querySelector('#dataStatusMask');
	      const done = document.querySelector('#dataStatusDone');
	      done.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	      return !mask.classList.contains('show');
	    })()`);
	    assert.strictEqual(dataStatusEscClosed, true);
	    const realMouseChartStates = await verifyRealMouseChartLabels(cdp, sampleKlineCode);
	    assert.ok(Array.isArray(realMouseChartStates) && realMouseChartStates.length >= 8, JSON.stringify(realMouseChartStates));
	    function assertRealMouseMain(main) {
	      assert.ok(main.owner, JSON.stringify(main));
	      assert.ok(/\d{1,2}\/\d{1,2}/.test(main.axisX), JSON.stringify(main));
	      assert.ok(/^-?\d+(\.\d+)?/.test(main.axisY) || /^量 /.test(main.axisY), JSON.stringify(main));
	      assert.strictEqual(main.repaintPreserved, true, JSON.stringify(main));
	      [main.axisStyles.x, main.axisStyles.y].forEach(assertVisibleAxisLabel);
	      assertOnlyHoveredChartLabel(main);
	    }
	    function assertRealMouseSub(sub) {
	      assert.ok(sub.owner, JSON.stringify(sub));
	      assert.ok(/\d{1,2}\/\d{1,2}/.test(sub.axisX), JSON.stringify(sub));
	      assert.ok(/^-?\d+(\.\d+)?/.test(sub.axisY), JSON.stringify(sub));
	      assert.ok(/MACD|KDJ|RSI/.test(sub.tip), JSON.stringify(sub));
	      assert.strictEqual(sub.repaintPreserved, true, JSON.stringify(sub));
	      [sub.axisStyles.x, sub.axisStyles.y].forEach(sub.canvas && sub.canvas.visibleInViewport ? assertViewportAxisLabel : assertVisibleAxisLabel);
	    }
	    function visibleChartLabels(items) {
	      return (Array.isArray(items) ? items : []).filter((item) => item && item.owner && item.axisX && item.axisY && item.tip);
	    }
	    function assertOnlyHoveredChartLabel(state) {
	      assert.ok(Array.isArray(state.visibleLabelStates), JSON.stringify(state));
	      const visible = visibleChartLabels(state.visibleLabelStates);
	      assert.strictEqual(visible.length, 1, JSON.stringify(state.visibleLabelStates));
	      assert.strictEqual(visible[0].owner, state.owner, JSON.stringify({ state, visible }));
	      assert.ok(/\d{1,2}\/\d{1,2}/.test(visible[0].axisX), JSON.stringify(visible[0]));
	      assert.ok(/^-?\d+(\.\d+)?/.test(visible[0].axisY) || /^量 /.test(visible[0].axisY), JSON.stringify(visible[0]));
	      [visible[0].axisStyles.x, visible[0].axisStyles.y].forEach(visible[0].canvasVisibleInViewport ? assertViewportAxisLabel : assertVisibleAxisLabel);
	      assert.ok(state.groupRepainted >= 4, JSON.stringify(state));
	      assert.ok(Array.isArray(state.afterGroupRepaintStates) && state.afterGroupRepaintStates.length >= 4, JSON.stringify(state));
	      const afterVisible = visibleChartLabels(state.afterGroupRepaintStates);
	      assert.strictEqual(afterVisible.length, 1, JSON.stringify(state.afterGroupRepaintStates));
	      assert.strictEqual(afterVisible[0].owner, state.owner, JSON.stringify({ state, afterVisible }));
	    }
	    assertRealMouseMain(realMouseChartStates[0]);
	    realMouseChartStates.slice(1, 4).forEach((state) => {
	      assertRealMouseSub(state);
	      assertOnlyHoveredChartLabel(state);
	    });
	    assertRealMouseMain(realMouseChartStates[4]);
	    realMouseChartStates.slice(5, 8).forEach((state) => {
	      assertRealMouseSub(state);
	      assertOnlyHoveredChartLabel(state);
	    });
	    const formulaMaintenance = await evaluate(cdp, `(async () => {
	      function delay(ms) {
	        return new Promise((resolve) => setTimeout(resolve, ms));
	      }
	      async function waitFor(fn, label) {
	        const started = Date.now();
	        while (Date.now() - started < 5000) {
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
	      function customFormulas() {
	        return JSON.parse(localStorage.getItem('costock.formulas') || '[]');
	      }
	      document.querySelector('[data-tab="formula"]').click();
	      await waitFor(() => document.querySelector('#formulaSaveBtn') && document.querySelector('#formulaDeleteBtn'), 'formula maintenance controls');
	      const kdjFormulaItem = Array.from(document.querySelectorAll('#formulaTemplates li[data-fkey]')).find((li) => li.innerText.includes('KDJ低位金叉'));
	      if (!kdjFormulaItem) throw new Error('missing builtin KDJ formula');
	      kdjFormulaItem.click();
	      await waitFor(() => /KDJ低位金叉/.test(document.querySelector('#formulaActiveMeta').textContent), 'builtin KDJ formula selected');
	      const builtinKdjFormula = document.querySelector('#formulaEditor').value;
	      document.querySelector('#formulaCheckBtn').click();
	      const builtinKdjStatus = document.querySelector('#formulaStatus').textContent.trim();
	      const builtinDeleteDisabled = document.querySelector('#formulaDeleteBtn').disabled;
	      const builtinSaveLabel = document.querySelector('#formulaSaveBtn').textContent.trim();
	      document.querySelector('#formulaRunBtn').click();
	      await waitFor(() => /测试标的：/.test(document.querySelector('#formulaResult').innerText), 'formula run result');
	      const formulaRunStatus = document.querySelector('#formulaStatus').textContent.trim();
	      const formulaRunText = document.querySelector('#formulaResult').innerText;
	      const formulaRunRows = Array.from(document.querySelectorAll('#formulaResult tr')).map((row) => row.innerText.trim());
	      const editor = document.querySelector('#formulaEditor');
	      editor.value = 'XG: UNKNOWN_FN(C);';
	      editor.dispatchEvent(new Event('input', { bubbles: true }));
	      document.querySelector('#formulaRunBtn').click();
	      await waitFor(() => /运行错误：/.test(document.querySelector('#formulaResult').innerText), 'formula invalid run result');
	      const invalidRunStatus = document.querySelector('#formulaStatus').textContent.trim();
	      const invalidRunText = document.querySelector('#formulaResult').innerText;
	      editor.value = 'XG: C > REF(C,1);';
	      editor.dispatchEvent(new Event('input', { bubbles: true }));
	      document.querySelector('#formulaNewBtn').click();
	      await waitFor(() => {
	        const mask = document.querySelector('#promptMask');
	        const title = document.querySelector('#promptTitle');
	        return mask && mask.classList.contains('show') && title && title.textContent.trim() === '保存公式';
	      }, 'formula save prompt');
	      fillPrompt('Smoke维护公式');
	      await waitFor(() => {
	        const mask = document.querySelector('#promptMask');
	        const title = document.querySelector('#promptTitle');
	        return mask && mask.classList.contains('show') && title && title.textContent.trim() === '公式分组';
	      }, 'formula group prompt');
	      fillPrompt('Smoke维护');
	      await waitFor(() => customFormulas().some((item) => item.name === 'Smoke维护公式'), 'formula saved');
	      const metaAfterSave = document.querySelector('#formulaActiveMeta').textContent.trim();
	      editor.value = 'XG: C > MA(C,5);';
	      editor.dispatchEvent(new Event('input', { bubbles: true }));
	      document.querySelector('#formulaSaveBtn').click();
	      await waitFor(() => {
	        const f = customFormulas().find((item) => item.name === 'Smoke维护公式');
	        return f && /MA\\(C,5\\)/.test(f.code);
	      }, 'formula updated');
	      const countAfterUpdate = customFormulas().filter((item) => item.name === 'Smoke维护公式').length;
	      document.querySelector('#formulaDeleteBtn').click();
	      await waitFor(() => {
	        const mask = document.querySelector('#promptMask');
	        const title = document.querySelector('#promptTitle');
	        return mask && mask.classList.contains('show') && title && title.textContent.trim() === '删除公式';
	      }, 'formula delete confirm');
	      document.querySelector('#promptOk').click();
	      await waitFor(() => !customFormulas().some((item) => item.name === 'Smoke维护公式'), 'formula deleted');
	      const activeMetaAfterDelete = document.querySelector('#formulaActiveMeta').textContent.trim();
	      document.querySelector('[data-tab="market"]').click();
	      return {
	        builtinKdjFormula,
	        builtinKdjStatus,
	        builtinDeleteDisabled,
	        builtinSaveLabel,
	        formulaRunStatus,
	        formulaRunText,
	        formulaRunRows,
	        invalidRunStatus,
	        invalidRunText,
	        metaAfterSave,
	        countAfterUpdate,
	        deleted: !customFormulas().some((item) => item.name === 'Smoke维护公式'),
	        activeMetaAfterDelete
	      };
	    })()`);
	    assert.ok(/RSV/.test(formulaMaintenance.builtinKdjFormula) && /SMA\(\s*RSV\s*,\s*3\s*,\s*1\s*\)/.test(formulaMaintenance.builtinKdjFormula) && /CROSS\(\s*K\s*,\s*D\s*\)/.test(formulaMaintenance.builtinKdjFormula), formulaMaintenance.builtinKdjFormula);
	    assert.ok(/语法正确|运行成功/.test(formulaMaintenance.builtinKdjStatus), formulaMaintenance.builtinKdjStatus);
	    assert.strictEqual(formulaMaintenance.builtinDeleteDisabled, true);
	    assert.strictEqual(formulaMaintenance.builtinSaveLabel, '另存');
	    assert.strictEqual(formulaMaintenance.formulaRunStatus, '✓ 运行成功', JSON.stringify(formulaMaintenance));
	    assert.ok(/测试标的：/.test(formulaMaintenance.formulaRunText), formulaMaintenance.formulaRunText);
	    assert.ok(/选股判定：/.test(formulaMaintenance.formulaRunText), formulaMaintenance.formulaRunText);
	    assert.ok(Array.isArray(formulaMaintenance.formulaRunRows) && formulaMaintenance.formulaRunRows.some((row) => /XG\s+\(选股\)/.test(row)), JSON.stringify(formulaMaintenance));
	    assert.ok(/^✗ 不支持的函数: UNKNOWN_FN\(\)/.test(formulaMaintenance.invalidRunStatus), formulaMaintenance.invalidRunStatus);
	    assert.ok(/运行错误：不支持的函数: UNKNOWN_FN\(\)/.test(formulaMaintenance.invalidRunText), formulaMaintenance.invalidRunText);
	    assert.ok(formulaMaintenance.metaAfterSave.includes('自建') && formulaMaintenance.metaAfterSave.includes('Smoke维护公式'), JSON.stringify(formulaMaintenance));
	    assert.strictEqual(formulaMaintenance.countAfterUpdate, 1);
	    assert.strictEqual(formulaMaintenance.deleted, true);
	    assert.ok(formulaMaintenance.activeMetaAfterDelete.includes('内置'), JSON.stringify(formulaMaintenance));
	    const workflowCoverage = await evaluate(cdp, `(async () => {
	      function delay(ms) {
	        return new Promise((resolve) => setTimeout(resolve, ms));
	      }
	      async function waitFor(fn, label, timeoutMs) {
	        const started = Date.now();
	        const timeout = timeoutMs || 6000;
	        while (Date.now() - started < timeout) {
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
	      function storageObject(key) {
	        return JSON.parse(localStorage.getItem(key) || '{}');
	      }
	      function canvasInk(canvas) {
	        if (!canvas) return { missing: true, nonBlank: 0, colored: 0, width: 0, height: 0 };
	        const ctx = canvas.getContext('2d');
	        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
	        let nonBlank = 0;
	        let colored = 0;
	        for (let i = 0; i < data.length; i += 4 * 29) {
	          const r = data[i];
	          const g = data[i + 1];
	          const b = data[i + 2];
	          const a = data[i + 3];
	          if (a && (r < 245 || g < 245 || b < 245)) nonBlank += 1;
	          if (a && (Math.abs(r - g) > 30 || Math.abs(r - b) > 30 || Math.abs(g - b) > 30)) colored += 1;
	        }
	        return { missing: false, nonBlank, colored, width: canvas.width, height: canvas.height };
	      }

	      const quotes = window.CoStockData.listStocks().filter((q) => q && q.code && q.name);
	      const importCodes = [];
	      if (window.CoStockData.getQuote('600519')) importCodes.push('600519');
	      quotes.forEach((q) => {
	        if (importCodes.length < 2 && importCodes.indexOf(q.code) < 0) importCodes.push(q.code);
	      });
	      if (importCodes.length < 2) throw new Error('not enough quotes for watch import workflow');

	      document.querySelector('[data-tab="watch"]').click();
	      document.querySelector('#watchImport').click();
	      await waitFor(() => document.querySelector('#importMask').classList.contains('show'), 'watch import opened');
	      const importGroup = document.querySelector('#importGroup');
	      if (importGroup.querySelector('option[value="观察"]')) importGroup.value = '观察';
	      const importText = document.querySelector('#importText');
	      importText.value = importCodes[0] + '\\n' + importCodes[1] + '\\nNOT_A_STOCK';
	      importText.dispatchEvent(new Event('input', { bubbles: true }));
	      document.querySelector('#importParse').click();
	      await waitFor(() => /无法识别\\s*<b>1<\\/b>/.test(document.querySelector('#importPreview').innerHTML), 'watch import preview');
	      const previewText = document.querySelector('#importPreview').innerText;
	      document.querySelector('#importConfirm').click();
	      await waitFor(() => {
	        const watch = storageArray('costock.watch');
	        const groups = storageObject('costock.watchGroups');
	        return importCodes.every((code) => watch.indexOf(code) >= 0 && groups['观察'] && groups['观察'].indexOf(code) >= 0);
	      }, 'watch import persisted');
	      const watchSearch = document.querySelector('#watchSearch');
	      watchSearch.value = importCodes[0];
	      watchSearch.dispatchEvent(new Event('input', { bubbles: true }));
	      await waitFor(() => document.querySelector('#watchList').innerText.includes(importCodes[0]), 'watch search result');
	      const watchGroups = storageObject('costock.watchGroups');
	      const watchCanvasInk = canvasInk(document.querySelector('#watchDetailView .main-chart'));
	      const watchImport = {
	        imported: importCodes.slice(),
	        previewHasBad: previewText.indexOf('无法识别 1 项') >= 0,
	        groupCount: watchGroups['观察'] ? watchGroups['观察'].filter((code) => importCodes.indexOf(code) >= 0).length : 0,
	        listHasCode: document.querySelector('#watchList').innerText.includes(importCodes[0]),
	        detailHasCode: document.querySelector('#watchDetailView').innerText.includes(importCodes[0]),
	        chartInk: watchCanvasInk
	      };

	      document.querySelector('[data-tab="formula"]').click();
	      document.querySelector('#formulaImport').click();
	      await waitFor(() => document.querySelector('#fImportMask').classList.contains('show'), 'formula import opened');
	      const fImportGroup = document.querySelector('#fImportGroup');
	      if (fImportGroup.querySelector('option[value="自建"]')) fImportGroup.value = '自建';
	      const fText = document.querySelector('#fImportText');
	      fText.value = 'Smoke导入公式: XG: C > REF(C,1);\\nSmoke坏公式: XG: CROSS(C,);';
	      fText.dispatchEvent(new Event('input', { bubbles: true }));
	      document.querySelector('#fImportParse').click();
	      await waitFor(() => /可导入\\s*<b>1<\\/b>/.test(document.querySelector('#fImportPreview').innerHTML), 'formula import preview');
	      const formulaPreview = document.querySelector('#fImportPreview').innerText;
	      document.querySelector('#fImportConfirm').click();
	      await waitFor(() => storageArray('costock.formulas').some((item) => item.name === 'Smoke导入公式'), 'formula imported');
	      const formulas = storageArray('costock.formulas');
	      const formulaImport = {
	        imported: formulas.some((item) => item.name === 'Smoke导入公式' && /REF\\(C,1\\)/.test(item.code)),
	        badRejected: !formulas.some((item) => item.name === 'Smoke坏公式') && formulaPreview.indexOf('语法错误 1 条') >= 0,
	        activeMeta: document.querySelector('#formulaActiveMeta').textContent.trim()
	      };

	      document.querySelector('[data-tab="screener"]').click();
	      const formulaRadio = document.querySelector('input[name="screenMode"][value="formula"]');
	      formulaRadio.click();
	      await waitFor(() => !document.querySelector('#formulaCondition').classList.contains('hidden'), 'formula screen mode');
	      const screenFormula = document.querySelector('#screenFormula');
	      screenFormula.value = 'XG: C > 0;';
	      screenFormula.dispatchEvent(new Event('input', { bubbles: true }));
	      document.querySelector('#screenStrategySave').click();
	      await waitFor(() => document.querySelector('#promptMask').classList.contains('show') && document.querySelector('#promptTitle').textContent.trim() === '保存选股策略', 'formula strategy prompt');
	      fillPrompt('Smoke公式选股策略');
	      const savedStrategy = await waitFor(() => storageArray('costock.screeningStrategies').find((item) => item.name === 'Smoke公式选股策略'), 'formula strategy saved');
	      screenFormula.value = 'XG: C < 0;';
	      screenFormula.dispatchEvent(new Event('input', { bubbles: true }));
	      const strategySelect = document.querySelector('#screenStrategySelect');
	      strategySelect.value = savedStrategy.id;
	      strategySelect.dispatchEvent(new Event('change', { bubbles: true }));
	      await waitFor(() => document.querySelector('#screenFormula').value.indexOf('C > 0') >= 0, 'formula strategy loaded');
	      document.querySelector('#runScreenBtn').click();
	      await waitFor(() => storageArray('costock.screeningResults').length > 0 && /命中\\s+\\d+\\s+只/.test(document.querySelector('#screenStatus').textContent), 'formula screen run', 10000);
	      const matched = storageArray('costock.screeningResults').length;
	      const firstPlanBtn = await waitFor(() => document.querySelector('#screenResults [data-plan]'), 'screen result plan button');
	      const planCode = firstPlanBtn.dataset.plan;
	      document.querySelector('#screenStrategyDelete').click();
	      await waitFor(() => document.querySelector('#promptMask').classList.contains('show') && document.querySelector('#promptTitle').textContent.trim() === '删除选股策略', 'delete strategy confirm');
	      document.querySelector('#promptOk').click();
	      await waitFor(() => !storageArray('costock.screeningStrategies').some((item) => item.id === savedStrategy.id), 'formula strategy deleted');
	      const formulaScreener = {
	        savedType: savedStrategy.type,
	        loadedFormula: document.querySelector('#screenFormula').value,
	        matched,
	        deleted: !storageArray('costock.screeningStrategies').some((item) => item.id === savedStrategy.id)
	      };

	      firstPlanBtn.click();
	      await waitFor(() => !document.querySelector('[data-panel="plans"]').classList.contains('hidden'), 'plans panel from screener');
	      const planSearch = document.querySelector('#planSearch');
	      planSearch.value = planCode;
	      planSearch.dispatchEvent(new Event('input', { bubbles: true }));
	      await waitFor(() => document.querySelector('#planList').innerText.includes(planCode), 'plan search result');
	      const toggle = await waitFor(() => document.querySelector('#planDetailView [data-plan-toggle]'), 'plan status toggle');
	      toggle.click();
	      await waitFor(() => document.querySelector('#planDetailView').innerText.includes('已完成'), 'plan marked done');
	      const doneVisible = document.querySelector('#planDetailView').innerText.includes('已完成') && document.querySelector('#planList').innerText.includes('已完成');
	      const openPlan = document.querySelector('#planDetailView [data-plan-open]');
	      openPlan.click();
	      await waitFor(() => !document.querySelector('[data-panel="market"]').classList.contains('hidden') && document.querySelector('#detailView').innerText.includes(planCode), 'plan opens stock');
	      const planWorkflow = {
	        code: planCode,
	        searchVisible: document.querySelector('#detailView').innerText.includes(planCode),
	        doneVisible,
	        openedMarket: !document.querySelector('[data-panel="market"]').classList.contains('hidden')
	      };

	      return { watchImport, formulaImport, formulaScreener, planWorkflow };
	    })()`);
	    assert.strictEqual(workflowCoverage.watchImport.previewHasBad, true, JSON.stringify(workflowCoverage.watchImport));
	    assert.strictEqual(workflowCoverage.watchImport.groupCount, 2, JSON.stringify(workflowCoverage.watchImport));
	    assert.strictEqual(workflowCoverage.watchImport.listHasCode, true, JSON.stringify(workflowCoverage.watchImport));
	    assert.strictEqual(workflowCoverage.watchImport.detailHasCode, true, JSON.stringify(workflowCoverage.watchImport));
	    assert.ok(workflowCoverage.watchImport.chartInk && workflowCoverage.watchImport.chartInk.colored > 100, JSON.stringify(workflowCoverage.watchImport));
	    assert.strictEqual(workflowCoverage.formulaImport.imported, true, JSON.stringify(workflowCoverage.formulaImport));
	    assert.strictEqual(workflowCoverage.formulaImport.badRejected, true, JSON.stringify(workflowCoverage.formulaImport));
	    assert.ok(workflowCoverage.formulaImport.activeMeta.includes('Smoke导入公式'), JSON.stringify(workflowCoverage.formulaImport));
	    assert.strictEqual(workflowCoverage.formulaScreener.savedType, 'formula', JSON.stringify(workflowCoverage.formulaScreener));
	    assert.ok(/C\s*>\s*0/.test(workflowCoverage.formulaScreener.loadedFormula), JSON.stringify(workflowCoverage.formulaScreener));
	    assert.ok(workflowCoverage.formulaScreener.matched > 0, JSON.stringify(workflowCoverage.formulaScreener));
	    assert.strictEqual(workflowCoverage.formulaScreener.deleted, true, JSON.stringify(workflowCoverage.formulaScreener));
	    assert.ok(/^\d{6}$/.test(workflowCoverage.planWorkflow.code), JSON.stringify(workflowCoverage.planWorkflow));
	    assert.strictEqual(workflowCoverage.planWorkflow.doneVisible, true, JSON.stringify(workflowCoverage.planWorkflow));
	    assert.strictEqual(workflowCoverage.planWorkflow.openedMarket, true, JSON.stringify(workflowCoverage.planWorkflow));
	    await evaluate(cdp, `(() => {
	      const input = document.querySelector('#aiAsk');
	      input.value = '数据接入了吗，Codex工具能访问什么？';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#aiAskBtn').click();
    })()`);
    let aiChatText = '';
    try {
      aiChatText = await waitForEval(cdp, `(() => {
        const stream = document.querySelector('#aiStream');
        const text = stream ? stream.innerText : '';
        return text.includes('Codex 未就绪') && text.includes('自选股') && text.includes('公式') ? text : '';
      })()`, 16000);
    } catch (err) {
      const aiDebug = await evaluate(cdp, `(() => {
        const stream = document.querySelector('#aiStream');
        const input = document.querySelector('#aiAsk');
        const runtime = document.querySelector('#aiRuntime');
        const last = stream ? stream.querySelector('.ai-msg:last-child') : null;
        return {
          streamText: stream ? stream.innerText : '',
          runtimeText: runtime ? runtime.innerText : '',
          inputValue: input ? input.value : '',
          lastText: last ? last.innerText : '',
          typingCount: stream ? stream.querySelectorAll('.ai-typing').length : 0,
          buttonHandler: !!(document.querySelector('#aiAskBtn') && document.querySelector('#aiAskBtn').onclick)
        };
      })()`);
      throw new Error(`${err.message}\nAI debug: ${JSON.stringify(aiDebug)}`);
    }
    assert.ok(aiChatText.includes('真实/延迟数据') || aiChatText.includes('本地/缓存数据'), aiChatText);
    assert.ok(aiChatText.includes('本次已准备当前应用数据'), aiChatText);
    assert.ok(aiChatText.includes('Codex 未就绪'), aiChatText);
    assert.strictEqual(/本地AI回复|Codex数据入口|Codex数据已注入/.test(aiChatText), false, aiChatText);
    assert.strictEqual(/127\.0\.0\.1|localhost|https?:\/\/|入口地址|App Server|Localhost/.test(aiChatText), false, aiChatText);
    await evaluate(cdp, `document.querySelector('#aiAnalyzeBtn').click()`);
    let aiAnalysisText = '';
    try {
      aiAnalysisText = await waitForEval(cdp, `(() => {
        const stream = document.querySelector('#aiStream');
        const text = stream ? stream.innerText : '';
        return text.includes('观察重点和风险') && text.includes('Codex 未就绪') ? text : '';
      })()`, 12000);
    } catch (err) {
      const aiAnalysisDebug = await evaluate(cdp, `(() => {
        const stream = document.querySelector('#aiStream');
        const last = stream ? stream.querySelector('.ai-msg:last-child') : null;
        return {
          panelText: document.querySelector('[data-panel="market"]') ? document.querySelector('[data-panel="market"]').innerText.slice(0, 300) : '',
          aiContext: document.querySelector('#aiContext') ? document.querySelector('#aiContext').innerText : '',
          streamText: stream ? stream.innerText : '',
          lastText: last ? last.innerText : '',
          typingCount: stream ? stream.querySelectorAll('.ai-typing').length : 0
        };
      })()`);
      throw new Error(`${err.message}\nAI analysis debug: ${JSON.stringify(aiAnalysisDebug)}`);
    }
    assert.ok(aiAnalysisText.includes('Codex 未就绪'), aiAnalysisText);
    assert.strictEqual(/本地AI分析中|技术观察|估值概览|量能观察|风险复核|多 Agent|技术分析师|基本面分析师|情绪分析师|风控专家|后续继续扩展|接入舆情|接入大模型|轻仓|分批操作/.test(aiAnalysisText), false, aiAnalysisText);
	    const marketImportRuntime = await verifyRuntimeMarketImport(cdp);
	    assert.strictEqual(marketImportRuntime.skipped, false, JSON.stringify(marketImportRuntime));
	    assert.strictEqual(marketImportRuntime.statusCount, 2, JSON.stringify(marketImportRuntime));
	    assert.strictEqual(marketImportRuntime.statusKlineCount, 45, JSON.stringify(marketImportRuntime));
	    assert.deepStrictEqual(marketImportRuntime.storeCodes, ['688001', '300001']);
	    assert.deepStrictEqual(marketImportRuntime.rows, ['688001', '300001']);
	    assert.strictEqual(marketImportRuntime.detailHasImportedName, true, JSON.stringify(marketImportRuntime));
	    assert.strictEqual(marketImportRuntime.klineCount, 24, JSON.stringify(marketImportRuntime));
	    assert.strictEqual(marketImportRuntime.quotePrice, 12.35, JSON.stringify(marketImportRuntime));
	    assert.strictEqual(marketImportRuntime.provider, 'runtime-import-smoke.csv', JSON.stringify(marketImportRuntime));
	    assert.strictEqual(marketImportRuntime.dataBadge, '真实/延迟数据', JSON.stringify(marketImportRuntime));
	    assert.ok(marketImportRuntime.chartInk && marketImportRuntime.chartInk.colored > 100, JSON.stringify(marketImportRuntime));

	    console.log(JSON.stringify({
      ok: true,
      url: result.url,
      tabs: result.tabs,
		      aiRuntime: result.aiRuntime,
		      marketProvider: result.marketProvider,
		      marketCount: result.marketCount,
		      marketImportRuntime,
		      sparseChartState: result.sparseChartState,
      sampleKlineCode: result.sampleKlineCode,
      currentKlineCount: result.currentKlineCount,
      viewport: `${result.viewportWidth}x${result.viewportHeight}`,
      trafficSafeWidth: result.trafficSafeWidth,
      brandLeft: result.brandLeft,
      canvasWidth: result.canvasWidth,
      crosshairShown: result.crosshairShown,
      subIndicatorLabels: {
        macd: result.subTipMacdText,
        kdj: result.subTipKdjText,
        rsi: result.subTipRsiText,
      },
      intradayLabel: result.intradayState,
	      promptModal: result.promptTitle,
	      importEscClosed: result.importEscClosed,
	      formulaImportEscClosed: result.formulaImportEscClosed,
	      screenerScroll: result.screenerScroll,
	      dataStatusEscClosed,
	      realMouseChartLabels: realMouseChartStates,
	      formulaMaintenance,
	      aiAnalysisCopyOk: aiAnalysisText.includes('Codex 未就绪'),
      confirmModal: result.confirmTitle,
      modalHasAiDataAccess: modalText.includes('已接入应用数据'),
    }, null, 2));
    if (process.env.COSTOCK_SMOKE_SCREENSHOT) {
      await cdp.send('Page.enable');
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(process.env.COSTOCK_SMOKE_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }
  } finally {
    if (cdp) cdp.close();
    await stopChild(child);
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  if (stderr && /Error|failed/i.test(stderr)) {
    console.error(stderr);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
