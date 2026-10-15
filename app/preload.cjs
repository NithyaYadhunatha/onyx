const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('onyx', {
  connection: () => ipcRenderer.invoke('connection'),
  pair: () => ipcRenderer.invoke('pair'),
  hide: () => ipcRenderer.send('hide'),
  quit: () => ipcRenderer.send('quit'),
  mustStay: (value) => ipcRenderer.send('must-stay', value),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  openSettings: () => ipcRenderer.send('open-settings'),
  onFocusInput: (fn) => ipcRenderer.on('focus-input', fn),
})
