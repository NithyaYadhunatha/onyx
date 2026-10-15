/**
 * The local brain: an open model on your own PC. Free, offline, private.
 *
 * Talks to Ollama's native API by default (provider "ollama"), which lets
 * Onyx set the context size, turn thinking on or off, stream the reply, and
 * show the model screenshots when it can see. Any OpenAI-compatible server
 * (LM Studio, llama.cpp, vLLM) works with provider "openai".
 *
 * Small models need help that big ones do not, so this brain:
 *   - only offers the phone tools when the request is about the phone
 *   - keeps tool descriptions to their first sentence
 *   - trims old tool output and old screenshots to stay inside the context
 *   - recovers tool calls written as text instead of as real calls
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { functionSpecs, asText } from '../tools.mjs'
import { webFetch, webSearch } from './web.mjs'

const fn = (name, description, properties, required = Object.keys(properties)) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
})

const BUILTINS = [
  fn('shell', 'Run a PowerShell command on the PC and return its output. Use for files, folders, settings and opening things (Start-Process).', {
    command: { type: 'string' },
  }),
  fn('read_file', 'Read a text file.', { path: { type: 'string' } }),
  fn('write_file', 'Write a text file, creating folders as needed.', { path: { type: 'string' }, content: { type: 'string' } }),
  fn('list_dir', 'List a folder: names, sizes, modified dates.', { path: { type: 'string' } }),
  fn('web_search', 'Search the web. Returns titles, links and snippets.', { query: { type: 'string' } }),
  fn('web_fetch', 'Read a web page as text.', { url: { type: 'string' } }),
]

const PHONE_WORDS =
  /\b(phone|mobile|android|whatsapp|sms|text message|instagram|telegram|my apps?|battery|notification|dial|call (mom|dad|amma|appa|him|her)|phonepe|gpay|paytm)\b/i

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
      return readFileSync(abs(args.path), 'utf8').slice(0, 30_000)
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
    case 'web_search':
      return webSearch(args.query, signal)
    case 'web_fetch':
      return webFetch(args.url, signal)
  }
  throw new Error(`unknown tool ${name}`)
}

/** First sentence, and no pydantic "title" noise: small models read every token. */
function compact(spec) {
  const f = spec.function
  const first = (f.description ?? '').split(/(?<=[.!?])\s/)[0].slice(0, 240)
  const strip = (s) => {
    if (!s || typeof s !== 'object') return s
    const { title, ...rest } = s
    if (rest.properties) rest.properties = Object.fromEntries(Object.entries(rest.properties).map(([k, v]) => [k, strip(v)]))
    if (rest.anyOf) rest.anyOf = rest.anyOf.map(strip)
    return rest
  }
  return { type: 'function', function: { name: f.name, description: first, parameters: strip(f.parameters ?? { type: 'object', properties: {} }) } }
}

/** Some models write the call as text: <tool_call>{...}</tool_call> or bare JSON. */
function callsFromText(text, known) {
  const out = []
  const blocks = [...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((m) => m[1])
  if (!blocks.length) {
    const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
    if (t.startsWith('{') && t.endsWith('}')) blocks.push(t)
  }
  for (const b of blocks) {
    try {
      const j = JSON.parse(b)
      const name = j.name ?? j.function?.name
      const args = j.arguments ?? j.parameters ?? j.function?.arguments ?? {}
      if (name && known.has(name)) out.push({ id: `t${Math.random().toString(36).slice(2, 8)}`, name, args: typeof args === 'string' ? JSON.parse(args) : args })
    } catch {}
  }
  return out
}

let ollamaStarting = null
function ollamaBinary() {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
  ]
  return candidates.find((c) => existsSync(c)) ?? 'ollama'
}

/** Ollama normally runs from the tray; if it is not running, start it. */
async function ensureOllama(baseUrl) {
  const up = () =>
    fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false)
  if (await up()) return true
  ollamaStarting ??= (async () => {
    try {
      spawn(ollamaBinary(), ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } catch {
      return false
    }
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (await up()) return true
    }
    return false
  })()
  const ok = await ollamaStarting
  ollamaStarting = null
  return ok
}

export class LocalBrain {
  /**
   * @param opts.config, opts.toolbox (Toolbox), opts.onyxTools (array), opts.systemPrompt
   */
  constructor(opts) {
    this.opts = opts
    this.cfg = opts.config.local
    this.provider = this.cfg.provider ?? (/\/v1\/?$/.test(this.cfg.baseUrl) ? 'openai' : 'ollama')
    this.base = this.cfg.baseUrl.replace(/\/+$/, '').replace(this.provider === 'ollama' ? /\/v1$/ : /$^/, '')
    this.messages = [{ role: 'system', content: opts.systemPrompt }]
    this.abort = null
    this.allTools = null
    this.vision = null
    this.phoneActive = false
    this.numGpu = this.cfg.numGpu ?? null
  }

