/**
 * Which tool calls run on their own and which wait for you.
 *
 * Every tool is one of three risks:
 *   read   - looks, changes nothing (screenshots, reading a file, listing windows)
 *   act    - changes something you can undo or see (a click, typing, writing a file)
 *   danger - hard to undo or reaches other people (sending a message, deleting,
 *            dialling, risky shell commands). Always asks, in every mode.
 *
 * Onyx's own tools are listed by name. Anything else (a built-in Claude Code
 * tool, an MCP server you added) is classified from its name, and the default
 * for anything unrecognised is "act", which asks.
 */

export const RISK = {
  // Onyx desktop server
  'onyx_desktop.list_windows': 'read',
  'onyx_desktop.list_apps': 'read',
  'onyx_desktop.get_ui_tree': 'read',
  'onyx_desktop.find_elements': 'read',
  'onyx_desktop.screenshot': 'read',
  'onyx_desktop.screen_info': 'read',
  'onyx_desktop.wait': 'read',
  'onyx_desktop.wait_for': 'read',
  'onyx_desktop.get_clipboard': 'read',
  'onyx_desktop.focus_window': 'read',
  'onyx_desktop.scroll': 'read',
  'onyx_desktop.open_app': 'act',
  'onyx_desktop.click': 'act',
  'onyx_desktop.type_text': 'act',
  'onyx_desktop.press_keys': 'act',
  'onyx_desktop.drag': 'act',
  'onyx_desktop.set_clipboard': 'act',
  'onyx_desktop.window_action': 'act',
  'onyx_desktop.system_volume': 'act',
  // Onyx office server
  'onyx_office.excel_read': 'read',
  'onyx_office.excel_info': 'read',
  'onyx_office.parse_statement': 'read',
  'onyx_office.parse_sms': 'read',
  'onyx_office.expense_summary': 'read',
  'onyx_office.excel_write': 'act',
  'onyx_office.expense_add': 'act',
  'onyx_office.set_category_rule': 'act',
  // Onyx phone server
  'onyx_phone.devices': 'read',
  'onyx_phone.screenshot': 'read',
  'onyx_phone.ui_tree': 'read',
  'onyx_phone.read_sms': 'read',
  'onyx_phone.notifications': 'read',
  'onyx_phone.list_apps': 'read',
  'onyx_phone.battery': 'read',
  'onyx_phone.connect': 'act',
  'onyx_phone.tap': 'act',
  'onyx_phone.type_text': 'act',
  'onyx_phone.key': 'act',
  'onyx_phone.swipe': 'act',
  'onyx_phone.open_app': 'act',
  'onyx_phone.open_url': 'act',
  'onyx_phone.dial': 'danger',
  'onyx_phone.send_sms': 'danger',
  // Onyx's own tools inside the core
  'onyx.remember': 'read',
  'onyx.recall': 'read',
  'onyx.ask_user': 'read',
  'onyx.notify': 'read',
  'onyx.list_tasks': 'read',
  'onyx.forget': 'act',
  'onyx.schedule_task': 'act',
  'onyx.cancel_task': 'act',
}

/** Claude Code built-ins. Anything not here falls to the name rules. */
const BUILTIN = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  LS: 'read',
  WebSearch: 'read',
  WebFetch: 'read',
  TodoWrite: 'read',
  ToolSearch: 'read',
  ListMcpResourcesTool: 'read',
  ReadMcpResourceTool: 'read',
  BashOutput: 'read',
  KillShell: 'read',
  Task: 'read',
  Agent: 'read',
  Write: 'act',
  Edit: 'act',
  MultiEdit: 'act',
  NotebookEdit: 'act',
  Bash: 'act',
  PowerShell: 'act',
  // The local brain's own tools.
  shell: 'act',
  read_file: 'read',
  list_dir: 'read',
  write_file: 'act',
}

const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot|lookup|count)/i
const DANGER_VERB =
  /(send|call|dial|post|publish|delete|remove|purge|pay|buy|purchase|transfer|order|charge|tweet|share|invite|deploy|uninstall)/i

