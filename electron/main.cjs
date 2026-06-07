const { app, BrowserWindow, dialog, ipcMain, safeStorage, screen, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createStore: createUserStateStore } = require('./user-state.cjs');
const { parseMarketFile } = require('./market-file.cjs');
const { createEastmoneySnapshot, fetchKLines, fetchTencentIntraday, normalizeCode } = require('./market-eastmoney.cjs');
const { createAiAppServer } = require('./ai-app-server.cjs');
const { createAiSettingsStore } = require('./ai-settings.cjs');
const { createCodexExecEnv, resolveCodexBin } = require('./codex-cli.cjs');
const { AI_READABLE_TOOLS, buildCodexExecArgs, enrichAiPayload: enrichAiPayloadWithData } = require('./ai-payload.cjs');
const { createUpdateService } = require('./update-service.cjs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const MARKET_SOURCE_PATH = path.join(__dirname, '..', 'prototype', 'js', 'market-source.js');
let marketStore = null;
let userStateStore = null;
let aiAppServer = null;
let aiSettingsStore = null;
let updateService = null;
let latestRendererAiContext = null;

function getMarketStatePath() {
  return path.join(app.getPath('userData'), 'market-snapshot.json');
}

function getUserStatePath() {
  return path.join(app.getPath('userData'), 'user-state.json');
}

function getCodexDataSnapshotPath() {
  return path.join(app.getPath('userData'), 'codex-data', 'latest-context.json');
}

function getAiSettingsPath() {
  return path.join(app.getPath('userData'), 'ai-settings.json');
}

function safeStorageOps() {
  return {
    encrypt(value) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
      return safeStorage.encryptString(String(value || '')).toString('base64');
    },
    decrypt(value) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
      return safeStorage.decryptString(Buffer.from(String(value || ''), 'base64'));
    },
  };
}

function loadMarketSource() {
  if (!fs.existsSync(MARKET_SOURCE_PATH)) {
    throw new Error('缺少 market-source.js');
  }
  return require(MARKET_SOURCE_PATH);
}

function ensureMarketStore() {
  if (!marketStore) {
    const marketSource = loadMarketSource();
    let snapshot = null;
    try {
      if (process.env.COSTOCK_MARKET_SNAPSHOT) {
        snapshot = parseMarketFile(process.env.COSTOCK_MARKET_SNAPSHOT);
      }
    } catch (err) {
      snapshot = null;
    }
    try {
      const statePath = getMarketStatePath();
      if (!snapshot && fs.existsSync(statePath)) {
        snapshot = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      }
    } catch (err) {
      snapshot = null;
    }
    marketStore = marketSource.createStore(snapshot || marketSource.createMockSnapshot());
  }
  return marketStore;
}

function persistMarketSnapshot(snapshot) {
  try {
    const statePath = getMarketStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (err) {}
}

function ensureUserStateStore() {
  if (!userStateStore) {
    userStateStore = createUserStateStore(getUserStatePath());
  }
  return userStateStore;
}

function ensureAiAppServer() {
  if (!aiAppServer) {
    aiAppServer = createAiAppServer({
      getMarketStore: ensureMarketStore,
      getUserStateStore: ensureUserStateStore,
      getRendererContext: () => latestRendererAiContext,
    });
  }
  return aiAppServer;
}

function ensureAiSettingsStore() {
  if (!aiSettingsStore) {
    aiSettingsStore = createAiSettingsStore(getAiSettingsPath(), safeStorageOps());
  }
  return aiSettingsStore;
}

function ensureUpdateService() {
  if (!updateService) {
    updateService = createUpdateService({
      currentVersion: app.getVersion(),
      repository: process.env.SUANPAN_UPDATE_REPOSITORY || 'YersiniaHerb/suanpan-desktop',
      timeoutMs: Number(process.env.SUANPAN_UPDATE_TIMEOUT_MS || 8000),
      startupDelayMs: Number(process.env.SUANPAN_UPDATE_STARTUP_DELAY_MS || 6000),
      intervalMs: Number(process.env.SUANPAN_UPDATE_INTERVAL_MS || 6 * 60 * 60 * 1000),
    });
  }
  return updateService;
}

function broadcastUpdateStatus(status) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('costock:update:status', status);
  });
}

