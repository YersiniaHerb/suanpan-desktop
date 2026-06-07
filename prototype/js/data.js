// CoStock 桌面端 - 行情数据门面。
// 默认使用本地/缓存数据；Electron 主进程可通过 IPC 注入真实/延迟数据。
(function (global) {
  'use strict';

  var source = global.CoStockMarketSource;
  if (!source) throw new Error('CoStockMarketSource 未加载');

  var store = source.createStore(source.createMockSnapshot());

  global.CoStockData = {
    setSnapshot: store.setSnapshot,
    hydrate: store.hydrate,
    getStatus: store.getStatus,
    getSnapshot: store.getSnapshot,
    getStocks: store.getStocks,
    listStocks: store.listStocks,
    getQuotes: store.getQuotes,
    getStock: store.getStock,
    getKLines: store.getKLines,
    getIntraday: store.getIntraday,
    getQuote: store.getQuote,
    allCodes: store.allCodes
  };
})(window);
