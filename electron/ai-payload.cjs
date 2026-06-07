const fs = require('fs');
const {
  buildCodexDataSnapshot,
  compactCodexDataSnapshot,
  persistCodexDataSnapshot,
} = require('./ai-context.cjs');

const AI_READABLE_TOOLS = [
  'market_status',
  'market_stocks',
  'market_quotes',
  'market_quote',
  'market_klines',
  'market_intraday',
  'market_indicators',
  'watchlist',
  'formulas',
  'formula_screener',
  'builtin_screener',
  'saved_strategies',
  'strategy_screener',
  'screener_results',
  'screener_history',
  'research_plans',
  'ai_history',
  'ai_consensus',
  'user_state',
  'latest_context',
];

function createRendererAiContext(base, context, now) {
  return {
    at: now,
    prompt: base.prompt || '',
    context,
  };
}

function enrichAiPayload(payload, options) {
  const opts = options || {};
  const base = payload && typeof payload === 'object' ? payload : {};
  const context = base.context && typeof base.context === 'object' ? base.context : {};
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  const market = opts.getMarketStore();
  const userStateStore = opts.getUserStateStore();
  const marketStatus = market.getStatus();
  const userState = userStateStore.getState();
  const contextUserState = context.userState && typeof context.userState === 'object' ? context.userState : {};
  const mergedUserState = {
    ...userState,
    ...contextUserState,
    watch: Array.isArray(contextUserState.watch) ? contextUserState.watch : (Array.isArray(userState.watch) ? userState.watch : []),
    watchGroups: contextUserState.watchGroups || userState.watchGroups || {},
    formulas: Array.isArray(contextUserState.formulas) ? contextUserState.formulas : (Array.isArray(userState.formulas) ? userState.formulas : []),
  };
  const rendererContext = createRendererAiContext(base, context, now);
  if (typeof opts.setRendererContext === 'function') opts.setRendererContext(rendererContext);

  const appServerInfo = opts.getAiAppServerInfo ? opts.getAiAppServerInfo() : null;
  const fullCodexSnapshot = buildCodexDataSnapshot(market, marketStatus, mergedUserState, context, rendererContext);
  let snapshotFile = null;
  try {
    snapshotFile = persistCodexDataSnapshot(opts.getSnapshotPath(), fullCodexSnapshot);
  } catch (err) {
    snapshotFile = null;
  }
  const codexCanReachLocalhost = typeof opts.codexCanReachLocalhost === 'function'
    ? !!opts.codexCanReachLocalhost()
    : false;
  const aiAppServer = appServerInfo && appServerInfo.running ? {
    ...appServerInfo,
    codexReachable: codexCanReachLocalhost,
    codexRequiredSandbox: 'danger-full-access',
  } : appServerInfo;
  const readableTools = Array.isArray(opts.readableTools) ? opts.readableTools.slice() : AI_READABLE_TOOLS.slice();

  return {
    ...base,
    context: {
      ...context,
      marketStatus,
      dataStatus: {
        ...(context.dataStatus || {}),
        marketDataConnected: marketStatus.connected,
        source: marketStatus.source,
        provider: marketStatus.provider,
        updatedAt: marketStatus.updatedAt,
        count: marketStatus.count,
        klineCount: marketStatus.klineCount,
        intradayCount: marketStatus.intradayCount,
        note: marketStatus.note,
      },
      userState: mergedUserState,
      watchlist: context.watchlist || {
        codes: mergedUserState.watch || [],
        groups: mergedUserState.watchGroups || {},
      },
      codexDataSnapshot: compactCodexDataSnapshot(fullCodexSnapshot, context),
      dataAccess: {
        ...(context.dataAccess || {}),
        aiAppServer,
        embeddedSnapshot: true,
        codexDataSnapshotFile: snapshotFile ? {
          ...snapshotFile,
          readableViaAddDir: true,
          content: 'complete_loaded_market_user_renderer_context',
        } : null,
        note: snapshotFile
          ? 'Use payload.context.codexDataSnapshot for a compact summary. For complete loaded market/user/renderer data, read payload.context.dataAccess.codexDataSnapshotFile.path; the Codex process is launched with --add-dir for that directory. The data surface is read-only and limited to research data.'
          : (codexCanReachLocalhost
            ? 'Use payload.context.codexDataSnapshot first. The local read-only data gateway is also reachable in this Codex sandbox for full Suanpan research data.'
            : 'Use payload.context.codexDataSnapshot for Suanpan data. The local read-only data gateway is running for the app, but safe Codex sandbox modes cannot reach it; enable COSTOCK_CODEX_SANDBOX=danger-full-access only if local gateway access is required.'),
        availableTools: readableTools,
      },
    },
  };
}

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function appendCodexProviderArgs(args, aiSettings) {
  const settings = aiSettings || {};
  const baseUrl = String(settings.baseUrl || '').trim();
  if (!baseUrl) return;
  args.push('-c', 'model_provider="costock_ui"');
  args.push('-c', 'model_providers.costock_ui.name="Suanpan AI"');
  args.push('-c', 'model_providers.costock_ui.wire_api="responses"');
  args.push('-c', 'model_providers.costock_ui.requires_openai_auth=true');
  args.push('-c', `model_providers.costock_ui.base_url=${tomlString(baseUrl)}`);
}

function buildCodexExecArgs(payload, sandbox, options) {
  const snapshotFile = payload
    && payload.context
    && payload.context.dataAccess
    && payload.context.dataAccess.codexDataSnapshotFile;
  const snapshotDir = snapshotFile && snapshotFile.dir && fs.existsSync(snapshotFile.dir)
    ? snapshotFile.dir
    : '';
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    sandbox,
  ];
  appendCodexProviderArgs(args, options && options.aiSettings);
  if (snapshotDir) args.push('--add-dir', snapshotDir);
  args.push('-');
  return args;
}

module.exports = {
  AI_READABLE_TOOLS,
  buildCodexExecArgs,
  enrichAiPayload,
};