function windowSizeFromEnv(name, fallback, min) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(min, Math.round(value));
}

function createWindowBounds() {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const minWidth = Math.min(1280, workArea.width);
  const minHeight = Math.min(840, workArea.height);
  const width = Math.min(windowSizeFromEnv('COSTOCK_WINDOW_WIDTH', 1600, minWidth), workArea.width);
  const height = Math.min(windowSizeFromEnv('COSTOCK_WINDOW_HEIGHT', 960, minHeight), workArea.height);
  return {
    x: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2)),
    y: workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2)),
    width,
    height,
    minWidth,
    minHeight,
  };
}

function createWindow() {
  const bounds = createWindowBounds();
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: bounds.minWidth,
    minHeight: bounds.minHeight,
    backgroundColor: '#f5f5f7',
    title: '算盘',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('costock:update:status', ensureUpdateService().getStatus());
  });

  win.loadFile(path.join(__dirname, '..', 'prototype', 'index.html'));
}

ipcMain.handle('costock:market:getSnapshot', async () => {
  return ensureMarketStore().getSnapshot();
});

ipcMain.handle('costock:market:getStatus', async () => {
  return {
    ...ensureMarketStore().getStatus(),
    path: getMarketStatePath(),
  };
});

ipcMain.handle('costock:market:hydrateSnapshot', async (_event, snapshot) => {
  const status = ensureMarketStore().hydrate(snapshot);
  persistMarketSnapshot(ensureMarketStore().getSnapshot());
  return status;
});

ipcMain.handle('costock:market:refreshLive', async (_event, options) => {
  const current = ensureMarketStore().getSnapshot();
  const codes = current.stocks.map((stock) => stock.code);
  const universe = (options && options.universe) || process.env.COSTOCK_LIVE_UNIVERSE || (current.stocks.length > 500 ? 'a-share' : 'current');
  const quoteLimit = Number(process.env.COSTOCK_LIVE_QUOTE_LIMIT || (options && options.quoteLimit) || (universe === 'a-share' ? 6000 : 80));
  const klineCodeLimit = Number(process.env.COSTOCK_LIVE_KLINE_CODES || (options && options.klineCodeLimit) || (universe === 'a-share' ? 1 : 30));
  const klineLimit = Number(process.env.COSTOCK_LIVE_KLINE_BARS || (options && options.klineLimit) || 250);
  const timeoutMs = Number(process.env.COSTOCK_LIVE_TIMEOUT_MS || (options && options.timeoutMs) || 8000);
  const includeBeijing = !!(options && options.includeBeijing);
  const snapshot = await createEastmoneySnapshot({
    baseSnapshot: current,
    codes,
    universe,
    quoteLimit,
    klineCodeLimit,
    klineLimit,
    priorityQuoteCodes: options && options.priorityQuoteCodes,
    priorityKlineCodes: (options && options.priorityKlineCodes) || (options && options.priorityQuoteCodes) || codes,
    disableAShareFallback: !!(options && options.disableAShareFallback),
    aShareFallbackQuoteLimit: options && options.aShareFallbackQuoteLimit,
    aShareStartPage: options && options.aShareStartPage,
    aSharePageCount: options && options.aSharePageCount,
    includeBeijing,
    timeoutMs,
  });
  const status = ensureMarketStore().hydrate(snapshot);
  persistMarketSnapshot(ensureMarketStore().getSnapshot());
  return { status, snapshot: ensureMarketStore().getSnapshot() };
});

