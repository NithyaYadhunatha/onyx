/**
 * npm start: the core, the hotkey window, and voice if it is turned on.
 *
 * The core runs detached, so closing this terminal leaves Onyx running in the
 * tray. Quit it from the tray icon.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { PYTHON, ROOT, loadConfig } from '../core/config.mjs'
import { ensureCore } from '../core/launch.mjs'

const config = loadConfig()
if (!existsSync(PYTHON)) {
  console.error('The Python environment is missing: run `npm run setup` first.')
  process.exit(1)
}

await ensureCore(config)
console.log('Onyx core is running.')

const electron = createRequire(import.meta.url)('electron')
const app = spawn(electron, [ROOT, ...(process.argv.includes('--show') ? ['--show'] : [])], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
})
app.unref()
console.log(`Onyx window ready: press ${config.hotkey} anywhere (or click the tray icon).`)

if (config.voice.enabled) {
  const voice = spawn(PYTHON, ['-X', 'utf8', join(ROOT, 'voice', 'voice.py')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  voice.unref()
  console.log(`Voice is on: say "${config.voice.wakeWord.replace('_', ' ')}" or press ${config.voice.pushToTalk}.`)
}
