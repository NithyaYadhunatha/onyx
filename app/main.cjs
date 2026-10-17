/**
 * Onyx on the desktop: a small widget that sits in the bottom-right corner,
 * and the full app (chat history, activity, tasks, phone, settings) that it
 * opens when you want more.
 *
 * The widget is a round button; click it (or press the hotkey) and it opens
 * into a compact chat. It opens by itself when Onyx needs your OK or has a
 * question. Onyx starts only when you start it: nothing runs at sign-in.
 */

const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, ipcMain, nativeImage, screen, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const ICON = path.join(__dirname, 'icon.png')

// Admin mode (npm run elevate) is a scheduled task that runs Onyx with admin
// rights on demand. Opened any other way, hand over to it so Onyx is elevated.
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

const ORB = 56
const PANEL = { width: 380, height: 560 }
const MARGIN = 18

let widget = null
let full = null
let expanded = false
let tray = null
let quitting = false
let core = null

async function loadCore() {
  const cfg = await import(pathToFileURL(path.join(ROOT, 'core', 'config.mjs')).href)
  const launch = await import(pathToFileURL(path.join(ROOT, 'core', 'launch.mjs')).href)
  const config = cfg.loadConfig()
  await launch.ensureCore(config, { quiet: true })
  return { config, token: cfg.accessToken(), dataPath: cfg.dataPath, launch }
}

const webPreferences = {
  preload: path.join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}

/** Page errors go to logs/app.log: the window has no console to show them. */
function logPage(w, name) {
  const file = core.dataPath(path.join('logs', 'app.log'))
  const write = (line) => fs.appendFile(file, `${new Date().toISOString()} [${name}] ${line}\n`, () => {})
  w.webContents.on('console-message', (e) => {
    const level = e.level ?? e.params?.level
    if (level === 'error' || level === 3 || level === 'warning' || level === 2) write(`${e.message ?? e.params?.message} (${e.sourceId ?? ''}:${e.lineNumber ?? ''})`)
  })
  w.webContents.on('render-process-gone', (_e, d) => write(`page crashed: ${d.reason}`))
  w.webContents.on('did-fail-load', (_e, code, desc) => write(`failed to load: ${code} ${desc}`))
}

function guard(w) {
  // Links open in the real browser, never inside Onyx.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e) => e.preventDefault())
}

// ---------------------------------------------------------------- widget

function cornerBounds(width, height) {
  const { workArea } = screen.getPrimaryDisplay()
  return { x: workArea.x + workArea.width - width - MARGIN, y: workArea.y + workArea.height - height - MARGIN, width, height }
}

function createWidget() {
  widget = new BrowserWindow({
    ...cornerBounds(ORB, ORB),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: 'Onyx',
    backgroundColor: '#00000000',
    webPreferences,
  })
  widget.setAlwaysOnTop(true, 'floating')
  // Right-click the corner button for the essentials, including Quit.
  widget.webContents.on('context-menu', () =>
    Menu.buildFromTemplate([
      { label: 'Open full app', click: () => openFull() },
      { label: 'Settings', click: () => openFull('settings') },
      { label: 'Stop what Onyx is doing', click: () => core.launch.stopRequest(core.config).catch(() => {}) },
      { type: 'separator' },
      { label: 'Quit Onyx', click: quitAll },
    ]).popup({ window: widget }),
  )
  logPage(widget, 'widget')
  widget.loadFile(path.join(__dirname, 'index.html'), { query: { mode: 'widget' } })
  widget.once('ready-to-show', () => widget.showInactive())
  widget.on('close', (e) => {
    if (!quitting) e.preventDefault()
  })
  // Keep it in the corner if the screen or taskbar changes.
  screen.on('display-metrics-changed', () => setExpanded(expanded, false))
  guard(widget)
}

function setExpanded(open, focus = true) {
  if (!widget) return
  expanded = open
  const b = open ? cornerBounds(PANEL.width, PANEL.height) : cornerBounds(ORB, ORB)
  widget.setBounds(b)
  widget.webContents.send('widget-state', open)
  if (!widget.isVisible()) widget.showInactive()
  if (open && focus) {
    widget.show()
    widget.focus()
    widget.webContents.send('focus-input')
  }
}

// ---------------------------------------------------------------- full app

