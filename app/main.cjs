/**
 * The Onyx window: press the hotkey anywhere in Windows, type, and Onyx does it.
 *
 * Lives in the tray. Starts the core if it is not running. Shows approvals and
 * questions even when hidden, by popping itself up, and shows notifications
 * for background tasks.
 */

const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, ipcMain, nativeImage, screen, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const ICON = path.join(__dirname, 'icon.png')

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win = null
let tray = null
let pinned = false
let mustStay = false // an approval or question is waiting
let core = null // { config, token, dataPath }

async function loadCore() {
  const cfg = await import(pathToFileURL(path.join(ROOT, 'core', 'config.mjs')).href)
  const launch = await import(pathToFileURL(path.join(ROOT, 'core', 'launch.mjs')).href)
  const config = cfg.loadConfig()
  await launch.ensureCore(config, { quiet: true })
  return { config, token: cfg.accessToken(), dataPath: cfg.dataPath, DATA_DIR: cfg.DATA_DIR, launch }
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const width = 720
  const height = 560
  win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height * 0.12),
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 480,
    minHeight: 320,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    icon: ICON,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.loadFile(path.join(__dirname, 'index.html'))
  // Hide when you click away, but only once the window really had focus:
  // Windows sometimes refuses focus to a window that shows itself, and
  // hiding on that first blur would make it vanish before you saw it.
  let hadFocus = false
  win.on('focus', () => {
    hadFocus = true
  })
  win.on('hide', () => {
    hadFocus = false
  })
  win.on('blur', () => {
    if (hadFocus && !pinned && !mustStay && !win.webContents.isDevToolsOpened()) win.hide()
  })
  // Links open in the real browser, never inside Onyx.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
}

function toggle() {
  if (!win) return
  if (win.isVisible() && win.isFocused()) win.hide()
  else show()
}

function show() {
  if (!win) return
  win.show()
  win.focus()
  win.webContents.send('focus-input')
}

function registerHotkey(accelerator) {
  for (const key of [accelerator, 'Control+Alt+Space', 'Alt+Shift+O']) {
    try {
      if (key && globalShortcut.register(key, toggle)) return key
    } catch {}
  }
  return null
}

async function quitAll() {
  try {
    await fetch(`http://127.0.0.1:${core.config.port}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${core.token}` },
    })
  } catch {}
  app.exit(0)
}

function buildTray(hotkey) {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')))
  tray.setToolTip(`Onyx${hotkey ? ` (${hotkey})` : ''}`)
  tray.on('click', show)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open Onyx${hotkey ? `    ${hotkey}` : ''}`, click: show },
      { label: 'Stop what Onyx is doing', click: () => core.launch.stopRequest(core.config).catch(() => {}) },
      { type: 'separator' },
      { label: 'Settings file', click: () => shell.openPath(core.dataPath('config.json')) },
      { label: 'Action logs', click: () => shell.openPath(core.dataPath('logs')) },
      { label: 'Expense workbook', click: () => fs.existsSync(core.config.expenses.workbook) ? shell.openPath(core.config.expenses.workbook) : shell.openPath(path.dirname(core.config.expenses.workbook)) },
      { type: 'separator' },
      { label: 'Quit Onyx', click: quitAll },
    ]),
  )
}

ipcMain.handle('connection', () => ({ port: core.config.port, token: core.token, hotkey: core.hotkey }))
ipcMain.handle('pair', async () => {
  const res = await fetch(`http://127.0.0.1:${core.config.port}/pair`, { headers: { authorization: `Bearer ${core.token}` } })
  const pair = await res.json()
  // QR codes so the phone can just scan.
  const QR = require('qrcode')
  pair.qr = {}
  for (const u of pair.urls ?? []) pair.qr[u] = await QR.toDataURL(u, { margin: 1, width: 400 })
  return pair
})
ipcMain.on('hide', () => win?.hide())
ipcMain.on('pin', (_e, value) => {
  pinned = Boolean(value)
})
ipcMain.on('must-stay', (_e, value) => {
  mustStay = Boolean(value)
  if (mustStay && win && !win.isVisible()) {
    win.showInactive()
    win.flashFrame(true)
  }
})
ipcMain.on('notify', (_e, { title, body }) => {
  if (win?.isVisible() && win.isFocused()) return
  const n = new Notification({ title: String(title), body: String(body), icon: ICON })
  n.on('click', show)
  n.show()
})
ipcMain.on('open-path', (_e, p) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.openPath(p)
})
ipcMain.on('open-settings', () => shell.openPath(core.dataPath('config.json')))

app.setAppUserModelId('Onyx')
app.on('second-instance', show)
app.whenReady().then(async () => {
  try {
    core = await loadCore()
  } catch (err) {
    const { dialog } = require('electron')
    dialog.showErrorBox('Onyx could not start', String(err.message ?? err))
    app.exit(1)
    return
  }
  createWindow()
  core.hotkey = registerHotkey(core.config.hotkey)
  buildTray(core.hotkey)
  if (process.argv.includes('--show') || !core.hotkey) win.once('ready-to-show', show)
  if (!core.hotkey) {
    new Notification({ title: 'Onyx', body: 'Could not register a hotkey. Click the tray icon to open Onyx.', icon: ICON }).show()
  }
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', (e) => e.preventDefault())
