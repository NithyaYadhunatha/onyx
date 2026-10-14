/**
 * The action log: one JSON line per tool call, per day.
 *
 * An agent that can click anything on your PC has to be auditable. Every call,
 * the decision made about it and how it ended goes here, so "what did Onyx do
 * at 3am?" always has an answer: `onyx log` or ~/.onyx/logs/.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOG_DIR } from './config.mjs'

const day = (d = new Date()) => d.toISOString().slice(0, 10)
const fileFor = (d) => join(LOG_DIR, `actions-${d}.jsonl`)

const clip = (value, max = 600) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  if (s === undefined) return undefined
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function logAction(entry) {
  const line = { at: new Date().toISOString(), ...entry }
  if ('input' in line) line.input = clip(line.input)
  if ('result' in line) line.result = clip(line.result)
  try {
    appendFileSync(fileFor(day()), JSON.stringify(line) + '\n')
  } catch (err) {
    console.error('[onyx] could not write the action log:', err.message)
  }
}

export function readLog(date = day(), limit = 200) {
  const file = fileFor(date)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}
