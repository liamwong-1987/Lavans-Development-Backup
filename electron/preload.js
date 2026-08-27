const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lavansWindow', {
  minimize: () => ipcRenderer.invoke('window-control', 'minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window-control', 'toggle-maximize'),
  close: () => ipcRenderer.invoke('window-control', 'close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onWindowState: callback => ipcRenderer.on('window-state', (_event, state) => callback(state))
});

contextBridge.exposeInMainWorld('lavansNav', {
  back: () => ipcRenderer.invoke('nav-back'),
  forward: () => ipcRenderer.invoke('nav-forward'),
  reload: () => ipcRenderer.invoke('nav-reload'),
  loadURL: url => ipcRenderer.invoke('nav-load-url', url),
  getState: () => ipcRenderer.invoke('nav-get-state'),
  onNavState: callback => ipcRenderer.on('nav-state', (_event, state) => callback(state))
});

contextBridge.exposeInMainWorld('lavansUpdater', {
  restart: () => ipcRenderer.invoke('app-relaunch')
});