ipcMain.handle('costock:market:refreshKLine', async (_event, options) => {
  const code = normalizeCode(options && options.code);
  if (!code) throw new Error('股票代码无效');
  const current = ensureMarketStore().getSnapshot();
  const stock = current.stocks.find((item) => item.code === code);
  if (!stock) throw new Error('未找到该股票');
  const limit = Number((options && options.limit) || process.env.COSTOCK_LIVE_KLINE_BARS || 250);
  const klines = await fetchKLines(code, { limit, timeoutMs: 8000, market: stock.market });
  if (!klines.length) throw new Error('未获取到日K');
  const next = {
    ...current,
    source: 'network',
    provider: current.provider || 'network',
    connected: current.connected !== false,
    updatedAt: Date.now(),
    note: `${current.note || '外部延迟行情'}；${code} 日K已更新 ${klines.length} 根`,
    stocks: current.stocks.map((item) => item.code === code ? { ...item, klines } : item),
  };
  const status = ensureMarketStore().hydrate(next);
  persistMarketSnapshot(ensureMarketStore().getSnapshot());
  return { status, snapshot: ensureMarketStore().getSnapshot(), code, klineCount: klines.length };
});

ipcMain.handle('costock:market:refreshIntraday', async (_event, options) => {
  const code = normalizeCode(options && options.code);
  if (!code) throw new Error('股票代码无效');
  const current = ensureMarketStore().getSnapshot();
  const stock = current.stocks.find((item) => item.code === code);
  if (!stock) throw new Error('未找到该股票');
  const points = await fetchTencentIntraday(code, {
    market: stock.market,
    quote: stock.quote,
    points: Number((options && options.points) || 240),
    timeoutMs: Number((options && options.timeoutMs) || 8000),
  });
  if (!points.length) throw new Error('未获取到分时数据');
  const next = {
    ...current,
    source: 'network',
    provider: current.provider && !/tencent-intraday/.test(current.provider)
      ? `${current.provider}+tencent-intraday`
      : (current.provider || 'tencent-intraday'),
    connected: current.connected !== false,
    updatedAt: Date.now(),
    note: `${current.note || '外部延迟行情'}；${code} 分时已更新 ${points.length} 点`,
    stocks: current.stocks.map((item) => item.code === code ? { ...item, intraday: points } : item),
  };
  const status = ensureMarketStore().hydrate(next);
  persistMarketSnapshot(ensureMarketStore().getSnapshot());
  return { status, snapshot: ensureMarketStore().getSnapshot(), code, intradayCount: points.length };
});

