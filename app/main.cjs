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

// Admin mode (npm run elevate) is a scheduled task that starts Onyx with admin
// rights. When Onyx is opened any other way (desktop icon, Start menu), hand
// over to that task so it always runs elevated.
{
  const { spawnSync } = require('node:child_process')
  const isAdmin = spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true }).status === 0
  const hasTask = !isAdmin && spawnSync('schtasks', ['/query', '/tn', 'Onyx'], { stdio: 'ignore', windowsHide: true }).status === 0
  if (hasTask) {
    spawnSync('schtasks', ['/run', '/tn', 'Onyx'], { stdio: 'ignore', windowsHide: true })
    process.exit(0)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win = null
let tray = null
let pinned = false
let quitting = false
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
  const width = Math.min(1220, workArea.width - 80)
  const height = Math.min(800, workArea.height - 60)
  win = new BrowserWindow({
    width,
    height,
    center: true,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Onyx',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#09090d',
    // Our own dark title bar, with Windows' real minimise/maximise/close
    // buttons drawn on top of it.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#09090d', symbolColor: '#b8b2d6', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.loadFile(path.join(__dirname, 'index.html'))
  // Closing the window keeps Onyx running in the tray; Quit is in the tray menu.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
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
  for (const key of [accelerator, 'Alt+Shift+O']) {
    try {
      if (key && globalShortcut.register(key, toggle)) return key
    } catch {}
  }
  return null
}

async function quitAll() {
  quitting = true
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
// The core is shutting down (a restart or Quit): close this window too.
ipcMain.on('quit', () => {
  quitting = true
  app.exit(0)
})
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