function openFull(page) {
  if (!full) {
    const { workArea } = screen.getPrimaryDisplay()
    full = new BrowserWindow({
      width: Math.min(1180, workArea.width - 80),
      height: Math.min(780, workArea.height - 60),
      center: true,
      minWidth: 760,
      minHeight: 520,
      show: false,
      title: 'Onyx',
      icon: path.join(__dirname, 'icon.ico'),
      backgroundColor: '#0a0a0a',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0a0a0a', symbolColor: '#a3a3a3', height: 40 },
      webPreferences,
    })
    logPage(full, 'app')
    full.loadFile(path.join(__dirname, 'index.html'), { query: { mode: 'app', page: page ?? 'chat' } })
    full.once('ready-to-show', () => full.show())
    full.on('close', (e) => {
      if (!quitting) {
        e.preventDefault()
        full.hide()
      }
    })
    guard(full)
    return
  }
  if (page) full.webContents.send('goto', page)
  if (full.isMinimized()) full.restore()
  full.show()
  full.focus()
}

// ---------------------------------------------------------------- core watchdog

/** If the core dies, start it again: the window must never sit there disconnected. */
function watchCore() {
  let restarting = false
  setInterval(async () => {
    if (quitting || restarting) return
    if (await core.launch.coreAlive(core.config)) return
    restarting = true
    try {
      await core.launch.ensureCore(core.config, { quiet: true })
    } catch (err) {
      console.error('[onyx] could not restart the core:', err.message)
    } finally {
      restarting = false
    }
  }, 5000)
}

// ---------------------------------------------------------------- shell

function registerHotkey(accelerator) {
  const toggle = () => setExpanded(!expanded)
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
  tray.on('click', () => setExpanded(true))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Ask Onyx${hotkey ? `    ${hotkey}` : ''}`, click: () => setExpanded(true) },
      { label: 'Open full app', click: () => openFull() },
      { label: 'Settings', click: () => openFull('settings') },
      { label: 'Stop what Onyx is doing', click: () => core.launch.stopRequest(core.config).catch(() => {}) },
      { type: 'separator' },
      { label: 'Quit Onyx', click: quitAll },
    ]),
  )
}

const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender)

ipcMain.handle('connection', () => ({ port: core.config.port, token: core.token, hotkey: core.hotkey }))
ipcMain.handle('pair', async () => {
  const res = await fetch(`http://127.0.0.1:${core.config.port}/pair`, { headers: { authorization: `Bearer ${core.token}` } })
  const pair = await res.json()
  const QR = require('qrcode')
  pair.qr = {}
  for (const u of pair.urls ?? []) pair.qr[u] = await QR.toDataURL(u, { margin: 1, width: 400, color: { dark: '#000000', light: '#ffffff' } })
  return pair
})
ipcMain.on('expand', (_e, open) => setExpanded(Boolean(open)))
ipcMain.on('open-app', (_e, page) => {
  openFull(typeof page === 'string' ? page : undefined)
  setExpanded(false, false)
})
ipcMain.on('hide', (e) => {
  const w = senderWindow(e)
  if (w === widget) setExpanded(false, false)
  else w?.hide()
})
// The core is shutting down (a restart or Quit): close Onyx too.
ipcMain.on('quit', () => {
  quitting = true
  app.exit(0)
})
ipcMain.on('must-stay', (e, value) => {
  // An approval or question is waiting: make sure you can see it.
  if (value && senderWindow(e) === widget && !expanded) setExpanded(true, false)
})
ipcMain.on('notify', (_e, { title, body }) => {
  if (BrowserWindow.getFocusedWindow()) return
  const n = new Notification({ title: String(title), body: String(body), icon: ICON })
  n.on('click', () => setExpanded(true))
  n.show()
})
ipcMain.on('open-settings', () => openFull('settings'))
ipcMain.on('quit-all', () => quitAll())

app.setAppUserModelId('Onyx')
app.on('second-instance', () => setExpanded(true))
app.whenReady().then(async () => {
  try {
    core = await loadCore()
  } catch (err) {
    const { dialog } = require('electron')
    dialog.showErrorBox('Onyx could not start', String(err.message ?? err))
    app.exit(1)
    return
  }
  createWidget()
  core.hotkey = registerHotkey(core.config.hotkey)
  buildTray(core.hotkey)
  watchCore()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', (e) => e.preventDefault())
