const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('onyx', {
  connection: () => ipcRenderer.invoke('connection'),
  pair: () => ipcRenderer.invoke('pair'),
  hide: () => ipcRenderer.send('hide'),
  quit: () => ipcRenderer.send('quit'),
  expand: (open) => ipcRenderer.send('expand', open),
  openApp: (page) => ipcRenderer.send('open-app', page),
  mustStay: (value) => ipcRenderer.send('must-stay', value),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  openSettings: () => ipcRenderer.send('open-settings'),
  onFocusInput: (fn) => ipcRenderer.on('focus-input', fn),
  onWidgetState: (fn) => ipcRenderer.on('widget-state', (_e, open) => fn(open)),
  onGoto: (fn) => ipcRenderer.on('goto', (_e, page) => fn(page)),
})
