/**
 * The proactive part of Onyx: work that starts without you asking.
 *
 * A task is a prompt plus a reason to run it:
 *   cron    - a schedule, e.g. "0 9 1 * *" (9am on the 1st of every month)
 *   at      - once, at an ISO date and time
 *   trigger - an event: "sms" (a new SMS reached Onyx), "file" (a new file
 *             appeared in a folder), "startup" (Onyx started), "phone"
 *             (your phone connected)
 *
 * When a task fires, Onyx runs its prompt as a background turn and sends you
 * the result as a notification.
 */

import { existsSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import { dataPath } from './config.mjs'

const FILE = dataPath('tasks.json')

export class Scheduler {
  /** @param run (task, event) => Promise<string> runs the task's prompt */
  constructor(run) {
    this.run = run
    this.tasks = existsSync(FILE) ? safeParse(readFileSync(FILE, 'utf8')) : []
    this.timers = new Map()
  }

  start() {
    for (const t of this.tasks) this.#arm(t)
    for (const t of this.tasks.filter((t) => t.enabled && t.trigger === 'startup')) {
      this.#fire(t, { type: 'startup' })
    }
  }

  stop() {
    for (const id of [...this.timers.keys()]) this.#disarm(id)
  }

  list() {
    return this.tasks.map((t) => ({ ...t, next: this.#next(t) }))
  }

  add({ name, prompt, cron, at, trigger, filter, folder }) {
    if (!name || !prompt) throw new Error('a task needs a name and a prompt')
    const kinds = [cron, at, trigger].filter(Boolean)
    if (kinds.length !== 1) throw new Error('give exactly one of cron, at or trigger')
    if (cron) new Cron(cron, { paused: true }).stop() // throws on a bad pattern
    if (at && Number.isNaN(Date.parse(at))) throw new Error(`"${at}" is not a date and time`)
    if (at && Date.parse(at) < Date.now()) throw new Error(`"${at}" is in the past`)
    if (trigger && !['sms', 'file', 'startup', 'phone'].includes(trigger)) {
      throw new Error('trigger must be one of sms, file, startup, phone')
    }
    if (trigger === 'file' && !(folder && existsSync(folder))) {
      throw new Error('a file trigger needs an existing folder to watch')
    }
    const task = {
      id: randomUUID().slice(0, 8),
      name,
      prompt,
      ...(cron && { cron }),
      ...(at && { at }),
      ...(trigger && { trigger }),
      ...(filter && { filter }),
      ...(folder && { folder }),
      enabled: true,
      created: new Date().toISOString(),
      lastRun: null,
      lastResult: null,
    }
    this.tasks.push(task)
    this.#save()
    this.#arm(task)
    return { ...task, next: this.#next(task) }
  }

  remove(id) {
    const before = this.tasks.length
    this.#disarm(id)
    this.tasks = this.tasks.filter((t) => t.id !== id)
    this.#save()
    return this.tasks.length !== before
  }

  setEnabled(id, enabled) {
    const t = this.tasks.find((t) => t.id === id)
    if (!t) return false
    t.enabled = enabled
    this.#disarm(id)
    if (enabled) this.#arm(t)
    this.#save()
    return true
  }

  /** Something happened (an SMS arrived, the phone connected): run matching tasks. */
  emit(type, payload = {}) {
    for (const t of this.tasks) {
      if (!t.enabled || t.trigger !== type) continue
      if (t.filter) {
        const text = JSON.stringify(payload).toLowerCase()
        if (!t.filter.toLowerCase().split('|').some((f) => text.includes(f.trim()))) continue
      }
      this.#fire(t, { type, ...payload })
    }
  }

  async runNow(id) {
    const t = this.tasks.find((t) => t.id === id)
    if (!t) throw new Error(`no task ${id}`)
    return this.#fire(t, { type: 'manual' })
  }

  #next(t) {
    if (t.cron && t.enabled) return new Cron(t.cron, { paused: true }).nextRun()?.toISOString() ?? null
    if (t.at && t.enabled && !t.lastRun) return t.at
    return null
  }

  #arm(t) {
    if (!t.enabled) return
    if (t.cron) {
      this.timers.set(t.id, new Cron(t.cron, { protect: true }, () => this.#fire(t, { type: 'schedule' })))
    } else if (t.at && !t.lastRun) {
      // croner accepts a Date for one-off jobs and handles long delays,
      // which a plain setTimeout cannot (it overflows past ~24 days).
      const when = new Date(t.at)
      if (when > new Date()) {
        this.timers.set(t.id, new Cron(when, () => this.#fire(t, { type: 'schedule' })))
      }
    } else if (t.trigger === 'file' && t.folder) {
      try {
        const seen = new Map()
        const watcher = watch(t.folder, (kind, filename) => {
          if (!filename || kind !== 'rename') return
          const full = join(t.folder, filename)
          // A download writes in several steps: wait for it to settle.
          clearTimeout(seen.get(full))
          seen.set(
            full,
            setTimeout(() => {
              seen.delete(full)
              try {
                if (!statSync(full).isFile()) return
              } catch {
                return // it was deleted, not added
              }
              if (/\.(crdownload|part|tmp|download)$/i.test(filename)) return
              this.#fire(t, { type: 'file', path: full })
            }, 2500),
          )
        })
        this.timers.set(t.id, { stop: () => watcher.close() })
      } catch (err) {
        console.error(`[onyx] cannot watch ${t.folder}:`, err.message)
      }
    }
  }

  #disarm(id) {
    this.timers.get(id)?.stop()
    this.timers.delete(id)
  }

  async #fire(t, event) {
    console.log(`[onyx] task "${t.name}" fired (${event.type})`)
    t.lastRun = new Date().toISOString()
    let result
    try {
      result = await this.run(t, event)
      t.lastResult = String(result ?? '').slice(0, 500)
    } catch (err) {
      t.lastResult = `failed: ${err.message}`
      result = t.lastResult
    }
    if (t.at) {
      t.enabled = false
      this.#disarm(t.id)
    }
    this.#save()
    return result
  }

  #save() {
    writeFileSync(FILE, JSON.stringify(this.tasks, null, 2))
  }
}

function safeParse(s) {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
