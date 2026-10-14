/**
 * The MCP servers that give Onyx its hands.
 *
 * Onyx's own servers are Python, run from the project venv. You can add any
 * other MCP server too: put it in ~/.onyx/servers.json in the same shape as
 * Claude Code's "mcpServers", or set includeClaudeCodeServers to reuse the
 * ones already in ~/.claude.json.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PYTHON, ROOT, accessToken, dataPath } from './config.mjs'

const py = (script, env = {}) => ({
  type: 'stdio',
  command: PYTHON,
  args: ['-X', 'utf8', join(ROOT, 'servers', script)],
  env: { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...env },
})

export function onyxServers(config) {
  const env = {
    ONYX_CORE_URL: `http://127.0.0.1:${config.port}`,
    ONYX_TOKEN: accessToken(),
    ONYX_ADB: config.phone.adbPath || '',
    ONYX_EXPENSES: config.expenses.workbook,
    ONYX_HOME: dataPath(''),
  }
  return {
    onyx_desktop: py('desktop/server.py', env),
    onyx_office: py('office/server.py', env),
    onyx_phone: py('phone/server.py', env),
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function extraServers(config) {
  const out = {}
  if (config.includeClaudeCodeServers) {
    const cc = readJson(join(homedir(), '.claude.json'))
    Object.assign(out, cc?.mcpServers ?? {}, cc?.projects?.[homedir()]?.mcpServers ?? {})
  }
  const mine = dataPath('servers.json')
  if (existsSync(mine)) Object.assign(out, readJson(mine)?.mcpServers ?? readJson(mine) ?? {})
  // Never let an extra server shadow one of Onyx's own.
  for (const k of Object.keys(out)) if (k.startsWith('onyx')) delete out[k]
  return out
}

export const allServers = (config) => ({ ...onyxServers(config), ...extraServers(config) })
