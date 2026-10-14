/**
 * Onyx's own tools, the ones that live inside the core rather than in a
 * Python server: memory, scheduled tasks, asking you a question, and
 * notifying you.
 *
 * Each is written once, here, and adapted for both brains: as an in-process
 * MCP server for the Claude Agent SDK, and as JSON-schema functions for the
 * local brain.
 */

import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { forget, recall, remember } from './memory.mjs'

/**
 * @param scheduler the Scheduler
 * @param hub       { ask(question, choices) => Promise<string>, notify(title, body) }
 */
export function onyxTools({ scheduler, hub }) {
  return [
    {
      name: 'remember',
      description:
        'Save a lasting fact about the user or their setup, so you never have to ask again ' +
        '(where their files live, preferences, routines, names). Set pinned for facts that ' +
        'matter in almost every conversation.',
      shape: {
        text: z.string().describe('The fact, written as a full sentence.'),
        pinned: z.boolean().optional().describe('Include in every conversation.'),
      },
      run: ({ text, pinned }) => remember(text, { pinned: Boolean(pinned) }),
    },
    {
      name: 'recall',
      description: 'Search what you have remembered about the user. Use before asking them something you might already know.',
      shape: { query: z.string() },
      run: ({ query }) => recall(query),
    },
    {
      name: 'forget',
      description: 'Delete a remembered fact by its id.',
      shape: { id: z.string() },
      run: ({ id }) => ({ forgotten: forget(id) }),
    },
    {
      name: 'schedule_task',
      description:
        'Make Onyx do something later or automatically, without being asked. Give exactly one of: ' +
        'cron (a 5-field cron pattern in local time, e.g. "0 21 * * *" for 9pm daily, "0 9 1 * *" for ' +
        '9am on the 1st), at (an ISO date-time, once), or trigger: "sms" (a new SMS reached Onyx; ' +
        'optional filter: words separated by |), "file" (a new file appeared in `folder`), "startup", ' +
        '"phone" (the phone connected). The prompt is what you will be told to do when it fires, so ' +
        'write it as a complete instruction.',
      shape: {
        name: z.string(),
        prompt: z.string(),
        cron: z.string().optional(),
        at: z.string().optional(),
        trigger: z.enum(['sms', 'file', 'startup', 'phone']).optional(),
        filter: z.string().optional(),
        folder: z.string().optional(),
      },
      run: (args) => scheduler.add(args),
    },
    {
      name: 'list_tasks',
      description: 'List scheduled and triggered tasks with when they next run and how they last went.',
      shape: {},
      run: () => scheduler.list(),
    },
    {
      name: 'cancel_task',
      description: 'Delete a scheduled or triggered task by id.',
      shape: { id: z.string() },
      run: ({ id }) => ({ cancelled: scheduler.remove(id) }),
    },
    {
      name: 'ask_user',
      description:
        'Ask the user a question and wait for the answer. Use when you truly cannot continue ' +
        'without them: an ambiguous choice, missing information, or before anything irreversible ' +
        'that the tool approval would not already cover. Offer choices when there are a few obvious ones.',
      shape: {
        question: z.string(),
        choices: z.array(z.string()).optional(),
      },
      run: async ({ question, choices }) => ({ answer: await hub.ask(question, choices ?? []) }),
    },
    {
      name: 'notify',
      description: 'Show the user a desktop notification. Use for results of background or scheduled work.',
      shape: { title: z.string(), body: z.string() },
      run: ({ title, body }) => {
        hub.notify(title, body)
        return { shown: true }
      },
    },
  ]
}

const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))

/** For the Claude brain: an in-process MCP server named "onyx". */
export function sdkServer(tools) {
  return createSdkMcpServer({
    name: 'onyx',
    version: '0.1.0',
    alwaysLoad: true,
    tools: tools.map((t) =>
      tool(t.name, t.description, t.shape, async (args) => {
        try {
          return { content: [{ type: 'text', text: asText(await t.run(args)) }] }
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: String(err.message ?? err) }] }
        }
      }),
    ),
  })
}

/** For the local brain: OpenAI-style function definitions. */
export function functionSpecs(tools, prefix = 'mcp__onyx__') {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: prefix + t.name,
      description: t.description,
      parameters: z.toJSONSchema(z.object(t.shape)),
    },
  }))
}

export { asText }
