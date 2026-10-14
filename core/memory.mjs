/**
 * Long-term memory: small facts about you that Onyx should not have to ask
 * twice. "My salary lands on the 1st", "work files are in D:\Work".
 *
 * Pinned memories go into every conversation's system prompt. The rest are
 * found with `recall` when they look relevant. Plain JSON on disk, so you can
 * read and edit ~/.onyx/memory.json yourself.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dataPath } from './config.mjs'

const FILE = dataPath('memory.json')

function load() {
  if (!existsSync(FILE)) return []
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'))
  } catch {
    return []
  }
}

const save = (items) => writeFileSync(FILE, JSON.stringify(items, null, 2))

export function remember(text, { pinned = false, tags = [] } = {}) {
  const items = load()
  const clean = String(text).trim()
  const existing = items.find((m) => m.text.toLowerCase() === clean.toLowerCase())
  if (existing) {
    existing.pinned = existing.pinned || pinned
    save(items)
    return existing
  }
  const item = { id: randomUUID().slice(0, 8), text: clean, pinned, tags, created: new Date().toISOString() }
  items.push(item)
  save(items)
  return item
}

const words = (s) =>
  String(s)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2)

/** Keyword overlap, good enough for a few hundred personal facts. */
export function recall(query, limit = 8) {
  const q = new Set(words(query))
  const items = load()
  if (!q.size) return items.slice(-limit)
  return items
    .map((m) => {
      const w = words(`${m.text} ${m.tags.join(' ')}`)
      const hits = w.filter((x) => q.has(x) || [...q].some((y) => x.startsWith(y) || y.startsWith(x)))
      return { m, score: hits.length / Math.sqrt(w.length + 1) }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.m)
}

export function forget(id) {
  const items = load()
  const next = items.filter((m) => m.id !== id)
  save(next)
  return items.length !== next.length
}

export const pinnedMemories = () => load().filter((m) => m.pinned)
export const allMemories = load
