/**
 * End-to-end check against the real brain, with a throwaway data folder.
 *
 *   node tests/e2e.mjs            (uses your configured brain, port 8799)
 *
 * Asks one read-only question (window list) and one file write that needs
 * approval (auto-approved here), then checks the file and the action log.
 * It never clicks or types in your apps.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const home = mkdtempSync(join(tmpdir(), 'onyx-e2e-'))
const work = mkdtempSync(join(tmpdir(), 'onyx-work-'))
const target = join(work, 'hello.txt').split('\\').join('/')
const env = { ...process.env, ONYX_HOME: home, ONYX_PORT: '8799' }
const core = spawn(process.execPath, ['core/server.mjs'], { env, cwd: join(import.meta.dirname, '..') })
core.stdout.on('data', (d) => process.stdout.write('[core] ' + d))
core.stderr.on('data', (d) => process.stdout.write('[core!] ' + d))
// Wait until the core answers (a cold start can take several seconds).
for (let i = 0; i < 120; i++) {
  const up = await fetch('http://127.0.0.1:8799/health').then((r) => r.ok, () => false)
  if (up && existsSync(join(home, 'token'))) break
  await new Promise((r) => setTimeout(r, 250))
}

const token = readFileSync(join(home, 'token'), 'utf8').trim()
const ws = new WebSocket('ws://127.0.0.1:8799/ws')
const asks = [
  'Using your desktop tools, list the titles of the windows open on my PC right now. Reply in one line.',
  `Create a text file at ${target} containing exactly: Onyx works. Then reply "done".`,
]
let i = 0
let failures = 0
const t0 = Date.now()
const finish = (code) => {
  ws.close()
  core.kill()
  process.exit(code)
}

ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, role: 'test' })))
ws.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.type === 'welcome') ws.send(JSON.stringify({ type: 'ask', text: asks[i] }))
  if (m.type === 'tool') console.log('TOOL', m.name, '|', m.label.slice(0, 120))
  if (m.type === 'tool_done') console.log('  ->', m.ok ? 'ok' : 'FAIL', m.summary.slice(0, 120).replace(/\n/g, ' '))
  if (m.type === 'approval') {
    console.log('APPROVAL', m.risk, m.label)
    ws.send(JSON.stringify({ type: 'approve', id: m.id, answer: 'allow' }))
  }
  if (m.type === 'error') {
    console.log('ERROR', m.message)
    failures++
  }
  if (m.type === 'done' || (m.type === 'error' && m.turn)) {
    console.log(`DONE[${i}] (${((Date.now() - t0) / 1000).toFixed(1)}s):`, (m.text ?? '').slice(0, 300))
    i++
    if (i < asks.length) return ws.send(JSON.stringify({ type: 'ask', text: asks[i] }))
    const ok = existsSync(target) && readFileSync(target, 'utf8').includes('Onyx works')
    console.log('FILE WRITTEN:', ok)
    const log = readFileSync(join(home, 'logs', `actions-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8')
    console.log('LOG ENTRIES:', log.split('\n').filter(Boolean).length)
    finish(ok && !failures ? 0 : 1)
  }
})
setTimeout(() => {
  console.log('TIMEOUT')
  finish(1)
}, 240_000)
