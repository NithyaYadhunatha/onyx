/**
 * Find the running core, or start it in the background.
 */

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { join } from 'node:path'
import { LOG_DIR, ROOT, accessToken, loadConfig } from './config.mjs'

export const coreUrl = (config = loadConfig()) => `http://127.0.0.1:${config.port}`

export async function coreAlive(config = loadConfig()) {
  try {
    const res = await fetch(`${coreUrl(config)}/health`, { signal: AbortSignal.timeout(1500) })
    const body = await res.json()
    return body?.name === 'onyx'
  } catch {
    return false
  }
}

/** Start the core detached (it outlives this process), logging to ~/.onyx/logs/core.log. */
export async function ensureCore(config = loadConfig(), { quiet = false } = {}) {
  if (await coreAlive(config)) return true
  if (!quiet) console.log('Starting the Onyx core…')
  const log = openSync(join(LOG_DIR, 'core.log'), 'a')
  const child = spawn(process.execPath, [join(ROOT, 'core', 'server.mjs')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    // Inside the Onyx window, process.execPath is Electron itself; this flag
    // makes it behave as plain Node so the core runs as a normal process.
    env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
  })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await coreAlive(config)) return true
  }
  throw new Error(`The core did not start. See ${join(LOG_DIR, 'core.log')}`)
}

export async function stopRequest(config = loadConfig()) {
  const res = await fetch(`${coreUrl(config)}/stop`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken()}` },
  })
  return res.json()
}
