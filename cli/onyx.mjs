#!/usr/bin/env node
/**
 * Onyx in the terminal.
 *
 *   onyx                      chat (starts the core if needed)
 *   onyx "rename my screenshots by date"   one request, then exit
 *   onyx stop                 stop whatever Onyx is doing
 *   onyx tasks                scheduled and triggered tasks
 *   onyx log [YYYY-MM-DD]     what Onyx did
 *   onyx pair                 link your phone (needs lan.enabled)
 *   onyx config               where the settings live
 */

import readline from 'node:readline'
import WebSocket from 'ws'
import { accessToken, dataPath, loadConfig } from '../core/config.mjs'
import { coreUrl, ensureCore, stopRequest } from '../core/launch.mjs'

const config = loadConfig()
const args = process.argv.slice(2)
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

async function api(path) {
  const res = await fetch(`${coreUrl(config)}${path}`, { headers: { authorization: `Bearer ${accessToken()}` } })
  return res.json()
}

async function main() {
  const cmd = args[0]
  if (cmd === 'config') {
    console.log(`Settings: ${dataPath('config.json')}\nMemory:   ${dataPath('memory.json')}\nTasks:    ${dataPath('tasks.json')}\nLogs:     ${dataPath('logs')}`)
    return
  }
  await ensureCore(config)
  if (cmd === 'stop') {
    console.log(await stopRequest(config))
    return
  }
  if (cmd === 'log') {
    for (const e of await api(`/log${args[1] ? `?date=${args[1]}` : ''}`)) {
      const what = e.kind === 'tool' ? `${e.tool} [${e.risk}] ${e.decision}` : e.kind
      console.log(`${c.dim(e.at.slice(11, 19))} ${what} ${c.dim(String(e.input ?? e.result ?? '').slice(0, 100))}`)
    }
    return
  }
  if (cmd === 'pair') {
    const p = await api('/pair')
    if (!p.lan) {
      console.log(`Phone access is off. Set "lan": {"enabled": true} in ${dataPath('config.json')} and restart Onyx.`)
    } else {
      console.log('Open one of these on your phone (same Wi-Fi). Keep it private, it contains your access key:')
      for (const u of p.urls) console.log('  ' + u)
    }
    return
  }
  await chat(cmd === 'tasks' ? null : args.join(' ').trim(), cmd === 'tasks')
}

function chat(oneShot, listTasks) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${coreUrl(config).replace('http', 'ws')}/ws`)
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    let myTurn = null
    let clientId = null
    let waiting = null // a pending approval or question we are prompting for
    let atLineStart = true

    const out = (s) => {
      process.stdout.write(s)
      atLineStart = s.endsWith('\n')
    }
    const line = (s) => out((atLineStart ? '' : '\n') + s + '\n')
    const send = (m) => ws.send(JSON.stringify(m))
    const prompt = () => {
      if (!oneShot && !waiting) rl.setPrompt(c.cyan('you › ')), rl.prompt()
    }

    ws.on('open', () => send({ type: 'hello', token: accessToken(), role: 'cli' }))
    ws.on('close', () => {
      rl.close()
      resolve()
    })
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      switch (m.type) {
        case 'welcome':
          clientId = m.clientId
          if (listTasks) return send({ type: 'tasks' })
          if (oneShot) send({ type: 'ask', text: oneShot })
          else {
            line(c.dim(`Onyx · ${config.brain} brain · approvals: ${config.approvals} · Ctrl+C to quit, "stop" to stop a task`))
            prompt()
          }
          break
        case 'tasks':
          if (!m.tasks.length) line('No tasks yet. Ask Onyx, e.g. "every Sunday at 8pm, summarise my week\'s spending".')
          for (const t of m.tasks) {
            line(`${t.enabled ? c.green('●') : c.dim('○')} ${c.bold(t.name)} ${c.dim(t.id)}  ${t.cron ?? t.at ?? `on ${t.trigger}${t.filter ? ` (${t.filter})` : ''}`}${t.next ? c.dim(`  next ${t.next}`) : ''}`)
            if (t.lastRun) line(c.dim(`    last ${t.lastRun}: ${String(t.lastResult ?? '').slice(0, 100)}`))
          }
          if (listTasks) ws.close()
          break
        case 'turn_start':
          if (m.clientId === clientId) myTurn = m.turn
          else line(c.dim(`[${m.source}] ${m.text}`))
          if (m.clientId === clientId) out(c.bold('onyx › '))
          break
        case 'text':
          if (m.turn === myTurn) out(m.delta)
          break
        case 'tool':
          if (m.turn === myTurn) line(c.dim(`  ↳ ${m.label}`))
          break
        case 'tool_done':
          if (m.turn === myTurn && !m.ok) line(c.dim(c.red(`    ✗ ${m.summary.slice(0, 160)}`)))
          break
        case 'approval': {
          if (waiting) break
          waiting = m.id
          const risk = m.risk === 'danger' ? c.red('⚠ ') : ''
          line(c.yellow(`${risk}Onyx wants to: ${m.label}`))
          const opts = m.canAlways ? '[y]es · [t]his task · [a]lways · [n]o' : '[y]es · [n]o'
          rl.question(c.yellow(`  ${opts} › `), (ans) => {
            const a = ans.trim().toLowerCase()
            const answer = a === 'y' || a === 'yes' ? 'allow' : a === 't' ? 'allow_turn' : a === 'a' && m.canAlways ? 'always' : 'deny'
            send({ type: 'approve', id: m.id, answer })
            waiting = null
          })
          break
        }
        case 'question':
          if (waiting) break
          waiting = m.id
          line(c.yellow(`Onyx asks: ${m.question}`))
          if (m.choices?.length) line(c.dim(m.choices.map((ch, i) => `  ${i + 1}. ${ch}`).join('\n')))
          rl.question(c.yellow('  › '), (ans) => {
            const n = Number(ans)
            send({ type: 'answer', id: m.id, text: m.choices?.[n - 1] ?? ans })
            waiting = null
          })
          break
        case 'approval_closed':
        case 'question_closed':
          if (waiting === m.id) {
            waiting = null
            line(c.dim('  (answered elsewhere)'))
          }
          break
        case 'notify':
          line(c.green(`🔔 ${m.title}: ${m.body}`))
          break
        case 'error':
          if (!m.turn || m.turn === myTurn) line(c.red(m.message))
          if (m.turn === myTurn) {
            myTurn = null
            if (oneShot) ws.close()
            else prompt()
          }
          break
        case 'done':
          if (m.turn === myTurn) {
            line('')
            myTurn = null
            if (oneShot) ws.close()
            else prompt()
          }
          break
        case 'stopped':
          line(c.red('■ stopped'))
          break
      }
    })

    rl.on('line', (text) => {
      if (oneShot || waiting) return
      const t = text.trim()
      if (!t) return prompt()
      if (t === 'stop') return send({ type: 'stop' })
      if (t === 'new' || t === 'reset') {
        send({ type: 'reset' })
        line(c.dim('New conversation.'))
        return prompt()
      }
      if (t === 'exit' || t === 'quit') return ws.close()
      send({ type: 'ask', text: t })
    })
    rl.on('SIGINT', () => ws.close())
  })
}

main().catch((err) => {
  console.error(c.red(err.message))
  process.exit(1)
})
