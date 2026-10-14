/**
 * Phone to expense sheet, with no model in the loop.
 *
 * Every UPI or card payment sends a bank SMS. Onyx collects those in two ways:
 *   - over adb, from a phone connected by USB or wireless debugging, every
 *     few minutes
 *   - pushed by the phone itself to POST /ingest/sms (a Termux script or an
 *     SMS-forwarder app; see phone/README.md), which works without adb
 *
 * Each new SMS is parsed by onyx_office.parse_sms, added (deduplicated) to the
 * expense workbook by onyx_office.expense_add, and fires any "sms" tasks.
 * Parsing is plain rules, so this costs nothing and runs offline.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dataPath } from './config.mjs'
import { logAction } from './log.mjs'

const STATE = dataPath('phone-sync.json')
const BACKFILL_DAYS = 30

export class PhoneSync {
  constructor({ config, toolbox, scheduler, hub }) {
    Object.assign(this, { config, toolbox, scheduler, hub })
    this.state = existsSync(STATE) ? safe(readFileSync(STATE, 'utf8')) : {}
    this.state.seen ??= []
    this.connected = false
    this.timer = null
    this.busy = false
  }

  start() {
    const minutes = Math.max(1, Number(this.config.phone.smsSyncMinutes) || 15)
    // The first check waits a little, so startup is not slowed by adb.
    setTimeout(() => this.tick(), 20_000)
    this.timer = setInterval(() => this.tick(), minutes * 60_000)
  }

  stop() {
    clearInterval(this.timer)
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      const devices = await this.toolbox.json('onyx_phone', 'devices').catch(() => ({ devices: [] }))
      const ready = (devices.devices ?? []).filter((d) => d.state === 'device')
      const now = ready.length > 0
      if (now && !this.connected) this.scheduler.emit('phone', { serial: ready[0].serial })
      this.connected = now
      if (!now || !this.config.phone.smsSync) return

      const since = this.state.lastSmsMs ?? Date.now() - BACKFILL_DAYS * 86_400_000
      const res = await this.toolbox.json('onyx_phone', 'read_sms', { since_ms: since, limit: 500 })
      if (res.error) {
        console.error('[onyx] phone SMS read failed:', res.error)
        return
      }
      await this.ingest(res.messages ?? [], 'adb')
    } catch (err) {
      console.error('[onyx] phone sync:', err.message)
    } finally {
      this.busy = false
    }
  }

  /**
   * @param messages [{ id?, address|from, body, date_ms? }]
   * @returns {{ received, transactions, added }}
   */
  async ingest(messages, via) {
    const seen = new Set(this.state.seen)
    const fresh = []
    for (const m of messages) {
      const body = String(m.body ?? m.text ?? '').trim()
      if (!body) continue
      const date = Number(m.date_ms ?? m.date ?? Date.now())
      const key = `${m.address ?? m.from ?? ''}|${date}|${body.slice(0, 60)}`
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push({ address: m.address ?? m.from ?? '', body, date_ms: date })
      if (date > (this.state.lastSmsMs ?? 0)) this.state.lastSmsMs = date
    }
    // Remember only the recent past; dedupe in the workbook catches the rest.
    this.state.seen = [...seen].slice(-3000)
    this.#save()
    if (!fresh.length) return { received: messages.length, transactions: 0, added: 0 }

    for (const m of fresh) this.scheduler.emit('sms', { from: m.address, body: m.body })

    let added = 0
    let transactions = []
    if (this.config.phone.smsSync) {
      const parsed = await this.toolbox.json('onyx_office', 'parse_sms', { messages: fresh })
      transactions = parsed.transactions ?? []
      if (transactions.length) {
        const res = await this.toolbox.json('onyx_office', 'expense_add', {
          transactions,
          workbook: this.config.expenses.workbook,
        })
        added = res.added ?? 0
        logAction({ kind: 'sms-sync', via, result: res })
        if (added) {
          const spent = Number(res.added_spent ?? 0)
          this.hub.notify(
            'Expenses updated',
            `Logged ${added} new transaction${added > 1 ? 's' : ''}${spent ? ` (₹${spent.toLocaleString('en-IN')} spent)` : ''}. This month: ₹${Number(res.month_spent ?? 0).toLocaleString('en-IN')}.`,
          )
        }
      }
    }
    return { received: messages.length, transactions: transactions.length, added }
  }

  #save() {
    writeFileSync(STATE, JSON.stringify(this.state))
  }
}

function safe(s) {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
