// Runs in the page before Yibra's JS. Exposes a tiny, safe API as
// window.yibraDesktop so the Vue app can detect it's inside the desktop shell.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yibraDesktop', {
  isDesktop: true,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('yibra:version'),
  retry: () => ipcRenderer.send('yibra:retry'),
});
