const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('heliumDesktop', {
  getSnapshot: () => ipcRenderer.sendSync('store:get'),
  saveSnapshot: data => ipcRenderer.send('store:save', data),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  fetchCalendar: url => ipcRenderer.invoke('calendar:fetch', url),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  onUpdateState: callback => ipcRenderer.on('update:state', (_event, state) => callback(state)),
  onExportRequest: callback => ipcRenderer.on('menu:export', callback),
  onImportRequest: callback => ipcRenderer.on('menu:import', callback)
});
