const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('thoughtRecoveryDesktop', {
  createSyncSession: () => ipcRenderer.invoke('desktop:create-sync-session'),
  createDefaultVault: () => ipcRenderer.invoke('desktop:create-default-vault'),
  selectVaultDirectory: () => ipcRenderer.invoke('desktop:select-vault-directory'),
  getVaultOverview: (vaultPath) => ipcRenderer.invoke('desktop:get-vault-overview', vaultPath),
  writeSampleNote: (vaultPath) => ipcRenderer.invoke('desktop:write-sample-note', vaultPath),
});
