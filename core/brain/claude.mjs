/**
 * The Claude brain: Claude Code run headless through the Claude Agent SDK.
 *
 * It authenticates with your existing Claude Code login, so there is no API
 * key and no separate bill. One long-lived session per conversation keeps the
 * context and the tool servers warm between turns.
 *
 * Every tool call goes through a PreToolUse hook, and that hook is the gate:
 * unlike canUseTool, hooks are called for every tool, including the ones
 * Claude Code would otherwise wave through on its own.
 */

import { homedir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'

const DISALLOWED = [
  // These need Claude Code's own terminal UI; Onyx has ask_user instead.
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitWorktree',
]

const FAILURES = {
  error_max_turns: 'I hit my step limit for one task. Tell me to continue if you want me to keep going.',
  error_during_execution: 'Something went wrong while I was working on that.',
  default: 'That did not finish properly.',
}

export class ClaudeBrain {
  /**
   * @param opts.config       loaded config
   * @param opts.servers      MCP servers { name: spec } (Onyx's and extras)
   * @param opts.onyxServer   the in-process "onyx" SDK server
   * @param opts.systemPrompt string
   * @param opts.oneShot      a single background prompt, no follow-ups
   */
  constructor(opts) {
    this.opts = opts
    this.session = null
    this.inbox = []
    this.deliver = null
    this.closed = false
    this.ctx = null
    this.approved = new Set()
  }

  #start() {
    const { config, servers, onyxServer, systemPrompt } = this.opts
    const self = this
    this.closed = false
    this.deliver = null
    async function* input() {
      while (!self.closed) {
        const text =
          self.inbox.shift() ??
          (await new Promise((resolve) => {
            self.deliver = resolve
          }))
        if (self.closed || text == null) return
        yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
      }
    }

    const gate = async (name, toolInput, toolUseId) => {
      if (toolUseId && this.approved.has(toolUseId)) return { ok: true }
      const verdict = (await this.ctx?.gate(name, toolInput, toolUseId)) ?? { ok: false, reason: 'No task is running.' }
      if (verdict.ok && toolUseId) this.approved.add(toolUseId)
      return verdict
    }

    this.session = query({
      prompt: input(),
      options: {
        systemPrompt,
        model: config.claude.model,
        effort: config.claude.effort,
        maxTurns: config.claude.maxTurns,
        cwd: homedir(),
        // Onyx has a few dozen tools; loading them all up front saves the model
        // a tool-search round trip on every new conversation.
        env: { ...process.env, ENABLE_TOOL_SEARCH: 'false' },
        // Load no settings files: your ~/.claude settings may allow-list Bash
        // or bypass permissions, and Onyx must be the only authority here.
        settingSources: [],
        permissionMode: 'default',
        includePartialMessages: true,
        disallowedTools: DISALLOWED,
        mcpServers: { ...servers, onyx: onyxServer },
        hooks: {
          PreToolUse: [
            {
              // Long enough for you to walk back to the PC and approve.
              timeout: config.approvalTimeoutSec + 30,
              hooks: [
                async (h) => {
                  const v = await gate(h.tool_name, h.tool_input, h.tool_use_id)
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: v.ok ? 'allow' : 'deny',
                      permissionDecisionReason: v.reason ?? (v.ok ? 'Approved' : 'Denied'),
                    },
                  }
                },
              ],
            },
          ],
        },
        // A second gate for anything that reaches the permission prompt
        // without having passed the hook. Approvals are remembered by
        // tool_use id, so nothing is ever asked twice.
        canUseTool: async (name, toolInput, options) => {
          const v = await gate(name, toolInput, options?.toolUseID)
          return v.ok
            ? { behavior: 'allow', updatedInput: toolInput }
            : { behavior: 'deny', message: v.reason ?? 'Denied by Onyx policy.' }
        },
        stderr: (data) => {
          if (process.env.ONYX_DEBUG) console.error('[claude]', data.trim())
        },
      },
    })
    this.iter = this.session[Symbol.asyncIterator]()
  }

  /**
   * Run one turn. Yields { type: 'text' | 'tool' | 'tool_done' | 'done' | 'error' }.
   * @param ctx { gate(name, input, id) => Promise<{ok, reason}> }
   */
  async *send(text, ctx) {
    if (!this.session) this.#start()
    this.ctx = ctx
    this.approved.clear()
    if (this.deliver) {
      const d = this.deliver
      this.deliver = null
      d(text)
    } else {
      this.inbox.push(text)
    }

    let finalText = ''
    while (true) {
      let step
      try {
        step = await this.iter.next()
      } catch (err) {
        this.close()
        yield { type: 'error', message: friendlyError(err) }
        return
      }
      if (step.done) {
        this.close()
        yield { type: 'error', message: 'The Claude session ended unexpectedly. Your next message starts a new one.' }
        return
      }
      const msg = step.value
      switch (msg.type) {
        case 'stream_event': {
          const ev = msg.event
          if (msg.parent_tool_use_id) break // a subagent's own chatter
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            finalText += ev.delta.text
            yield { type: 'text', delta: ev.delta.text }
          }
          break
        }
        case 'assistant': {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'tool_use') yield { type: 'tool', id: block.id, name: block.name, input: block.input }
          }
          // Separate the text of consecutive assistant messages.
          if (!msg.parent_tool_use_id && finalText && !finalText.endsWith('\n')) {
            finalText += '\n'
            yield { type: 'text', delta: '\n' }
          }
          break
        }
        case 'user': {
          const blocks = msg.message?.content
          if (!Array.isArray(blocks)) break
          for (const b of blocks) {
            if (b?.type === 'tool_result') {
              yield { type: 'tool_done', id: b.tool_use_id, ok: b.is_error !== true, summary: resultSummary(b.content) }
            }
          }
          break
        }
        case 'result': {
          this.ctx = null
          if (msg.subtype === 'success') {
            yield { type: 'done', text: msg.result ?? finalText.trim(), costUsd: msg.total_cost_usd ?? null }
          } else {
            yield { type: 'error', message: FAILURES[msg.subtype] ?? FAILURES.default }
          }
          return
        }
        case 'system':
          if (msg.subtype === 'init') {
            const failed = (msg.mcp_servers ?? []).filter((s) => s.status === 'failed').map((s) => s.name)
            if (failed.length) console.error(`[onyx] tool servers that failed to start: ${failed.join(', ')}`)
          }
          break
      }
    }
  }

  async interrupt() {
    await this.session?.interrupt?.().catch(() => {})
  }

  close() {
    this.closed = true
    this.deliver?.(null)
    try {
      this.session?.close?.()
    } catch {}
    this.session = null
  }
}

function resultSummary(content) {
  if (typeof content === 'string') return content.slice(0, 300)
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : ''))
    .join(' ')
    .slice(0, 300)
}

function friendlyError(err) {
  const s = String(err?.message ?? err)
  if (/login|auth|credential|401/i.test(s)) {
    return 'Claude Code is not logged in. Run "npx claude" once in a terminal and log in, then try again.'
  }
  if (/rate|429|usage limit/i.test(s)) return 'Claude usage limit reached for now. Try again later, or switch Onyx to the local brain.'
  return `Claude error: ${s.slice(0, 300)}`
}
