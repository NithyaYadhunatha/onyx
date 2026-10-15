/**
 * Shortcuts to Onyx.
 *
 *   node scripts/autostart.mjs --desktop      desktop icon
 *   node scripts/autostart.mjs --start-menu   Start menu entry
 *   npm run autostart                         start Onyx when you sign in
 *   add --remove to any of these to delete that shortcut
 *
 * Every shortcut opens the Onyx window directly. If admin mode is on
 * (npm run elevate), the window relaunches itself with admin rights.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ROOT } from '../core/config.mjs'

const has = (f) => process.argv.includes(f)
const where = has('--desktop') ? 'desktop' : has('--start-menu') ? 'start-menu' : 'startup'

function folderFor(kind) {
  if (kind === 'desktop') {
    // The real Desktop, which OneDrive may have moved.
    return execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' }).trim()
  }
  const programs = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  return kind === 'start-menu' ? programs : join(programs, 'Startup')
}

const link = join(folderFor(where), 'Onyx.lnk')

if (has('--remove')) {
  if (existsSync(link)) rmSync(link)
  console.log(`Removed ${link}`)
  process.exit(0)
}

const electron = createRequire(import.meta.url)('electron')
const ps = (s) => String(s).replace(/'/g, "''")
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${ps(link)}');` +
      `$s.TargetPath='${ps(electron)}';` +
      `$s.Arguments='"${ps(ROOT)}"${where === 'startup' ? '' : ' --show'}';` +
      `$s.WorkingDirectory='${ps(ROOT)}';` +
      `$s.IconLocation='${ps(join(ROOT, 'app', 'icon.ico'))},0';` +
      `$s.Description='Onyx: your AI agent';$s.Save()`,
  ],
  { stdio: 'inherit' },
)
console.log(`Created ${link}`)
