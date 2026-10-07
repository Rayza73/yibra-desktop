// Runs in the page before Yibra's JS. Exposes a tiny, safe API as
// window.yibraDesktop so the Vue app can detect it's inside the desktop shell.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yibraDesktop', {
  isDesktop: true,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('yibra:version'),
  retry: () => ipcRenderer.send('yibra:retry'),

  // Game activity (v0.4.0) - used by the web app's useGameActivity.ts.
  setGames: (games) => ipcRenderer.send('yibra:set-games', games),
  onActivity: (cb) => {
    ipcRenderer.removeAllListeners('yibra:activity'); // page re-registers on reload
    ipcRenderer.on('yibra:activity', (_e, game) => cb(game));
    ipcRenderer.send('yibra:activity-subscribe');
  },
});
