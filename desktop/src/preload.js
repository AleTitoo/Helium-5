const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('heliumDesktop', {
  getSnapshot: () => ipcRenderer.sendSync('store:get'),
  saveSnapshot: data => ipcRenderer.send('store:save', data),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  fetchCalendar: url => ipcRenderer.invoke('calendar:fetch', url),
  onExportRequest: callback => ipcRenderer.on('menu:export', callback),
  onImportRequest: callback => ipcRenderer.on('menu:import', callback)
});
