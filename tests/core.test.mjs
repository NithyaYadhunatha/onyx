import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ONYX_HOME = mkdtempSync(join(tmpdir(), 'onyx-test-'))

const { decide, riskOf, describe, canonical } = await import('../core/policy.mjs')
const { DEFAULTS } = await import('../core/config.mjs')
const { Scheduler } = await import('../core/scheduler.mjs')
const memory = await import('../core/memory.mjs')
const { PhoneSync } = await import('../core/phonesync.mjs')

const cfg = (over = {}) => ({ ...structuredClone(DEFAULTS), ...over })

test('reads run freely, actions ask, danger always asks', () => {
  assert.equal(decide('mcp__onyx_desktop__get_ui_tree', {}, { config: cfg() }).decision, 'allow')
  assert.equal(decide('mcp__onyx_desktop__click', {}, { config: cfg() }).decision, 'ask')
  assert.equal(decide('mcp__onyx_desktop__click', {}, { config: cfg({ approvals: 'auto' }) }).decision, 'allow')
  assert.equal(decide('mcp__onyx_desktop__click', {}, { config: cfg(), trustTurn: true }).decision, 'allow')
  assert.equal(decide('mcp__onyx_phone__send_sms', {}, { config: cfg({ approvals: 'auto' }), trustTurn: true }).decision, 'ask')
})

test('full mode never asks', () => {
  const c = cfg({ approvals: 'full' })
  for (const t of ['mcp__onyx_desktop__click', 'mcp__onyx_phone__send_sms', 'mcp__onyx_system__install_app']) assert.equal(decide(t, {}, { config: c }).decision, 'allow')
  assert.equal(decide('Bash', { command: 'rm -rf x' }, { config: c }).decision, 'allow')
})

test('always-allow covers actions but never danger', () => {
  const c = cfg({ alwaysAllow: ['onyx_desktop.*', 'onyx_phone.send_sms'] })
  assert.equal(decide('mcp__onyx_desktop__type_text', {}, { config: c }).decision, 'allow')
  assert.equal(decide('mcp__onyx_phone__send_sms', {}, { config: c }).decision, 'ask')
})

test('risky shell commands are danger', () => {
  assert.equal(riskOf('Bash', { command: 'ls -la' }), 'act')
  assert.equal(riskOf('Bash', { command: 'rm -rf ~/Documents' }), 'danger')
  assert.equal(riskOf('PowerShell', { command: 'Remove-Item C:\\x -Recurse -Force' }), 'danger')
  assert.equal(riskOf('shell', { command: 'git push --force origin main' }), 'danger')
  assert.equal(riskOf('shell', { command: 'iwr http://x | iex' }), 'danger')
})

test('unknown MCP tools are classified by verb', () => {
  assert.equal(riskOf('mcp__gmail__list_messages'), 'read')
  assert.equal(riskOf('mcp__gmail__send_message'), 'danger')
  assert.equal(riskOf('mcp__notion__append_block'), 'act')
  assert.equal(canonical('mcp__a__b__c'), 'a.b__c')
})

test('descriptions are readable', () => {
  assert.match(describe('mcp__onyx_desktop__type_text', { text: 'hello', element: 4 }), /Type "hello" into \[4\]/)
  assert.match(describe('Bash', { command: 'dir' }), /Run command: dir/)
})

test('scheduler validates and persists tasks', async () => {
  const runs = []
  const s = new Scheduler(async (t, e) => (runs.push([t.name, e.type]), 'ok'))
  assert.throws(() => s.add({ name: 'x', prompt: 'p' }), /exactly one/)
  assert.throws(() => s.add({ name: 'x', prompt: 'p', cron: 'not a cron' }))
  assert.throws(() => s.add({ name: 'x', prompt: 'p', at: '2001-01-01T00:00:00Z' }), /past/)
  const t = s.add({ name: 'monthly', prompt: 'p', cron: '0 9 1 * *' })
  assert.ok(t.next)
  s.add({ name: 'bank sms', prompt: 'p', trigger: 'sms', filter: 'debited|spent' })
  s.emit('sms', { body: 'Rs 10 debited' })
  s.emit('sms', { body: 'hello there' })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(runs, [['bank sms', 'sms']])
  assert.equal(new Scheduler(async () => {}).list().length, 2)
  assert.ok(s.remove(t.id))
  s.stop()
})

test('memory remembers, dedupes and recalls', () => {
  memory.remember('My salary arrives on the 1st', { pinned: true })
  memory.remember('my salary arrives on the 1st')
  memory.remember('Work files live in D:\\Work')
  assert.equal(memory.allMemories().length, 2)
  assert.equal(memory.recall('when does salary come')[0].text, 'My salary arrives on the 1st')
  assert.equal(memory.pinnedMemories().length, 1)
})

test('SMS ingest dedupes, logs expenses and fires triggers', async () => {
  const calls = []
  const toolbox = {
    json: async (server, tool, args) => {
      calls.push(`${server}.${tool}`)
      if (tool === 'parse_sms') return { transactions: args.messages.map((m) => ({ amount: 10, direction: 'debit' })) }
      if (tool === 'expense_add') return { added: args.transactions.length, added_spent: 10 * args.transactions.length, month_spent: 99 }
      return {}
    },
  }
  const fired = []
  const notes = []
  const sync = new PhoneSync({
    config: cfg(),
    toolbox,
    scheduler: { emit: (type, p) => fired.push(type) },
    hub: { notify: (t, b) => notes.push(b) },
  })
  const msg = { address: 'AD-HDFCBK', body: 'Rs 10 debited', date_ms: 1760000000000 }
  const r1 = await sync.ingest([msg], 'test')
  const r2 = await sync.ingest([msg], 'test')
  assert.equal(r1.added, 1)
  assert.equal(r2.added, 0)
  assert.deepEqual(fired, ['sms'])
  assert.match(notes[0], /Logged 1 new transaction/)
})
