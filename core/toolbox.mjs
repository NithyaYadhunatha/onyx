/**
 * A direct MCP client to the tool servers.
 *
 * The Claude brain connects to the servers itself, through the Agent SDK. This
 * is for everything else: the local (Ollama) brain, and the pipelines in the
 * core that need a tool without asking a model, like logging a bank SMS
 * straight into the expense sheet.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export class Toolbox {
  constructor(servers) {
    this.servers = servers
    this.clients = new Map()
    this.pending = new Map()
  }

  async client(name) {
    if (this.clients.has(name)) return this.clients.get(name)
    if (this.pending.has(name)) return this.pending.get(name)
    const spec = this.servers[name]
    if (!spec) throw new Error(`no tool server named ${name}`)
    if (spec.type && spec.type !== 'stdio') throw new Error(`${name}: only stdio servers are supported here`)
    const p = (async () => {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        env: { ...process.env, ...(spec.env ?? {}) },
        stderr: 'pipe',
      })
      transport.stderr?.on('data', (d) => {
        const s = d.toString().trim()
        if (s) console.error(`[${name}] ${s}`)
      })
      const client = new Client({ name: 'onyx-core', version: '0.1.0' })
      await client.connect(transport)
      transport.onclose = () => this.clients.delete(name)
      this.clients.set(name, client)
      return client
    })()
    this.pending.set(name, p)
    try {
      return await p
    } finally {
      this.pending.delete(name)
    }
  }

  /** Every tool on every server, named `mcp__server__tool` like the SDK does. */
  async listTools() {
    const out = []
    for (const name of Object.keys(this.servers)) {
      try {
        const c = await this.client(name)
        const { tools } = await c.listTools()
        for (const t of tools) out.push({ ...t, server: name, fullName: `mcp__${name}__${t.name}` })
      } catch (err) {
        console.error(`[onyx] tool server ${name} unavailable: ${err.message}`)
      }
    }
    return out
  }

  /** Returns the raw MCP result: { content: [...], isError? } */
  async call(server, tool, args = {}, timeoutMs = 120_000) {
    const c = await this.client(server)
    return c.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs })
  }

  /** Call a tool and parse its text answer as JSON (Onyx's servers reply in JSON). */
  async json(server, tool, args = {}) {
    const res = await this.call(server, tool, args)
    const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    if (res.isError) throw new Error(text || `${server}.${tool} failed`)
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  async close() {
    for (const c of this.clients.values()) await c.close().catch(() => {})
    this.clients.clear()
  }
}
