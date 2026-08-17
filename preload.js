const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  storeGet: () => ipcRenderer.invoke('store:get'),
  storeSet: (data) => ipcRenderer.invoke('store:set', data),
  apiTest: (settings) => ipcRenderer.invoke('api:test', settings),
  discoverFromSynaos: (settings) => ipcRenderer.invoke('api:discoverFromSynaos', settings),
  validateResource: (resourceId) => ipcRenderer.invoke('api:validateResource', resourceId),
  scanResources: (patterns, mode) => ipcRenderer.invoke('api:scanResources', patterns, mode),
  onScanProgress: (fn) => ipcRenderer.on('scan:progress', (_e, p) => fn(p)),
  createOrderJobs: (payload) => ipcRenderer.invoke('api:createOrderJobs', payload),
  getJob: (jobId) => ipcRenderer.invoke('api:getJob', jobId),
  listJobs: (sinceSeconds) => ipcRenderer.invoke('api:listJobs', sinceSeconds),
  discardJob: (jobId) => ipcRenderer.invoke('api:discardJob', jobId),
  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
  syncPublish: (opts) => ipcRenderer.invoke('sync:publish', opts),
  syncFetch: (opts) => ipcRenderer.invoke('sync:fetch', opts),
  syncList: (opts) => ipcRenderer.invoke('sync:list', opts),
  syncOpenTokenPage: () => ipcRenderer.invoke('sync:openTokenPage'),
  mpdvCreateOrders: (payload) => ipcRenderer.invoke('mpdv:createOrders', payload),
  mpdvPreview: (cfg) => ipcRenderer.invoke('mpdv:preview', cfg),
  mpdvCheckRaw: (body) => ipcRenderer.invoke('mpdv:checkRaw', body),
  mpdvLog: () => ipcRenderer.invoke('mpdv:log'),
  mpdvClearLog: () => ipcRenderer.invoke('mpdv:clearLog'),
  armTest: (arm) => ipcRenderer.invoke('arm:test', arm),
  armTestPublish: (arm, armId) => ipcRenderer.invoke('arm:testPublish', arm, armId),
  armStatus: () => ipcRenderer.invoke('arm:status'),
  onRelayChanged: (fn) => ipcRenderer.on('relay:changed', () => fn())
});
