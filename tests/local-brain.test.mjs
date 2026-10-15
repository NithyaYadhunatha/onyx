import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ONYX_HOME = mkdtempSync(join(tmpdir(), 'onyx-local-'))
const { LocalBrain } = await import('../core/brain/local.mjs')
const { DEFAULTS } = await import('../core/config.mjs')

/** A fake Ollama: replies with the next scripted message and records requests. */
function fakeOllama(script, { vision = true } = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    if (req.url === '/api/version') return res.end('{"version":"test"}')
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'tools', ...(vision ? ['vision'] : [])] }))
    const j = JSON.parse(body)
    requests.push(j)
    const reply = script.shift() ?? { content: 'done' }
    res.write(JSON.stringify({ message: { role: 'assistant', content: reply.content ?? '' }, done: false }) + '\n')
    if (reply.tool_calls) {
      res.write(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: reply.tool_calls }, done: false }) + '\n')
    }
    res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n')
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, requests, url: `http://127.0.0.1:${server.address().port}` })))
}

const toolbox = (calls) => ({
  listTools: async () => [
    { fullName: 'mcp__onyx_desktop__list_windows', description: 'List open windows. More detail here.', inputSchema: { type: 'object', properties: {}, title: 'x' } },
    { fullName: 'mcp__onyx_desktop__screenshot', description: 'Screenshot.', inputSchema: { type: 'object', properties: {} } },
    { fullName: 'mcp__onyx_phone__tap', description: 'Tap.', inputSchema: { type: 'object', properties: { x: { type: 'number', title: 'X' } } } },
  ],
  call: async (server, tool, args) => {
    calls.push(`${server}.${tool}`)
    if (tool === 'screenshot') return { content: [{ type: 'text', text: 'shot' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] }
    return { content: [{ type: 'text', text: '[{"title":"Notepad"}]' }] }
  },
})

async function run(brain, text, gate = async () => ({ ok: true })) {
  const events = []
  for await (const ev of brain.send(text, { gate })) events.push(ev)
  return events
}

const make = (url, calls, extra = {}) =>
  new LocalBrain({
    config: { ...structuredClone(DEFAULTS), local: { ...DEFAULTS.local, baseUrl: url, ...extra } },
    toolbox: toolbox(calls),
    onyxTools: [],
    systemPrompt: 'test',
  })

test('runs a tool call and finishes with the answer', async () => {
  const o = await fakeOllama([
    { tool_calls: [{ function: { name: 'mcp__onyx_desktop__list_windows', arguments: {} } }] },
    { content: 'Notepad is open.' },
  ])
  const calls = []
  const ev = await run(make(o.url, calls), 'what is open?')
  assert.deepEqual(calls, ['onyx_desktop.list_windows'])
  assert.equal(ev.at(-1).type, 'done')
  assert.equal(ev.at(-1).text, 'Notepad is open.')
  // Tool output goes back to the model, tagged with the tool name.
  const second = o.requests[1].messages
  assert.equal(second.at(-1).role, 'tool')
  assert.equal(second.at(-1).tool_name, 'mcp__onyx_desktop__list_windows')
  // Descriptions are compacted and pydantic titles stripped.
  const spec = o.requests[0].tools.find((t) => t.function.name === 'mcp__onyx_desktop__list_windows')
  assert.equal(spec.function.description, 'List open windows.')
  assert.equal(spec.function.parameters.title, undefined)
  assert.equal(o.requests[0].options.num_ctx, DEFAULTS.local.numCtx)
  o.server.close()
})

test('recovers a tool call written as text', async () => {
  const o = await fakeOllama([
    { content: '<tool_call>{"name": "mcp__onyx_desktop__list_windows", "arguments": {}}</tool_call>' },
    { content: 'ok' },
  ])
  const calls = []
  const ev = await run(make(o.url, calls), 'windows?')
  assert.deepEqual(calls, ['onyx_desktop.list_windows'])
  assert.ok(!ev.some((e) => e.type === 'text' && e.delta.includes('<tool_call>')))
  o.server.close()
})

test('phone tools appear only when the request is about the phone', async () => {
  const o = await fakeOllama([{ content: 'a' }, { content: 'b' }])
  const brain = make(o.url, [])
  await run(brain, 'organise my downloads')
  assert.ok(!o.requests[0].tools.some((t) => t.function.name.startsWith('mcp__onyx_phone__')))
  await run(brain, 'open whatsapp on my phone')
  assert.ok(o.requests[1].tools.some((t) => t.function.name === 'mcp__onyx_phone__tap'))
  o.server.close()
})

test('a denied action is reported back, not run', async () => {
  const o = await fakeOllama([
    { tool_calls: [{ function: { name: 'shell', arguments: { command: 'echo hi' } } }] },
    { content: 'I could not do that.' },
  ])
  const ev = await run(make(o.url, []), 'say hi', async () => ({ ok: false, reason: 'The user declined.' }))
  const done = ev.find((e) => e.type === 'tool_done')
  assert.equal(done.ok, false)
  assert.equal(o.requests[1].messages.at(-1).content, 'The user declined.')
  o.server.close()
})

test('screenshots reach a vision model as images, and old ones are dropped', async () => {
  const shot = { tool_calls: [{ function: { name: 'mcp__onyx_desktop__screenshot', arguments: {} } }] }
  const o = await fakeOllama([shot, shot, { content: 'seen' }])
  await run(make(o.url, []), 'look')
  const last = o.requests[2].messages
  const withImages = last.filter((m) => m.images?.length)
  assert.equal(withImages.length, 1)
  assert.deepEqual(withImages[0].images, ['AAAA'])
  o.server.close()
})

test('unknown tool names get a correction instead of a crash', async () => {
  const o = await fakeOllama([
    { tool_calls: [{ function: { name: 'open_browser', arguments: {} } }] },
    { content: 'fine' },
  ])
  const ev = await run(make(o.url, []), 'x')
  assert.match(o.requests[1].messages.at(-1).content, /no tool called open_browser/)
  assert.equal(ev.at(-1).type, 'done')
  o.server.close()
})
