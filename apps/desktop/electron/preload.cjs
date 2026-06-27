const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('thoughtRecoveryDesktop', {
  createSyncSession: () => ipcRenderer.invoke('desktop:get-sync-session'),
});