ipcMain.handle('costock:market:importFile', async () => {
  const result = await dialog.showOpenDialog({
    title: '导入行情快照',
    properties: ['openFile'],
    filters: [
      { name: 'Market snapshot', extensions: ['json', 'csv', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const snapshot = parseMarketFile(result.filePaths[0]);
  const status = ensureMarketStore().hydrate(snapshot);
  persistMarketSnapshot(ensureMarketStore().getSnapshot());
  return { canceled: false, status, snapshot: ensureMarketStore().getSnapshot() };
});

ipcMain.handle('costock:user:getState', async () => {
  return ensureUserStateStore().getState();
});

ipcMain.handle('costock:user:setState', async (_event, nextState) => {
  return ensureUserStateStore().setState(nextState);
});

ipcMain.handle('costock:user:patchState', async (_event, patch) => {
  return ensureUserStateStore().patchState(patch);
});

ipcMain.handle('costock:user:resetState', async () => {
  return ensureUserStateStore().resetState();
});

ipcMain.handle('costock:user:getStatus', async () => {
  return ensureUserStateStore().getStatus();
});

ipcMain.handle('costock:ai-app-server:getInfo', async () => {
  return ensureAiAppServer().getInfo();
});

function latest(arr) {
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
}

function codexBackendMode() {
  const raw = String(process.env.COSTOCK_CODEX_BACKEND || 'exec').toLowerCase();
  if (raw === 'local' || raw === 'local-fallback' || raw === 'off' || raw === 'false') return 'disabled';
  return 'exec';
}

function codexSandboxMode() {
  const raw = String(process.env.COSTOCK_CODEX_SANDBOX || 'read-only').toLowerCase();
  if (raw === 'danger-full-access' || raw === 'workspace-write' || raw === 'read-only') return raw;
  return 'read-only';
}

function codexCanReachLocalhost() {
  return codexSandboxMode() === 'danger-full-access';
}

function aiRuntimeStatus() {
  const mode = codexBackendMode();
  const sandbox = codexSandboxMode();
  const codexCli = resolveCodexBin(process.env);
  const execReady = mode === 'exec' && codexCli.ok;
  const settings = ensureAiSettingsStore().publicState();
  return {
    backend: {
      mode,
      source: execReady ? 'codex-exec' : 'codex-unavailable',
      enabled: execReady,
      adapter: execReady ? 'codex-cli-exec' : 'codex-unavailable',
      sandbox,
      dataInjection: true,
      codexCli: {
        available: codexCli.ok,
        source: codexCli.source,
        message: codexCli.ok ? '' : codexCli.message,
      },
      localhostDataGatewayReachable: codexCanReachLocalhost(),
      note: mode === 'exec'
        ? (codexCli.ok
          ? 'AI chat is routed through local Codex CLI exec. The prompt includes an embedded Suanpan data snapshot; localhost data gateway access requires COSTOCK_CODEX_SANDBOX=danger-full-access.'
          : 'Codex CLI was not found; AI chat is unavailable until Codex CLI is available.')
        : 'Codex chat is disabled by COSTOCK_CODEX_BACKEND.',
    },
    appServer: ensureAiAppServer().getInfo(),
    settings,
    readableTools: AI_READABLE_TOOLS.slice(),
  };
}

function aiResponseMeta(payload, source, connected) {
  const context = payload && payload.context ? payload.context : {};
  const dataStatus = context.dataStatus || context.marketStatus || {};
  const appServer = context.dataAccess && context.dataAccess.aiAppServer;
  const dataConnected = dataStatus.marketDataConnected != null ? dataStatus.marketDataConnected : dataStatus.connected;
  return {
    ok: true,
    connected: !!connected,
    backendConnected: !!connected,
    dataConnected: !!dataConnected,
    appServerRunning: !!(appServer && appServer.running),
    appServerOrigin: appServer && appServer.origin ? appServer.origin : null,
    source,
  };
}

ipcMain.handle('costock:ai:getStatus', async () => {
  return aiRuntimeStatus();
});

ipcMain.handle('costock:ai-settings:get', async () => {
  return ensureAiSettingsStore().publicState();
});

ipcMain.handle('costock:ai-settings:save', async (_event, patch) => {
  return ensureAiSettingsStore().save(patch);
});

ipcMain.handle('costock:update:getStatus', async () => {
  return ensureUpdateService().getStatus();
});

ipcMain.handle('costock:update:check', async () => {
  const status = await ensureUpdateService().check('renderer');
  broadcastUpdateStatus(status);
  return status;
});

function enrichAiPayload(payload) {
  return enrichAiPayloadWithData(payload, {
    getMarketStore: ensureMarketStore,
    getUserStateStore: ensureUserStateStore,
    getAiAppServerInfo: () => ensureAiAppServer().getInfo(),
    getSnapshotPath: getCodexDataSnapshotPath,
    codexCanReachLocalhost,
    setRendererContext: (context) => { latestRendererAiContext = context; },
    readableTools: AI_READABLE_TOOLS,
  });
}

function codexUnavailableResponse(payload, reason) {
  const context = payload && payload.context ? payload.context : {};
  const userState = context.userState || {};
  const watchlist = context.watchlist || {};
  const watchCodes = Array.isArray(watchlist.codes) ? watchlist.codes : (Array.isArray(userState.watch) ? userState.watch : []);
  const formulas = Array.isArray(userState.formulas)
    ? userState.formulas
    : (context.formula && Array.isArray(context.formula.all) ? context.formula.all : []);
  const dataStatus = context.dataStatus || context.marketStatus || {};
  const connected = dataStatus.marketDataConnected != null ? dataStatus.marketDataConnected : dataStatus.connected;
  const dataText = `本次已准备当前应用数据：行情、自选股${watchCodes.length ? ` ${watchCodes.length} 只` : ''}、公式${formulas.length ? ` ${formulas.length} 条` : ''}、选股结果和研究计划。`;
  const marketText = connected
    ? `当前行情为真实/延迟数据，覆盖 ${dataStatus.count || 0} 只股票${dataStatus.klineCount ? `、${dataStatus.klineCount} 根K线` : ''}。`
    : '当前行情为本地/缓存数据。';
  const text = `${dataText}${marketText} Codex 未就绪，请在 AI 设置中检查 API Key 和 Base URL，或确认 Codex 可执行。`;

  return {
    ...aiResponseMeta(payload, 'codex-unavailable', false),
    ok: false,
    reason,
    text,
    consensus: context.consensus || latest(context.history) || null,
  };
}

function callCodexExec(payload) {
  return new Promise((resolve, reject) => {
    const codexCli = resolveCodexBin(process.env);
    if (!codexCli.ok) {
      reject(new Error(codexCli.message || 'Codex CLI executable was not found'));
      return;
    }
    const aiSettings = ensureAiSettingsStore().privateState();
    const args = buildCodexExecArgs(payload, codexSandboxMode(), { aiSettings });
    const prompt = [
      '你是算盘桌面端内置的只读研究助手。',
      '只能基于传入 JSON 中的算盘数据回答；只有 dataStatus 证明接入时，才可说明使用的是真实/延迟行情，不得称为交易级实时行情。',
      '默认先读 payload.context.codexDataSnapshot；这是随聊天注入的紧凑摘要，包含重点行情报价、本地自选、公式、选股、研究计划、AI 历史/共识和相关 K 线索引。',
      '如需完整已加载行情、完整本地用户状态和渲染器上下文，读取 payload.context.dataAccess.codexDataSnapshotFile.path 指向的 JSON 文件；本 Codex 进程已用 --add-dir 授权该文件所在目录。',
      '只有当 payload.context.dataAccess.aiAppServer.codexReachable 为 true 时，才可通过其中的本机只读入口字段补充读取数据；否则不要尝试访问本机入口。',
      '最终回复不得披露内部地址、Header 名称、token 或本机网络细节；对用户只称为当前应用数据或 AI 可读数据。',
      '不要生成下单或外部操作指令；当前产品只支持研究观察和风险提示。',
      '用中文，简洁回答。',
      '',
      JSON.stringify(payload, null, 2),
    ].join('\n');
    const child = spawn(codexCli.bin, args, {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: createCodexExecEnv(process.env, codexCli.bin, aiSettings),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Codex exec timed out'));
    }, 45000);
    child.stdout.on('data', (buf) => { stdout += buf.toString(); });
    child.stderr.on('data', (buf) => { stderr += buf.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error((stderr || stdout || `Codex exited with code ${code}`).trim()));
    });
    child.stdin.end(prompt);
  });
}

ipcMain.handle('costock:ai-chat', async (_event, payload) => {
  const enrichedPayload = enrichAiPayload(payload);
  try {
    if (codexBackendMode() === 'exec') {
      const text = await callCodexExec(enrichedPayload);
      return { ...aiResponseMeta(enrichedPayload, 'codex-exec', true), text };
    }
    return codexUnavailableResponse(enrichedPayload, 'Codex CLI chat backend is disabled.');
  } catch (err) {
    return codexUnavailableResponse(enrichedPayload, err && err.message ? err.message : String(err));
  }
});

app.whenReady().then(() => {
  ensureAiAppServer().start().catch((err) => {
    console.error('Suanpan AI app-server failed to start:', err && err.message ? err.message : err);
  });
  ensureUpdateService().start(broadcastUpdateStatus);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