  async #tools() {
    if (this.allTools) return this.allTools
    const mcp = await this.opts.toolbox.listTools()
    this.allTools = [
      ...BUILTINS,
      ...functionSpecs(this.opts.onyxTools),
      ...mcp.map((t) => ({ type: 'function', function: { name: t.fullName, description: t.description ?? '', parameters: t.inputSchema } })),
    ].map(compact)
    return this.allTools
  }

  async #canSee() {
    if (this.vision !== null) return this.vision
    if (this.provider !== 'ollama') return (this.vision = Boolean(this.cfg.vision))
    try {
      const r = await fetch(`${this.base}/api/show`, { method: 'POST', body: JSON.stringify({ model: this.cfg.model }) })
      const j = await r.json()
      this.vision = Array.isArray(j.capabilities) ? j.capabilities.includes('vision') : Boolean(this.cfg.vision)
    } catch {
      this.vision = Boolean(this.cfg.vision)
    }
    return this.vision
  }

  /** Keep the conversation inside the context window, oldest bulk first. */
  #trim() {
    const budget = (this.cfg.numCtx ?? 16384) * 3.2 * 0.55 // chars, leaving room for tools and the reply
    const size = () => this.messages.reduce((n, m) => n + String(m.content ?? '').length + (m.images?.length ?? 0) * 3000, 0)
    // 1. Only the latest screenshot stays as an image.
    let seenImage = false
    for (let i = this.messages.length - 1; i > 0; i--) {
      const m = this.messages[i]
      if (m.images?.length) {
        if (seenImage) {
          delete m.images
          m.content = '[older screenshot removed]'
        }
        seenImage = true
      }
    }
    // 2. Shorten old tool results.
    for (let i = 1; i < this.messages.length - 6 && size() > budget; i++) {
      const m = this.messages[i]
      if (m.role === 'tool' && String(m.content).length > 300) m.content = String(m.content).slice(0, 300) + ' …[trimmed]'
    }
    // 3. Drop whole old exchanges, keeping the system prompt.
    while (size() > budget && this.messages.length > 8) {
      this.messages.splice(1, 1)
      while (this.messages[1] && this.messages[1].role === 'tool') this.messages.splice(1, 1)
    }
  }

  async *#chatOllama(tools, signal) {
    const request = (numGpu) =>
      fetch(`${this.base}/api/chat`, {
        method: 'POST',
        signal,
        body: JSON.stringify({
          model: this.cfg.model,
          messages: this.messages,
          tools,
          stream: true,
          think: Boolean(this.cfg.think),
          keep_alive: this.cfg.keepAlive ?? '30m',
          options: {
            num_ctx: this.cfg.numCtx ?? 16384,
            temperature: this.cfg.temperature ?? 0.3,
            ...(numGpu != null && { num_gpu: numGpu }),
          },
        }),
      })
    let res = await request(this.numGpu)
    if (!res.ok && this.numGpu != null) {
      const err = await res.text()
      if (/memory|cuda|alloc|unable to load|offload/i.test(err)) {
        // Too much for this GPU: let Ollama decide from now on.
        console.error(`[onyx] model does not fit fully on the GPU (${err.slice(0, 120)}); using Ollama's default split`)
        this.numGpu = null
        res = await request(null)
      } else {
        throw new Error(`${res.status} ${err.slice(0, 300)}`)
      }
    }
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`)
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const j = JSON.parse(line)
        if (j.error) throw new Error(j.error)
        yield j
      }
    }
  }

  async #chatOpenAI(tools, signal) {
    const res = await fetch(`${this.base}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey ?? 'local'}` },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: this.messages.map(({ images, tool_name, ...m }) => m),
        tools,
        temperature: this.cfg.temperature ?? 0.3,
      }),
    })
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`)
    const data = await res.json()
    return data.choices?.[0]?.message ?? { role: 'assistant', content: '' }
  }

  async *send(text, ctx) {
    this.abort = new AbortController()
    const signal = this.abort.signal
    if (PHONE_WORDS.test(text)) this.phoneActive = true
    this.messages.push({ role: 'user', content: text })

    let all
    try {
      if (this.provider === 'ollama' && !(await ensureOllama(this.base))) {
        return yield { type: 'error', message: 'Ollama is not running and could not be started. Open Ollama from the Start menu, then try again.' }
      }
      all = await this.#tools()
    } catch (err) {
      return yield { type: 'error', message: `Could not load tools: ${err.message}` }
    }
    const canSee = await this.#canSee()
    const onyxByName = new Map(this.opts.onyxTools.map((t) => [`mcp__onyx__${t.name}`, t]))

    for (let step = 0; step < (this.cfg.maxSteps ?? 40); step++) {
      const tools = all.filter((t) => this.phoneActive || !t.function.name.startsWith('mcp__onyx_phone__'))
      const known = new Set(tools.map((t) => t.function.name))
      this.#trim()

      let content = ''
      let calls = []
      try {
        if (this.provider === 'ollama') {
          for await (const j of this.#chatOllama(tools, signal)) {
            const m = j.message ?? {}
            if (m.content) {
              content += m.content
              // Hold back anything that looks like a text tool call.
              if (!/^\s*(<tool_call>|\{|```)/.test(content)) yield { type: 'text', delta: m.content }
            }
            for (const c of m.tool_calls ?? []) {
              calls.push({ id: `t${Math.random().toString(36).slice(2, 8)}`, name: c.function?.name, args: c.function?.arguments ?? {} })
            }
          }
        } else {
          const m = await this.#chatOpenAI(tools, signal)
          content = m.content ?? ''
          if (content) yield { type: 'text', delta: content }
          calls = (m.tool_calls ?? []).map((c) => {
            let args = {}
            try {
              args = typeof c.function?.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : c.function?.arguments ?? {}
            } catch {}
            return { id: c.id, name: c.function?.name, args }
          })
        }
      } catch (err) {
        if (signal.aborted) return yield { type: 'done', text: '(stopped)' }
        const s = String(err.message ?? err)
        const hint = /not found|pull/i.test(s)
          ? ` Run: ollama pull ${this.cfg.model}`
          : /ECONNREFUSED|fetch failed/i.test(s)
            ? ' Is Ollama running?'
            : ''
        return yield { type: 'error', message: `Local model error: ${s.slice(0, 300)}.${hint}` }
      }

      if (!calls.length) calls = callsFromText(content, known)
      const assistant = { role: 'assistant', content: calls.length && /^\s*(<tool_call>|\{)/.test(content) ? '' : content }
      if (calls.length) {
        assistant.tool_calls = calls.map((c) => ({
          ...(this.provider === 'openai' && { id: c.id, type: 'function' }),
          function: { name: c.name, arguments: this.provider === 'openai' ? JSON.stringify(c.args) : c.args },
        }))
      }
      this.messages.push(assistant)
      if (!calls.length) return yield { type: 'done', text: content.trim() }

      for (const call of calls) {
        const { name, args, id } = call
        yield { type: 'tool', id, name, input: args }
        let output = ''
        let images = []
        let ok = true
        if (!known.has(name)) {
          ok = false
          output = `There is no tool called ${name}. Use one of the tools you were given.`
        } else {
          const verdict = await ctx.gate(name, args, id)
          if (!verdict.ok) {
            ok = false
            output = verdict.reason ?? 'Denied.'
          } else {
            try {
              if (onyxByName.has(name)) {
                output = asText(await onyxByName.get(name).run(args))
              } else if (name.startsWith('mcp__')) {
                const [, server, ...rest] = name.split('__')
                if (server === 'onyx_phone') this.phoneActive = true
                const res = await this.opts.toolbox.call(server, rest.join('__'), args)
                ok = !res.isError
                for (const c of res.content ?? []) {
                  if (c.type === 'text') output += (output ? '\n' : '') + c.text
                  else if (c.type === 'image') {
                    if (canSee) images.push(c.data)
                    else output += '\n[screenshot taken, but this model cannot see images: use get_ui_tree instead]'
                  }
                }
              } else {
                output = await runBuiltin(name, args, signal)
              }
            } catch (err) {
              ok = false
              output = `Error: ${err.message ?? err}`
            }
          }
        }
        yield { type: 'tool_done', id, ok, summary: String(output).slice(0, 300) }
        this.messages.push({
          role: 'tool',
          content: String(output).slice(0, 12_000),
          ...(this.provider === 'ollama' ? { tool_name: name } : { tool_call_id: id }),
        })
        if (images.length) {
          this.messages.push({ role: 'user', content: `Screenshot from ${name.split('__').pop()}:`, images })
        }
        if (signal.aborted) return yield { type: 'done', text: '(stopped)' }
      }
    }
    yield { type: 'error', message: 'I hit my step limit for one task. Tell me to continue if you want me to keep going.' }
  }

  async interrupt() {
    this.abort?.abort()
  }

  close() {
    this.abort?.abort()
  }
}
