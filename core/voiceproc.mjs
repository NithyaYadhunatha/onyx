/**
 * Keeps the voice loop running while voice is on.
 *
 * The core owns it so voice cannot quietly disappear: if the Python process
 * exits for any reason it is restarted (with a growing pause, so a broken
 * microphone does not spin), and turning voice off in settings stops it.
 * What it hears and any errors go to ~/.onyx/logs/voice.log.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, PYTHON, ROOT } from './config.mjs'

export class VoiceProcess {
  constructor(config) {
    this.config = config
    this.child = null
    this.wanted = false
    this.backoff = 2000
    this.timer = null
    this.startedAt = 0
  }

  get running() {
    return Boolean(this.child)
  }

  start() {
    this.wanted = true
    if (this.child || this.timer) return
    if (!existsSync(PYTHON)) return console.error('[onyx] voice: Python environment missing, run npm run setup')
    this.startedAt = Date.now()
    this.child = spawn(PYTHON, ['-X', 'utf8', join(ROOT, 'voice', 'voice.py')], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, ONYX_HOME: DATA_DIR, ONYX_PORT: String(this.config.port) },
    })
    this.child.on('exit', (code) => {
      this.child = null
      if (!this.wanted) return
      // A run that lasted a while was healthy: restart quickly.
      if (Date.now() - this.startedAt > 60_000) this.backoff = 2000
      console.error(`[onyx] voice exited (${code}); restarting in ${this.backoff / 1000}s. See logs/voice.log`)
      this.timer = setTimeout(() => {
        this.timer = null
        this.start()
      }, this.backoff)
      this.backoff = Math.min(this.backoff * 2, 60_000)
    })
    console.log('[onyx] voice started')
  }

  stop() {
    this.wanted = false
    clearTimeout(this.timer)
    this.timer = null
    this.child?.kill()
    this.child = null
  }
}
