const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  storeGet: () => ipcRenderer.invoke('store:get'),
  storeSet: (data) => ipcRenderer.invoke('store:set', data),
  apiTest: (settings) => ipcRenderer.invoke('api:test', settings),
  discoverFromSynaos: (settings) => ipcRenderer.invoke('api:discoverFromSynaos', settings),
  validateResource: (resourceId) => ipcRenderer.invoke('api:validateResource', resourceId),
  createOrderJobs: (payload) => ipcRenderer.invoke('api:createOrderJobs', payload),
  getJob: (jobId) => ipcRenderer.invoke('api:getJob', jobId),
  discardJob: (jobId) => ipcRenderer.invoke('api:discardJob', jobId),
  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
  mpdvCreateOrders: (payload) => ipcRenderer.invoke('mpdv:createOrders', payload),
  mpdvPreview: (cfg) => ipcRenderer.invoke('mpdv:preview', cfg),
  mpdvLog: () => ipcRenderer.invoke('mpdv:log'),
  mpdvClearLog: () => ipcRenderer.invoke('mpdv:clearLog'),
  armTest: (arm) => ipcRenderer.invoke('arm:test', arm),
  armTestPublish: (arm) => ipcRenderer.invoke('arm:testPublish', arm),
  armStatus: () => ipcRenderer.invoke('arm:status'),
  onRelayChanged: (fn) => ipcRenderer.on('relay:changed', () => fn())
});
