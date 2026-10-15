/**
 * How well does the configured brain do real Onyx tasks?
 *
 *   node tests/agent-eval.mjs
 *
 * Runs a handful of tasks against a throwaway data folder, approves
 * everything automatically, and checks the outcome, not the wording.
 * Nothing here clicks or types in your apps.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const home = mkdtempSync(join(tmpdir(), 'onyx-eval-'))
const work = mkdtempSync(join(tmpdir(), 'onyx-eval-work-'))
const fwd = (p) => p.split('\\').join('/')

writeFileSync(
  join(work, 'hdfc.csv'),
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n' +
    '01/10/26,UPI-SWIGGY-swiggy@icici-628512345678,0000628512345678,01/10/26,350.00,,10650.00\n' +
    '02/10/26,NEFT CR-ACME TECH SALARY,N123456,02/10/26,,45000.00,55650.00\n' +
    '03/10/26,POS 416021XXXXXX1234 DMART AVENUE,0000,03/10/26,"1,240.75",,54409.25\n',
)
const box = join(work, 'box')
mkdirSync(box)
for (const n of ['a.txt', 'b.pdf', 'c.jpg']) writeFileSync(join(box, n), 'x')

const TASKS = [
  {
    name: 'expense statement',
    ask: `Add the bank statement ${fwd(join(work, 'hdfc.csv'))} to my expense sheet, then tell me how much I spent in October 2026.`,
    check: (r) => existsSync(join(home, 'Expenses.xlsx')) && /1[,]?590(\.75)?/.test(r.text),
  },
  {
    name: 'count files',
    ask: `How many files are in the folder ${fwd(box)}? Answer with the number.`,
    check: (r) => /\b3\b|three/i.test(r.text),
  },
  {
    name: 'memory',
    ask: 'Remember that my bank is HDFC.',
    check: () => existsSync(join(home, 'memory.json')) && /hdfc/i.test(readFileSync(join(home, 'memory.json'), 'utf8')),
  },
  {
    name: 'weekly reminder',
    ask: 'Every Monday at 9am, remind me to check my budget.',
    check: () => {
      try {
        const t = JSON.parse(readFileSync(join(home, 'tasks.json'), 'utf8'))
        return t.some((x) => /^0 9 \* \* (1|MON)$/i.test(String(x.cron ?? '').trim()))
      } catch {
        return false
      }
    },
  },
  {
    name: 'web lookup',
    ask: 'Search the web: what is the capital of Australia? One word answer.',
    check: (r) => /canberra/i.test(r.text) && r.tools.some((t) => /web_search|web_fetch|WebSearch|WebFetch/.test(t)),
  },
]

const env = { ...process.env, ONYX_HOME: home, ONYX_PORT: '8798' }
const core = spawn(process.execPath, ['core/server.mjs'], { env, cwd: join(import.meta.dirname, '..') })
core.stderr.on('data', (d) => process.env.ONYX_DEBUG && process.stdout.write(d))
await new Promise((r) => setTimeout(r, 2500))

const ws = new WebSocket('ws://127.0.0.1:8798/ws')
const token = readFileSync(join(home, 'token'), 'utf8').trim()
let i = 0
let current = null
const results = []
const t0 = Date.now()

function next() {
  if (i >= TASKS.length) return finish()
  const task = TASKS[i]
  current = { task, tools: [], text: '', started: Date.now() }
  ws.send(JSON.stringify({ type: 'ask', text: task.ask }))
}

function finish() {
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  ws.close()
  core.kill()
  process.exit(passed === results.length ? 0 : 1)
}

ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, role: 'eval' })))
ws.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.type === 'welcome') next()
  if (m.type === 'approval') ws.send(JSON.stringify({ type: 'approve', id: m.id, answer: 'allow' }))
  if (m.type === 'question') ws.send(JSON.stringify({ type: 'answer', id: m.id, text: 'Use your best judgement.' }))
  if (m.type === 'tool' && current) current.tools.push(m.name)
  if ((m.type === 'done' || (m.type === 'error' && m.turn)) && current) {
    current.text = m.text ?? m.message ?? ''
    const ok = Boolean(current.task.check(current))
    const secs = ((Date.now() - current.started) / 1000).toFixed(1)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${current.task.name} (${secs}s, ${current.tools.length} tools: ${current.tools.join(', ')})`)
    if (!ok) console.log(`      answer: ${current.text.slice(0, 240).replace(/\n/g, ' ')}`)
    results.push({ name: current.task.name, ok })
    i++
    next()
  }
})
setTimeout(() => {
  console.log('TIMEOUT')
  finish()
}, 900_000)
