/**
 * The hub: one Onyx, many faces.
 *
 * The hotkey window, the voice loop, the terminal and the phone web app are
 * all clients of this. They share one conversation, see the same stream of
 * events, and any of them can answer an approval or a question.
 *
 * Turns run one at a time, including background tasks. Two agents fighting
 * over one mouse is worse than a short wait.
 */

import { randomUUID } from 'node:crypto'
import { saveConfig } from './config.mjs'
import { logAction } from './log.mjs'
import { canonical, decide, describe } from './policy.mjs'
import { systemPrompt } from './prompt.mjs'
import { onyxTools, sdkServer } from './tools.mjs'
import { ClaudeBrain } from './brain/claude.mjs'
import { LocalBrain } from './brain/local.mjs'

export class Hub {
  constructor({ config, servers, toolbox, scheduler }) {
    this.config = config
    this.servers = servers
    this.toolbox = toolbox
    this.scheduler = scheduler
    this.clients = new Set()
    this.queue = []
    this.running = null
    this.pendingApprovals = new Map()
    this.pendingQuestions = new Map()
    this.tools = onyxTools({
      scheduler,
      hub: { ask: (q, c) => this.ask(q, c), notify: (t, b) => this.notify(t, b) },
    })
    this.brain = null
  }

  // ---- clients -----------------------------------------------------------

  addClient(client) {
    this.clients.add(client)
    client.send({
      type: 'ready',
      brain: this.config.brain,
      model: this.config.brain === 'local' ? this.config.local.model : this.config.claude.model,
      approvals: this.config.approvals,
      busy: Boolean(this.running),
    })
    // Anything still waiting on an answer is shown to the newcomer too.
    for (const a of this.pendingApprovals.values()) client.send(a.event)
    for (const q of this.pendingQuestions.values()) client.send(q.event)
  }

  removeClient(client) {
    this.clients.delete(client)
  }

  broadcast(event) {
    for (const c of this.clients) c.send(event)
  }

  notify(title, body) {
    console.log(`[onyx] notify: ${title}: ${body}`)
    this.broadcast({ type: 'notify', title, body })
  }

  // ---- brains ------------------------------------------------------------