/** Shell commands that deserve a second look even when actions are on auto. */
const DANGER_SHELL = [
  /\brm\s+(-\w*r\w*f|-\w*f\w*r)\b/i,
  /\bremove-item\b[^|]*-recurse/i,
  /\b(del|erase|rd|rmdir)\b[^|]*\s\/s\b/i,
  /\bformat(-volume)?\s+[a-z]:?/i,
  /\b(diskpart|bcdedit|cipher\s+\/w)\b/i,
  /\breg(\.exe)?\s+(delete|add)\b/i,
  /\b(remove-itemproperty|set-itemproperty)\b.*hk(lm|cu)/i,
  /\b(shutdown|restart-computer|stop-computer)\b/i,
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-\w*f)/i,
  /\b(curl|iwr|invoke-webrequest|wget)\b.*\|\s*(sh|bash|iex|invoke-expression)/i,
  /\bset-executionpolicy\b/i,
  /\b(net\s+user|new-localuser|add-localgroupmember)\b/i,
  /\bmkfs|dd\s+if=/i,
]

/** `mcp__server__tool` -> `server.tool`; built-ins stay as they are. */
export function canonical(toolName) {
  if (!toolName?.startsWith('mcp__')) return toolName
  const [, server, ...rest] = toolName.split('__')
  return `${server}.${rest.join('__')}`
}

export function riskOf(toolName, input = {}) {
  const name = canonical(toolName)
  let risk = RISK[name] ?? BUILTIN[name]
  if (!risk) {
    const tool = name.includes('.') ? name.split('.').slice(1).join('.') : name
    if (DANGER_VERB.test(tool)) risk = 'danger'
    else if (READ_VERB.test(tool)) risk = 'read'
    else risk = 'act'
  }
  if (risk !== 'danger' && ['Bash', 'PowerShell', 'shell'].includes(name)) {
    const cmd = String(input.command ?? '')
    if (DANGER_SHELL.some((re) => re.test(cmd))) risk = 'danger'
  }
  return risk
}

const matches = (pattern, name) =>
  pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name

/**
 * @param ctx.config      the loaded config
 * @param ctx.trustTurn   the user said "allow everything for this task"
 * @returns {{ decision: 'allow' | 'ask', risk: string }}
 */
export function decide(toolName, input, ctx) {
  const risk = riskOf(toolName, input)
  const name = canonical(toolName)
  if (risk === 'read') return { decision: 'allow', risk }
  if (risk === 'danger') return { decision: 'ask', risk }
  if (ctx.config.alwaysAllow?.some((p) => matches(p, name))) return { decision: 'allow', risk }
  if (ctx.trustTurn) return { decision: 'allow', risk }
  if (ctx.config.approvals === 'auto') return { decision: 'allow', risk }
  return { decision: 'ask', risk }
}

/** One readable line for an approval card or a spoken question. */
export function describe(toolName, input = {}) {
  const name = canonical(toolName)
  const i = input ?? {}
  switch (name) {
    case 'Bash':
    case 'PowerShell':
    case 'shell':
      return `Run command: ${i.command}`
    case 'Write':
    case 'write_file':
      return `Write file ${i.file_path ?? i.path}`
    case 'Edit':
    case 'MultiEdit':
      return `Edit file ${i.file_path}`
    case 'onyx_desktop.click':
      return `Click ${i.element != null ? `element [${i.element}]` : `at (${i.x}, ${i.y})`}${i.label ? ` "${i.label}"` : ''}`
    case 'onyx_desktop.type_text':
      return `Type "${String(i.text ?? '').slice(0, 80)}"${i.element != null ? ` into [${i.element}]` : ''}`
    case 'onyx_desktop.press_keys':
      return `Press ${i.keys}`
    case 'onyx_desktop.open_app':
      return `Open ${i.name}`
    case 'onyx_phone.tap':
      return `Tap on the phone ${i.element != null ? `[${i.element}]` : `at (${i.x}, ${i.y})`}`
    case 'onyx_phone.type_text':
      return `Type on the phone "${String(i.text ?? '').slice(0, 80)}"`
    case 'onyx_phone.send_sms':
      return `Send SMS to ${i.number}: "${i.message}"`
    case 'onyx_phone.dial':
      return `Call ${i.number}`
    case 'onyx_office.expense_add':
      return `Add ${i.transactions?.length ?? 0} transactions to the expense sheet`
    case 'onyx.schedule_task':
      return `Schedule "${i.name}" (${i.cron ?? i.at ?? i.trigger})`
    default: {
      const args = JSON.stringify(i)
      return `${name} ${args.length > 160 ? args.slice(0, 160) + '…' : args}`
    }
  }
}
