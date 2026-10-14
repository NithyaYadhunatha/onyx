const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('onyx', {
  connection: () => ipcRenderer.invoke('connection'),
  pair: () => ipcRenderer.invoke('pair'),
  hide: () => ipcRenderer.send('hide'),
  pin: (value) => ipcRenderer.send('pin', value),
  mustStay: (value) => ipcRenderer.send('must-stay', value),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  openPath: (p) => ipcRenderer.send('open-path', p),
  openSettings: () => ipcRenderer.send('open-settings'),
  onFocusInput: (fn) => ipcRenderer.on('focus-input', fn),
})
