const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('costockBridge', {
  platform: process.platform,
  versions: process.versions,
  aiChat: (payload) => ipcRenderer.invoke('costock:ai-chat', payload),
  ai: {
    getStatus: () => ipcRenderer.invoke('costock:ai:getStatus'),
  },
  aiSettings: {
    get: () => ipcRenderer.invoke('costock:ai-settings:get'),
    save: (settings) => ipcRenderer.invoke('costock:ai-settings:save', settings || {}),
  },
  aiAppServer: {
    getInfo: () => ipcRenderer.invoke('costock:ai-app-server:getInfo'),
  },
  update: {
    getStatus: () => ipcRenderer.invoke('costock:update:getStatus'),
    check: () => ipcRenderer.invoke('costock:update:check'),
    onStatus: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, status) => handler(status);
      ipcRenderer.on('costock:update:status', listener);
      return () => ipcRenderer.removeListener('costock:update:status', listener);
    },
  },
  market: {
    getSnapshot: () => ipcRenderer.invoke('costock:market:getSnapshot'),
    hydrateSnapshot: (snapshot) => ipcRenderer.invoke('costock:market:hydrateSnapshot', snapshot),
    importFile: () => ipcRenderer.invoke('costock:market:importFile'),
    refreshLive: (options) => ipcRenderer.invoke('costock:market:refreshLive', options || {}),
    refreshKLine: (options) => ipcRenderer.invoke('costock:market:refreshKLine', options || {}),
    refreshIntraday: (options) => ipcRenderer.invoke('costock:market:refreshIntraday', options || {}),
    getStatus: () => ipcRenderer.invoke('costock:market:getStatus'),
  },
  user: {
    getState: () => ipcRenderer.invoke('costock:user:getState'),
    setState: (state) => ipcRenderer.invoke('costock:user:setState', state),
    patchState: (patch) => ipcRenderer.invoke('costock:user:patchState', patch),
    resetState: () => ipcRenderer.invoke('costock:user:resetState'),
    getStatus: () => ipcRenderer.invoke('costock:user:getStatus'),
  },
});