  #makeBrain({ background = false, voice = false } = {}) {
    const prompt = systemPrompt(this.config, { background, voice })
    if (this.config.brain === 'local') {
      return new LocalBrain({ config: this.config, toolbox: this.toolbox, onyxTools: this.tools, systemPrompt: prompt })
    }
    return new ClaudeBrain({
      config: this.config,
      servers: this.servers,
      onyxServer: sdkServer(this.tools),
      systemPrompt: prompt,
    })
  }

  reset() {
    this.brain?.close()
    this.brain = null
    this.broadcast({ type: 'reset' })
  }

  // ---- turns -------------------------------------------------------------

  /**
   * Queue a request. Resolves with the final text once it has run.
   * @param source  'app' | 'voice' | 'cli' | 'mobile' | 'task'
   */
  submit(text, { source = 'app', clientId = null, background = false, voice = false, label } = {}) {
    return new Promise((resolve) => {
      const turn = { id: randomUUID().slice(0, 8), text, source, clientId, background, voice, label, resolve, trust: false }
      this.queue.push(turn)
      this.broadcast({ type: 'state', busy: Boolean(this.running), queued: this.queue.length })
      this.#pump()
    })
  }

  async #pump() {
    if (this.running || !this.queue.length) return
    const turn = this.queue.shift()
    this.running = turn
    let final = ''
    try {
      final = await this.#run(turn)
    } catch (err) {
      final = `Error: ${err.message}`
      this.broadcast({ type: 'error', turn: turn.id, message: final })
    } finally {
      this.running = null
      turn.resolve(final)
      this.broadcast({ type: 'state', busy: false, queued: this.queue.length })
      this.#pump()
    }
  }

  async #run(turn) {
    const brain = turn.background ? this.#makeBrain({ background: true }) : (this.brain ??= this.#makeBrain())
    turn.brain = brain
    this.broadcast({
      type: 'turn_start',
      turn: turn.id,
      text: turn.label ?? turn.text,
      source: turn.source,
      clientId: turn.clientId,
      background: turn.background,
    })
    logAction({ kind: 'turn', turn: turn.id, source: turn.source, input: turn.text })

    // A spoken request gets a spoken-style answer without a separate session.
    const text = turn.voice ? `${turn.text}\n\n(Spoken request: answer in one to three short spoken sentences.)` : turn.text
    const ctx = { gate: (name, input, id) => this.#gate(turn, name, input, id) }
    let final = ''
    let errored = false
    try {
      for await (const ev of brain.send(text, ctx)) {
        if (ev.type === 'text') this.broadcast({ type: 'text', turn: turn.id, delta: ev.delta })
        else if (ev.type === 'tool') {
          this.broadcast({ type: 'tool', turn: turn.id, id: ev.id, name: canonical(ev.name), label: describe(ev.name, ev.input) })
        } else if (ev.type === 'tool_done') {
          this.broadcast({ type: 'tool_done', turn: turn.id, id: ev.id, ok: ev.ok, summary: ev.summary })
          logAction({ kind: 'result', turn: turn.id, id: ev.id, ok: ev.ok, result: ev.summary })
        } else if (ev.type === 'done') {
          final = ev.text
        } else if (ev.type === 'error') {
          errored = true
          final = ev.message
          this.broadcast({ type: 'error', turn: turn.id, message: ev.message })
        }
      }
    } finally {
      if (turn.background) brain.close()
      // Drop anything this turn left unanswered.
      for (const [id, a] of this.pendingApprovals) if (a.turn === turn.id) this.#closeApproval(id, 'deny')
      for (const [id, q] of this.pendingQuestions) if (q.turn === turn.id) this.#closeQuestion(id, '(no answer)')
    }
    if (!errored) this.broadcast({ type: 'done', turn: turn.id, text: final })
    logAction({ kind: 'turn_end', turn: turn.id, ok: !errored, result: final })
    return final
  }

  /** The kill switch. Stops the running turn and everything queued. */
  async stop(reason = 'stopped') {
    const turns = [this.running, ...this.queue].filter(Boolean)
    this.queue.length = 0
    for (const [id] of this.pendingApprovals) this.#closeApproval(id, 'deny')
    for (const [id] of this.pendingQuestions) this.#closeQuestion(id, '(stopped)')
    for (const t of turns) t.stopped = true
    await this.running?.brain?.interrupt()
    logAction({ kind: 'stop', reason })
    this.broadcast({ type: 'stopped', reason })
  }

  // ---- approvals ---------------------------------------------------------

  async #gate(turn, name, input, toolUseId) {
    if (turn.stopped) return { ok: false, reason: 'The user pressed stop. End the task now and say what you got done.' }
    const { decision, risk } = decide(name, input, { config: this.config, trustTurn: turn.trust })
    const label = describe(name, input)
    if (decision === 'allow') {
      logAction({ kind: 'tool', turn: turn.id, tool: canonical(name), risk, decision: 'auto', input })
      return { ok: true }
    }
    if (!this.clients.size) {
      logAction({ kind: 'tool', turn: turn.id, tool: canonical(name), risk, decision: 'denied-no-one-there', input })
      return {
        ok: false,
        reason: 'This needs the user\'s approval and no Onyx window is open to ask. Skip this step and report it in your summary.',
      }
    }
    const answer = await this.#approve(turn, { tool: canonical(name), label, risk, input })
    logAction({ kind: 'tool', turn: turn.id, tool: canonical(name), risk, decision: answer, input })
    if (answer === 'allow_turn') turn.trust = true
    if (answer === 'always' && risk !== 'danger') {
      const tool = canonical(name)
      if (!this.config.alwaysAllow.includes(tool)) {
        this.config.alwaysAllow.push(tool)
        saveConfig({ alwaysAllow: this.config.alwaysAllow })
      }
    }
    return answer === 'deny'
      ? { ok: false, reason: `The user declined: ${label}. Do not retry it another way; ask or report instead.` }
      : { ok: true }
  }

  #approve(turn, { tool, label, risk, input }) {
    return new Promise((resolve) => {
      const id = randomUUID().slice(0, 8)
      const event = { type: 'approval', id, turn: turn.id, tool, label, risk, input, canAlways: risk !== 'danger', background: turn.background }
      const timer = setTimeout(() => this.#closeApproval(id, 'deny'), this.config.approvalTimeoutSec * 1000)
      this.pendingApprovals.set(id, { resolve, timer, turn: turn.id, event })
      this.broadcast(event)
      if (turn.background) this.notify('Onyx needs your OK', label)
    })
  }

  answerApproval(id, answer) {
    if (!['allow', 'allow_turn', 'always', 'deny'].includes(answer)) answer = 'deny'
    this.#closeApproval(id, answer)
  }

  #closeApproval(id, answer) {
    const a = this.pendingApprovals.get(id)
    if (!a) return
    this.pendingApprovals.delete(id)
    clearTimeout(a.timer)
    // "Always" is never available for dangerous actions, whatever a client sends.
    if (answer === 'always' && !a.event.canAlways) answer = 'allow'
    this.broadcast({ type: 'approval_closed', id, answer })
    a.resolve(answer)
  }

  // ---- questions (ask_user) ----------------------------------------------

  ask(question, choices = []) {
    if (!this.clients.size) return Promise.resolve('(The user is not available. Make a sensible choice or skip.)')
    return new Promise((resolve) => {
      const id = randomUUID().slice(0, 8)
      const event = { type: 'question', id, turn: this.running?.id, question, choices }
      const timer = setTimeout(() => this.#closeQuestion(id, '(no answer in time)'), this.config.approvalTimeoutSec * 1000)
      this.pendingQuestions.set(id, { resolve, timer, turn: this.running?.id, event })
      this.broadcast(event)
      if (this.running?.background) this.notify('Onyx has a question', question)
    })
  }

  answerQuestion(id, text) {
    this.#closeQuestion(id, String(text ?? ''))
  }

  #closeQuestion(id, text) {
    const q = this.pendingQuestions.get(id)
    if (!q) return
    this.pendingQuestions.delete(id)
    clearTimeout(q.timer)
    this.broadcast({ type: 'question_closed', id })
    q.resolve(text)
  }
}
