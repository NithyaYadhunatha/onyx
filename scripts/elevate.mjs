/**
 * Admin mode:  npm run elevate          (npm run elevate -- --remove to undo)
 *
 * Registers a Windows scheduled task, "Onyx", that runs Onyx with admin rights
 * when you start it (it never starts on its own). After that:
 *   - app installs and updates run without Windows' "allow changes?" prompt
 *   - Onyx can see and control admin windows too (Task Manager, installers)
 *   - `npm start` and the desktop icon launch Onyx through the task
 *
 * Windows asks you once to confirm (UAC), because only an administrator can
 * create a task that runs with admin rights.
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import { ROOT } from '../core/config.mjs'

const remove = process.argv.includes('--remove')
const electron = createRequire(import.meta.url)('electron')
const user = `${process.env.USERDOMAIN ?? ''}\\${userInfo().username}`.replace(/^\\/, '')
const q = (s) => `'${String(s).replace(/'/g, "''")}'`

const script = remove
  ? `Unregister-ScheduledTask -TaskName Onyx -Confirm:$false -ErrorAction SilentlyContinue`
  : [
      `$a = New-ScheduledTaskAction -Execute ${q(electron)} -Argument ${q(`"${ROOT}" --show`)} -WorkingDirectory ${q(ROOT)}`,
      `$p = New-ScheduledTaskPrincipal -UserId ${q(user)} -LogonType Interactive -RunLevel Highest`,
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew`,
      `Register-ScheduledTask -TaskName Onyx -Description 'Onyx AI agent, with admin rights' -Action $a -Principal $p -Settings $s -Force | Out-Null`,
    ].join('; ')

// Run the registration in an elevated PowerShell (this is the UAC prompt).
const encoded = Buffer.from(script, 'utf16le').toString('base64')
const r = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'; exit $p.ExitCode`,
  ],
  { stdio: 'inherit' },
)

const exists = spawnSync('schtasks', ['/query', '/tn', 'Onyx'], { stdio: 'ignore' }).status === 0
if (remove) {
  console.log(exists ? 'Could not remove admin mode (the Windows prompt was declined?).' : 'Admin mode removed. Onyx starts normally from now on.')
} else if (exists) {
  console.log('Admin mode is on. Onyx runs with admin rights whenever you start it (it does not start by itself).')
  console.log('Run `npm start` now to restart Onyx with admin rights.')
} else {
  console.log(`Admin mode was not set up${r.status ? ` (exit ${r.status})` : ''}. Did you click "Yes" on the Windows prompt?`)
}
