/**
 * npm start: (re)start Onyx: the core, the window, and voice if it is on.
 *
 * Anything already running is shut down first, so after an update or a
 * settings change, `npm start` always gives you the current Onyx. If admin
 * mode is set up (npm run elevate), Onyx is launched through it.
 *
 *   npm start           restart and show the window
 *   npm run stop        stop Onyx completely
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PYTHON, ROOT, accessToken, loadConfig } from '../core/config.mjs'
import { coreAlive, coreUrl } from '../core/launch.mjs'

const config = loadConfig()
const stopOnly = process.argv.includes('--stop')

async function stopRunning() {
  if (await coreAlive(config)) {
    try {
      await fetch(`${coreUrl(config)}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${accessToken()}` } })
    } catch {}
    for (let i = 0; i < 40 && (await coreAlive(config)); i++) await new Promise((r) => setTimeout(r, 250))
  }
  // Leftovers from an older Onyx that did not know how to shut its window down.
  try {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -like '*${ROOT.replace(/'/g, "''")}*' -and $_.Name -in @('electron.exe','python.exe','node.exe') -and $_.CommandLine -notlike '*scripts\\start.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ])
  } catch {}
}

const elevatedTask = () => spawnSync('schtasks', ['/query', '/tn', 'Onyx'], { stdio: 'ignore' }).status === 0

if (!existsSync(PYTHON)) {
  console.error('The Python environment is missing: run `npm run setup` first.')
  process.exit(1)
}

await stopRunning()
if (stopOnly) {
  console.log('Onyx stopped.')
  process.exit(0)
}

if (elevatedTask()) {
  spawnSync('schtasks', ['/run', '/tn', 'Onyx'], { stdio: 'ignore' })
  console.log('Onyx started with admin rights.')
} else {
  const electron = createRequire(import.meta.url)('electron')
  spawn(electron, [ROOT, '--show'], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref()
  console.log('Onyx started.')
}
console.log(`Open it any time with ${config.hotkey} (or the tray icon).`)
if (config.voice.enabled) {
  console.log(`Voice: say "${config.voice.wakeWord.replace('_', ' ')}" or press ${config.voice.pushToTalk}.`)
}
