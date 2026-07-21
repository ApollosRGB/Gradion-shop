const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  storeGet: () => ipcRenderer.invoke('store:get'),
  storeSet: (data) => ipcRenderer.invoke('store:set', data),
  apiTest: (settings) => ipcRenderer.invoke('api:test', settings),
  discoverFromSynaos: (settings) => ipcRenderer.invoke('api:discoverFromSynaos', settings),
  createOrderJobs: (payload) => ipcRenderer.invoke('api:createOrderJobs', payload),
  getJob: (jobId) => ipcRenderer.invoke('api:getJob', jobId),
  discardJob: (jobId) => ipcRenderer.invoke('api:discardJob', jobId),
  pickImage: () => ipcRenderer.invoke('dialog:pickImage')
});
