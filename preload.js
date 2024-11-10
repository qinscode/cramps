// preload.js
const { contextBridge, ipcRenderer } = require('electron');

function removeAllListeners() {
  ['copy-progress', 'copy-complete', 'copy-error'].forEach(channel => {
    ipcRenderer.removeAllListeners(channel);
  });
}

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: (type) => ipcRenderer.invoke('dialog:openDirectory', type),
  startCopy: (paths) => ipcRenderer.send('start-copy', paths),
  ensureOutputDirectory: () => ipcRenderer.invoke('ensure-output-directory'),
  onProgress: (callback) => {
    ipcRenderer.on('copy-progress', callback);
  },
  onComplete: (callback) => {
    ipcRenderer.on('copy-complete', callback);
  },
  onError: (callback) => {
    ipcRenderer.on('copy-error', callback);
  },
  removeListeners: () => removeAllListeners()
});