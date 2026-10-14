/**
 * The local brain: any OpenAI-compatible chat server (Ollama, LM Studio,
 * llama.cpp server, vLLM). Free, offline, private.
 *
 * Small local models are much weaker at long multi-step GUI tasks than Claude,
 * so this brain is best for files, shell, Excel, memory and phone tasks. Pick
 * a model with tool calling, e.g. `ollama pull qwen2.5:7b-instruct`
 * (or qwen2.5:3b-instruct on a 4 GB GPU).
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { functionSpecs, asText } from '../tools.mjs'

const BUILTINS = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Run a PowerShell command on the PC and return its output.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a text file, creating folders as needed.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List a folder: names, sizes, modified dates.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
]

const abs = (p) => resolve(homedir(), String(p ?? '').replace(/^~(?=$|[\\/])/, homedir()))

function runShell(command, signal) {
  return new Promise((done) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      cwd: homedir(),
    })
    let out = ''
    const add = (d) => {
      out += d.toString()
      if (out.length > 40_000) out = out.slice(-40_000)
    }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const timer = setTimeout(() => child.kill(), 120_000)
    signal?.addEventListener('abort', () => child.kill())
    child.on('close', (code) => {
      clearTimeout(timer)
      done(`${out.trim()}\n(exit code ${code})`)
    })
  })
}

async function runBuiltin(name, args, signal) {
  switch (name) {
    case 'shell':
      return runShell(args.command, signal)
    case 'read_file':
      return readFileSync(abs(args.path), 'utf8').slice(0, 60_000)
    case 'write_file': {
      const p = abs(args.path)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, args.content ?? '')
      return `wrote ${p}`
    }
    case 'list_dir': {
      const p = abs(args.path)
      return readdirSync(p)
        .slice(0, 300)
        .map((n) => {
          try {
            const s = statSync(join(p, n))
            return `${s.isDirectory() ? 'DIR ' : `${s.size}`.padStart(10)}  ${s.mtime.toISOString().slice(0, 16)}  ${n}`
          } catch {
            return n
          }
        })
        .join('\n')
    }
  }
  throw new Error(`unknown tool ${name}`)
}

export class LocalBrain {
  /**
   * @param opts.config, opts.toolbox (Toolbox), opts.onyxTools (array), opts.systemPrompt
   */
  constructor(opts) {
    this.opts = opts
    this.messages = [{ role: 'system', content: opts.systemPrompt }]
    this.abort = null
    this.specs = null
  }

  async #tools() {
    if (this.specs) return this.specs
    const mcp = await this.opts.toolbox.listTools()
    this.specs = [
      ...BUILTINS,
      ...functionSpecs(this.opts.onyxTools),
      ...mcp.map((t) => ({
        type: 'function',
        function: { name: t.fullName, description: (t.description ?? '').slice(0, 1000), parameters: t.inputSchema },
      })),
    ]
    return this.specs
  }

  async #chat(tools, signal) {
    const { baseUrl, model, apiKey } = this.opts.config.local
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: this.messages, tools, temperature: 0.2 }),
      signal,
    })
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`)
    const data = await res.json()
    return data.choices?.[0]?.message ?? { role: 'assistant', content: '' }
  }

  async *send(text, ctx) {
    this.abort = new AbortController()
    const signal = this.abort.signal
    this.messages.push({ role: 'user', content: text })
    let tools
    try {
      tools = await this.#tools()
    } catch (err) {
      yield { type: 'error', message: `Could not load tools: ${err.message}` }
      return
    }
    const onyxByName = new Map(this.opts.onyxTools.map((t) => [`mcp__onyx__${t.name}`, t]))

    for (let step = 0; step < this.opts.config.local.maxSteps; step++) {
      let msg
      try {
        msg = await this.#chat(tools, signal)
      } catch (err) {
        if (signal.aborted) return yield { type: 'done', text: '(stopped)' }
        const hint = /ECONNREFUSED|fetch failed/i.test(String(err.message ?? err))
          ? ` Is Ollama running? Start it, and run "ollama pull ${this.opts.config.local.model}".`
          : ''
        return yield { type: 'error', message: `Local model error: ${err.message}.${hint}` }
      }
      this.messages.push(msg)
      if (msg.content) yield { type: 'text', delta: msg.content + '\n' }
      const calls = msg.tool_calls ?? []
      if (!calls.length) {
        return yield { type: 'done', text: (msg.content ?? '').trim() }
      }
      for (const call of calls) {
        const name = call.function?.name
        let args = {}
        try {
          args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function?.arguments ?? {}
        } catch {}
        yield { type: 'tool', id: call.id, name, input: args }
        let output
        let ok = true
        const verdict = await ctx.gate(name, args, call.id)
        if (!verdict.ok) {
          ok = false
          output = verdict.reason ?? 'Denied.'
        } else {
          try {
            if (onyxByName.has(name)) {
              output = asText(await onyxByName.get(name).run(args))
            } else if (name.startsWith('mcp__')) {
              const [, server, ...rest] = name.split('__')
              const res = await this.opts.toolbox.call(server, rest.join('__'), args)
              ok = !res.isError
              output = (res.content ?? [])
                .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image: this local model cannot see images]' : ''))
                .join('\n')
            } else {
              output = await runBuiltin(name, args, signal)
            }
          } catch (err) {
            ok = false
            output = `Error: ${err.message ?? err}`
          }
        }
        yield { type: 'tool_done', id: call.id, ok, summary: String(output).slice(0, 300) }
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: String(output).slice(0, 20_000) })
        if (signal.aborted) return yield { type: 'done', text: '(stopped)' }
      }
    }
    yield { type: 'error', message: 'I hit my step limit for one task.' }
  }

  async interrupt() {
    this.abort?.abort()
  }

  close() {
    this.abort?.abort()
  }
}
