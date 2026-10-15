/**
 * Where Onyx keeps its state, and what it is configured to do.
 *
 * Everything that belongs to the user (config, memory, schedules, logs, the
 * access token) lives in ~/.onyx so a fresh clone of the repo never carries
 * anyone's data, and deleting that folder is a full reset.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = process.env.ONYX_HOME ?? join(homedir(), '.onyx')
export const LOG_DIR = join(DATA_DIR, 'logs')

for (const dir of [DATA_DIR, LOG_DIR]) mkdirSync(dir, { recursive: true })

export const dataPath = (name) => join(DATA_DIR, name)

/** Python inside the project venv, which `npm run setup` creates. */
export const PYTHON =
  process.env.ONYX_PYTHON ??
  (process.platform === 'win32'
    ? join(ROOT, '.venv', 'Scripts', 'python.exe')
    : join(ROOT, '.venv', 'bin', 'python'))

export const DEFAULTS = {
  port: 8765,
  // "claude" runs the Claude Agent SDK on your Claude Code login (no API key).
  // "local" runs any OpenAI-compatible server, e.g. Ollama or LM Studio, so
  // Onyx can work fully offline and free.
  brain: 'claude',
  claude: { model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 60 },
  local: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b-instruct',
    apiKey: 'ollama',
    maxSteps: 30,
  },
  // ask: every action waits for your OK. auto: actions run, dangerous ones ask.
  approvals: 'ask',
  // Tools you chose "always allow" for. Exact names, or a prefix ending in *.
  alwaysAllow: [],
  // How long an approval waits for an answer before it counts as a no.
  approvalTimeoutSec: 180,
  hotkey: 'Alt+Space',
  // Also load the MCP servers from your Claude Code config (~/.claude.json).
  includeClaudeCodeServers: false,
  phone: {
    // Read bank SMS from the phone over adb and log expenses automatically.
    smsSync: true,
    smsSyncMinutes: 15,
    adbPath: '',
  },
  expenses: {
    // With a custom ONYX_HOME (tests, a second profile) the workbook lives
    // there too, so it never touches your real Documents.
    workbook: process.env.ONYX_HOME
      ? join(process.env.ONYX_HOME, 'Expenses.xlsx')
      : join(homedir(), 'Documents', 'Onyx', 'Expenses.xlsx'),
  },
  // Serve the phone web app and the SMS webhook to your Wi-Fi network.
  // Off by default: only this PC can reach Onyx until you turn it on.
  lan: { enabled: false, port: 8766 },
  voice: {
    enabled: false,
    wakeWord: 'hey_jarvis',
    pushToTalk: 'ctrl+alt+space',
    whisperModel: 'base.en',
    piperVoice: 'en_US-lessac-medium',
  },
}

const CONFIG_FILE = dataPath('config.json')

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return over === undefined ? base : over
  }
  const out = { ...base }
  for (const [k, v] of Object.entries(over ?? {})) out[k] = merge(base[k], v)
  return out
}

export function loadConfig() {
  let user = {}
  if (existsSync(CONFIG_FILE)) {
    try {
      user = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    } catch (err) {
      console.error(`[onyx] ${CONFIG_FILE} is not valid JSON, using defaults:`, err.message)
    }
  } else {
    writeFileSync(CONFIG_FILE, JSON.stringify({ brain: DEFAULTS.brain }, null, 2))
  }
  const cfg = merge(DEFAULTS, user)
  if (process.env.ONYX_BRAIN) cfg.brain = process.env.ONYX_BRAIN
  if (process.env.ONYX_MODEL) {
    if (cfg.brain === 'local') cfg.local.model = process.env.ONYX_MODEL
    else cfg.claude.model = process.env.ONYX_MODEL
  }
  if (process.env.ONYX_PORT) cfg.port = Number(process.env.ONYX_PORT)
  return cfg
}

/** Write back only the keys given, keeping whatever else the user set. */
export function saveConfig(patch) {
  let user = {}
  try {
    user = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {}
  writeFileSync(CONFIG_FILE, JSON.stringify(merge(user, patch), null, 2))
}

/**
 * The shared secret every client presents. Onyx can drive your whole PC, so
 * "is on localhost" is not enough: any web page you open can reach localhost.
 */
export function accessToken() {
  const file = dataPath('token')
  if (!existsSync(file)) writeFileSync(file, randomBytes(24).toString('hex'))
  return readFileSync(file, 'utf8').trim()
}
