/**
 * npm run autostart              start Onyx when you sign in to Windows
 * npm run autostart -- --remove  stop doing that
 * node scripts/autostart.mjs --start-menu   add a Start menu shortcut
 */

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../core/config.mjs'

const appData = process.env.APPDATA
const startMenu = process.argv.includes('--start-menu')
const folder = startMenu
  ? join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  : join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
const link = join(folder, 'Onyx.lnk')

if (process.argv.includes('--remove')) {
  if (existsSync(link)) rmSync(link)
  console.log(`Removed ${link}`)
  process.exit(0)
}

const ps = (s) => s.replace(/'/g, "''")
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${ps(link)}');` +
      `$s.TargetPath='${ps(process.execPath)}';` +
      `$s.Arguments='"${ps(join(ROOT, 'scripts', 'start.mjs'))}"${startMenu ? ' --show' : ''}';` +
      `$s.WorkingDirectory='${ps(ROOT)}';` +
      `$s.IconLocation='${ps(join(ROOT, 'app', 'icon.ico'))}';` +
      `$s.WindowStyle=7;` +
      `$s.Description='Onyx AI agent';$s.Save()`,
  ],
  { stdio: 'inherit' },
)
console.log(`Created ${link}`)
